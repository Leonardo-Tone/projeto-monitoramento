import { createHash, randomUUID } from "node:crypto";
import { CATEGORIAS } from "./config.mjs";

function inteiro(valor) {
    return Number.isInteger(valor) && valor >= 0;
}

function resumoOferta(oferta, precoConsideradoCentavos = null) {
    if (!oferta) return null;
    return {
        sellerId: oferta.sellerId ?? null,
        vendedor: oferta.vendedor,
        enviadoPor: oferta.enviadoPor,
        categoria: oferta.categoria,
        precoNormalCentavos: oferta.precoNormalCentavos ?? null,
        precoExibidoCentavos: oferta.precoExibidoCentavos ?? null,
        freteCentavos: oferta.freteCentavos ?? null,
        minQty: oferta.minQty ?? null,
        maxQty: oferta.maxQty ?? null,
        precoConsideradoCentavos
    };
}

function melhorOferta(ofertas, campo) {
    const comPreco = ofertas.filter(o => inteiro(o[campo]));
    comPreco.sort((a, b) => a[campo] - b[campo] ||
        String(a.sellerId).localeCompare(String(b.sellerId)));
    return comPreco[0] ?? null;
}

// Para o MVP, a comparação é baseada em menor preço visível por categoria,
// nunca em offerHash: o identificador da oferta muda entre consultas AOD.
export function construirSnapshot(dados, produto, horario = new Date().toISOString()) {
    const ofertas = dados.ofertas ?? [];
    const contagem = {
        AMAZON_DIRETA: 0,
        TERCEIRO_ENVIO_AMAZON: 0,
        TERCEIRO_ENVIO_PROPRIO: 0,
        DESCONHECIDA: 0,
        REVISAR_MODALIDADE: 0
    };
    for (const oferta of ofertas) {
        if (contagem[oferta.categoria] == null) {
            throw new Error(`Categoria não reconhecida: ${oferta.categoria}`);
        }
        contagem[oferta.categoria]++;
    }

    const melhoresVisiveis = {};
    for (const categoria of CATEGORIAS) {
        const candidatos = ofertas.filter(o => o.categoria === categoria);
        const melhor = melhorOferta(candidatos, "precoNormalCentavos");
        melhoresVisiveis[categoria] = resumoOferta(melhor);
    }

    // Condição de alvo: preço normal ou exibido, nunca mistura implícita.
    // Se frete for exigido e desconhecido, a oferta não é elegível.
    const target = produto.target ?? {};
    const basis = target.priceBasis ?? "NORMAL";
    const campoPreco = basis === "DISPLAYED" ? "precoExibidoCentavos" : "precoNormalCentavos";
    const incluirFrete = target.includeShipping === true;
    const quantidade = target.minQuantity ?? 1;
    const habilitado = inteiro(target.maxPriceCents);

    const elegiveis = ofertas
        .filter(o => produto.categories.includes(o.categoria))
        .filter(o => inteiro(o[campoPreco]))
        .filter(o => o.minQty == null || o.minQty <= quantidade)
        .filter(o => o.maxQty == null || o.maxQty >= quantidade)
        .filter(o => !incluirFrete || inteiro(o.freteCentavos))
        .map(o => ({
            oferta: o,
            preco: o[campoPreco] + (incluirFrete ? o.freteCentavos : 0)
        }));
    elegiveis.sort((a, b) => a.preco - b.preco);
    const vencedor = elegiveis[0] ?? null;
    const alvoAtingido = Boolean(
        habilitado && vencedor && vencedor.preco <= target.maxPriceCents
    );

    return {
        version: 1,
        asin: produto.asin,
        nome: produto.name,
        horario,
        cobertura: dados.cobertura ??
            (dados.totalInformado > 10 ? "PRIMEIRA_PAGINA_PARCIAL" : "PRIMEIRA_PAGINA_COMPLETA"),
        totalInformado: dados.totalInformado,
        totalLista: dados.totalLista,
        totalVisivel: dados.totalVisivel ?? ofertas.length,
        destaquePresente: dados.destaquePresente ?? Boolean(dados.possuiDestaque),
        destaqueExclusivo: Boolean(dados.destaqueExclusivo),
        ofertasNaoConsultadasEstimadas: dados.ofertasNaoConsultadasEstimadas ??
            Math.max(0, dados.totalInformado - dados.totalLista),
        contagem,
        melhoresVisiveis,
        amazonDiretaVisivel: contagem.AMAZON_DIRETA > 0,
        amazonDireta: melhoresVisiveis.AMAZON_DIRETA,
        alvo: {
            configurado: habilitado,
            atingido: alvoAtingido,
            limiteCentavos: target.maxPriceCents ?? null,
            base: basis,
            incluiFrete: incluirFrete,
            quantidade,
            melhorOferta: resumoOferta(vencedor?.oferta, vencedor?.preco ?? null)
        },
        // Última fotografia observada, útil para UI; offerHash é informativo,
        // não é identidade estável de produto ou vendedor.
        ofertas: ofertas.map(o => ({
            offerHash: o.offerHash ?? null,
            sellerId: o.sellerId ?? null,
            vendedor: o.vendedor,
            enviadoPor: o.enviadoPor,
            categoria: o.categoria,
            precoNormalCentavos: o.precoNormalCentavos ?? null,
            precoExibidoCentavos: o.precoExibidoCentavos ?? null,
            freteCentavos: o.freteCentavos ?? null,
            minQty: o.minQty ?? null,
            maxQty: o.maxQty ?? null,
            ...(o.vendedorDiagnostico ? { vendedorDiagnostico: o.vendedorDiagnostico } : {})
        }))
    };
}

export function gerarMudancas(anterior, atual) {
    const mudancas = [];
    const emitir = (tipo, detalhes, prioridade = "INFO") => {
        mudancas.push({ tipo, prioridade, detalhes });
    };

    // Em monitoramento real, uma meta já atingida na primeira coleta deve
    // produzir sinal, mas não uma falsa "oferta nova da Amazon".
    if (!anterior) {
        if (atual.alvo.atingido) {
            emitir("ALVO_ATINGIDO", { anterior: null, atual: atual.alvo }, "ATENCAO");
        }
        if (atual.contagem.DESCONHECIDA > 0) {
            emitir("VENDEDOR_DESCONHECIDO_VISIVEL", {
                quantidade: atual.contagem.DESCONHECIDA
            }, "REVISAO");
        }
        return mudancas;
    }

    if (anterior.totalInformado !== atual.totalInformado) {
        emitir("TOTAL_OFERTAS_AOD_ALTERADO", {
            anterior: anterior.totalInformado,
            atual: atual.totalInformado,
            observacao: "Contador do AOD; não comprova venda, estoque ou disponibilidade."
        });
    }

    if (!anterior.amazonDiretaVisivel && atual.amazonDiretaVisivel) {
        emitir("AMAZON_DIRETA_AGORA_VISIVEL", {
            oferta: atual.amazonDireta
        }, "ATENCAO");
    } else if (anterior.amazonDiretaVisivel && !atual.amazonDiretaVisivel) {
        emitir("AMAZON_DIRETA_NAO_OBSERVADA", {
            observacao: "Ausente somente na primeira página; NÃO implica indisponibilidade."
        }, "REVISAO");
    }

    if (anterior.amazonDiretaVisivel && atual.amazonDiretaVisivel) {
        const antes = anterior.amazonDireta?.precoNormalCentavos;
        const depois = atual.amazonDireta?.precoNormalCentavos;
        if (inteiro(antes) && inteiro(depois) && antes !== depois) {
            emitir("PRECO_AMAZON_DIRETA_ALTERADO", {
                anteriorCentavos: antes,
                atualCentavos: depois,
                oferta: atual.amazonDireta
            }, "ATENCAO");
        }
    }

    for (const categoria of CATEGORIAS) {
        const antes = anterior.melhoresVisiveis?.[categoria]?.precoNormalCentavos;
        const depois = atual.melhoresVisiveis?.[categoria]?.precoNormalCentavos;
        if (inteiro(antes) && inteiro(depois) && antes !== depois &&
            // Para evitar duplicação, a Amazon direta tem evento específico.
            categoria !== "AMAZON_DIRETA") {
            emitir("MENOR_PRECO_VISIVEL_ALTERADO", {
                categoria,
                anteriorCentavos: antes,
                atualCentavos: depois,
                observacao: "Comparação limitada à primeira página."
            });
        }
    }

    if (!anterior.alvo?.atingido && atual.alvo.atingido) {
        emitir("ALVO_ATINGIDO", {
            anterior: anterior.alvo ?? null,
            atual: atual.alvo
        }, "ATENCAO");
    } else if (anterior.alvo?.atingido && !atual.alvo.atingido) {
        emitir("ALVO_NAO_OBSERVADO", {
            observacao: "Meta deixou de aparecer na primeira página; NÃO é prova de estoque esgotado."
        });
    }

    if ((anterior.contagem?.DESCONHECIDA ?? 0) === 0 &&
        atual.contagem.DESCONHECIDA > 0) {
        emitir("VENDEDOR_DESCONHECIDO_VISIVEL", {
            quantidade: atual.contagem.DESCONHECIDA
        }, "REVISAO");
    }

    return mudancas;
}

function formaCanonica(valor) {
    if (Array.isArray(valor)) return valor.map(formaCanonica);
    if (valor && typeof valor === "object") {
        return Object.fromEntries(Object.keys(valor).sort()
            .map(chave => [chave, formaCanonica(valor[chave])]));
    }
    return valor;
}

// id distingue ocorrências reais, mesmo em execuções cujos ciclos começam em 1.
// dedupKey agrupa semanticamente a transição; não bloqueia uma recorrência legítima.
export function criarEvento(snapshot, mudanca, ciclo, horario = new Date().toISOString(), runId = null) {
    const baseSemantica = {
        asin: snapshot.asin,
        tipo: mudanca.tipo,
        detalhes: formaCanonica(mudanca.detalhes)
    };
    const dedupKey = createHash("sha256")
        .update(JSON.stringify(baseSemantica))
        .digest("hex").slice(0, 32);
    return {
        schemaVersion: 1,
        id: randomUUID(),
        dedupKey,
        tipo: mudanca.tipo,
        prioridade: mudanca.prioridade,
        horario,
        origem: "AMAZON_AOD_PRIMEIRA_PAGINA",
        asin: snapshot.asin,
        nome: snapshot.nome,
        ciclo,
        ...(runId ? { runId } : {}),
        cobertura: snapshot.cobertura,
        detalhes: mudanca.detalhes,
        executavel: false // Compra não existe neste núcleo.
    };
}

export function resumoObservacao(snapshot, ciclo, transporte = {}) {
    return {
        schemaVersion: 1,
        tipo: "OBSERVACAO",
        horario: snapshot.horario,
        ciclo,
        asin: snapshot.asin,
        cobertura: snapshot.cobertura,
        totalInformado: snapshot.totalInformado,
        totalVisivel: snapshot.totalVisivel,
        amazonDiretaVisivel: snapshot.amazonDiretaVisivel,
        precoAmazonDiretaCentavos: snapshot.amazonDireta?.precoNormalCentavos ?? null,
        vendedoresDesconhecidos: snapshot.contagem.DESCONHECIDA,
        alvoAtingido: snapshot.alvo.atingido,
        melhoresVisiveis: snapshot.melhoresVisiveis,
        http: transporte.httpStatus ?? null,
        duracaoMs: transporte.duracaoMs ?? null,
        bytes: transporte.bytesRecebidos ?? null
    };
}
