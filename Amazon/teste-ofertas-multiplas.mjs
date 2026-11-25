
import { load } from "cheerio";
import assert from "node:assert/strict";

const ASIN = "B0HC8JZC1D";
const DOMINIO = "https://www.amazon.com.br";

// ========================================
// FUNÇÕES AUXILIARES
// ========================================

function limpar(texto = "") {
    return String(texto).replace(/\s+/g, " ").trim();
}

function copiar(objeto) {
    return structuredClone(objeto);
}

function centavosBR(texto) {
    const match = String(texto ?? "").match(
        /R\$\s*([\d.]+),(\d{2})/
    );

    if (!match) return null;

    return Number(match[1].replace(/\./g, "")) * 100
        + Number(match[2]);
}

function centavosDecimal(texto) {
    const valor = String(texto ?? "");

    if (!/^\d+(?:\.\d{1,2})?$/.test(valor)) {
        return null;
    }

    const [reais, centavos = ""] = valor.split(".");

    return Number(reais) * 100 +
        Number(centavos.padEnd(2, "0"));
}

function moeda(centavos) {
    if (centavos === null) return "Desconhecido";

    return (centavos / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL"
    });
}

// ========================================
// EXTRAÇÃO DAS OFERTAS
// ========================================

function extrairPrecoExibido(bloco) {
    const area = bloco.find(
        '[id="aod-offer-price"]'
    ).first();

    const atributo = area.find(
        "[data-csa-c-price-to-pay]"
    ).first().attr("data-csa-c-price-to-pay");

    const numero = centavosDecimal(atributo);

    if (numero !== null) return numero;

    const visual = area.find(
        ".apex-pricetopay-value"
    ).first();

    const reais = visual.find(
        ".a-price-whole"
    ).first().text().replace(/\D/g, "");

    const centavos = visual.find(
        ".a-price-fraction"
    ).first().text().replace(/\D/g, "");

    if (reais && /^\d{2}$/.test(centavos)) {
        return Number(reais) * 100 + Number(centavos);
    }

    return centavosBR(
        area.find(
            ".apex-pricetopay-accessibility-label"
        ).first().text()
    );
}

function extrairFrete(bloco) {
    const entrega = bloco.find(
        "[data-csa-c-delivery-price]"
    ).first().attr("data-csa-c-delivery-price");

    if (entrega) {
        if (/gr[aá]tis/i.test(entrega)) return 0;

        const preco = centavosBR(entrega);

        if (preco !== null) return preco;
    }

    const shipping = bloco.find(
        "[data-csa-c-shipping-charge]"
    ).first().attr("data-csa-c-shipping-charge");

    return centavosDecimal(shipping);
}

function extrairOfertas(html) {
    const $ = load(html);

    const blocos = $('[id="aod-offer"]').toArray();
    const destaque = $("#aod-pinned-offer");

    if (destaque.find(
        'input[name="items[0.base][offerListingId]"]'
    ).length) {
        blocos.unshift(destaque[0]);
    }

    const ofertas = [];

    for (const elemento of blocos) {
        const bloco = $(elemento);

        const offerId = bloco.find(
            'input[name="items[0.base][offerListingId]"]'
        ).first().attr("value");

        if (!offerId) continue;

        const vendidoPor = bloco.find(
            '[id="aod-offer-soldBy"]'
        ).first();

        const link = vendidoPor.find(
            'a[href*="seller="]'
        ).first();

        const vendedor = limpar(link.text()) ||
            limpar(
                vendidoPor.find(
                    ".a-col-right > span"
                ).first().text()
            ) || "Desconhecido";

        const sellerId = link.attr("href")
            ? new URL(
                link.attr("href"),
                DOMINIO
            ).searchParams.get("seller")
            : vendedor === "Amazon.com.br"
                ? "AMAZON_DIRECT"
                : null;

        const enviadoPor = limpar(
            bloco.find(
                '[id="aod-offer-shipsFrom"] .a-col-right'
            ).first().text()
        );

        const condicao = limpar(
            bloco.find(
                '[id="aod-offer-heading"]'
            ).first().text()
        );

        const botao = bloco.find(
            'input[name="submit.addToCart"]'
        ).first();

        const precoNormalCentavos = centavosBR(
            botao.attr("aria-label")
        );

        const precoExibidoCentavos =
            extrairPrecoExibido(bloco);

        const freteCentavos = extrairFrete(bloco);

        const acao = bloco.find(
            "[data-aod-atc-action]"
        ).first().attr("data-aod-atc-action");

        let maxQty = null;

        try {
            const dados = JSON.parse(acao || "{}");

            if (Number.isInteger(dados.maxQty)) {
                maxQty = dados.maxQty;
            }
        } catch {}

        const vendidoAmazon =
            /^amazon\.com\.br$/i.test(vendedor);

        const enviadoAmazon =
            /^amazon(?:\.com\.br)?$/i.test(enviadoPor);

        ofertas.push({
            asin: ASIN,
            offerId,
            sellerId,
            vendedor,
            condicao,
            enviadoPor,
            vendidoAmazon,
            enviadoAmazon,
            precoNormalCentavos,
            precoExibidoCentavos,
            freteCentavos,
            maxQty,
            destaque: elemento === destaque[0]
        });
    }

    const totalTexto = $("#aod-total-offer-count").val();

    return {
        ofertas,
        totalInformado: totalTexto === undefined
            ? null
            : Number(totalTexto)
    };
}

// ========================================
// COLETA HTTP COM PAGINAÇÃO
// ========================================

function montarURL(pagina) {
    if (pagina === 1) {
        const url = new URL(
            "/gp/product/ajax/aodAjaxMain/",
            DOMINIO
        );

        url.searchParams.set("asin", ASIN);
        return url;
    }

    const url = new URL(
        `/gp/product/ajax/aodAjaxMain/ref=aod_page_${pagina}`,
        DOMINIO
    );

    const parametros = {
        asin: ASIN,
        m: "",
        qid: "",
        smid: "",
        sourcecustomerorglistid: "",
        sourcecustomerorglistitemid: "",
        sr: "",
        pc: "dp",
        isonlyrenderofferlist: "true",
        pageno: String(pagina)
    };

    for (const [chave, valor] of Object.entries(parametros)) {
        url.searchParams.set(chave, valor);
    }

    return url;
}

async function requisitar(url, pagina) {
    const inicio = Date.now();

    const resposta = await fetch(url, {
        headers: {
            "Accept": "text/html, */*",
            "Accept-Language": "pt-BR,pt;q=0.9"
        },
        signal: AbortSignal.timeout(15000)
    });

    console.log(
        `Página ${pagina}: HTTP ${resposta.status} - ` +
        `${Date.now() - inicio} ms`
    );

    if (!resposta.ok) {
        throw new Error(`HTTP ${resposta.status}`);
    }

    return resposta.text();
}

async function coletar() {
    const html = await requisitar(montarURL(1), 1);
    const primeira = extrairOfertas(html);

    const ofertas = [...primeira.ofertas];
    const total = primeira.totalInformado;

    if (!Number.isInteger(total) || total < 0) {
        throw new Error("Total de ofertas desconhecido.");
    }

    // Limite de páginas para este experimento.
    for (let pagina = 2; pagina <= 5; pagina++) {
        const ids = new Set(
            ofertas.map(o => o.offerId)
        );

        if (ids.size >= total) break;

        const htmlExtra = await requisitar(
            montarURL(pagina),
            pagina
        );

        const extra = extrairOfertas(htmlExtra);

        const anteriores = ids.size;

        ofertas.push(...extra.ofertas);

        const atuais = new Set(
            ofertas.map(o => o.offerId)
        ).size;

        if (atuais === anteriores) {
            console.log(
                "Paginação sem novas ofertas. Interrompendo."
            );
            break;
        }
    }

    return {
        asin: ASIN,
        totalInformado: total,
        ofertas
    };
}

// ========================================
// IDENTIDADE E VALIDAÇÃO
// ========================================

// Agrupa ofertas do mesmo vendedor e condição.
// NÃO exige que haja uma única oferta por grupo.
function chaveGrupo(oferta) {
    return JSON.stringify([
        oferta.asin,
        oferta.sellerId,
        oferta.condicao
    ]);
}

// Assinatura conservadora para reconhecer
// uma oferta quando o offerListingId muda.
function assinatura(oferta) {
    return JSON.stringify([
        oferta.enviadoPor,
        oferta.precoNormalCentavos,
        oferta.precoExibidoCentavos,
        oferta.freteCentavos,
        oferta.maxQty
    ]);
}

function preparar(snapshot) {
    if (
        !snapshot ||
        !Number.isInteger(snapshot.totalInformado) ||
        !Array.isArray(snapshot.ofertas)
    ) {
        return {
            ok: false,
            erro: "Estrutura inválida"
        };
    }

    const porId = new Map();

    for (const oferta of snapshot.ofertas) {
        if (
            !oferta.offerId ||
            !oferta.sellerId ||
            oferta.asin !== snapshot.asin ||
            !Number.isInteger(
                oferta.precoNormalCentavos
            )
        ) {
            return {
                ok: false,
                erro: `Oferta inválida: ${oferta.vendedor}`
            };
        }

        const anterior = porId.get(oferta.offerId);

        if (anterior) {
            // Mesmo offerId pode aparecer no destaque
            // e na lista. Aceitamos apenas se
            // as informações relevantes coincidirem.
            if (
                chaveGrupo(anterior) !== chaveGrupo(oferta) ||
                assinatura(anterior) !== assinatura(oferta)
            ) {
                return {
                    ok: false,
                    erro: "OfferId duplicado com dados divergentes"
                };
            }
        } else {
            porId.set(oferta.offerId, oferta);
        }
    }

    if (porId.size !== snapshot.totalInformado) {
        return {
            ok: false,
            erro:
                `Cobertura incompleta: ${porId.size}/` +
                snapshot.totalInformado
        };
    }

    const grupos = new Map();

    for (const oferta of porId.values()) {
        const chave = chaveGrupo(oferta);

        if (!grupos.has(chave)) {
            grupos.set(chave, []);
        }

        grupos.get(chave).push(oferta);
    }

    return {
        ok: true,
        porId,
        grupos,
        ofertas: [...porId.values()]
    };
}

// ========================================
// COMPARAÇÃO ENTRE SNAPSHOTS
// ========================================

function comparar(anterior, atual) {
    const antes = preparar(anterior);
    const depois = preparar(atual);

    if (!antes.ok || !depois.ok) {
        return {
            estado: "INCOMPLETO",
            eventos: [],
            pendencias: [
                antes.erro || depois.erro
            ]
        };
    }

    const eventos = [];
    const pendencias = [];

    // Um identificador que mudou de vendedor
    // ou condição não pode ser associado com
    // segurança automaticamente.
    for (const [id, antiga] of antes.porId) {
        const nova = depois.porId.get(id);

        if (
            nova &&
            chaveGrupo(antiga) !== chaveGrupo(nova)
        ) {
            return {
                estado: "AMBIGUO",
                eventos: [],
                pendencias: [
                    "OfferId associado a grupos diferentes"
                ]
            };
        }
    }

    const chaves = new Set([
        ...antes.grupos.keys(),
        ...depois.grupos.keys()
    ]);

    for (const chave of chaves) {
        const antigas = antes.grupos.get(chave) || [];
        const novas = depois.grupos.get(chave) || [];

        const antigasRestantes = new Map(
            antigas.map(o => [o.offerId, o])
        );

        const novasRestantes = new Map(
            novas.map(o => [o.offerId, o])
        );

        const pares = [];

        function associar(antiga, nova) {
            pares.push({ antiga, nova });

            antigasRestantes.delete(antiga.offerId);
            novasRestantes.delete(nova.offerId);
        }

        // ETAPA A: o mesmo offerListingId permaneceu.
        for (const antiga of antigas) {
            const nova = novasRestantes.get(
                antiga.offerId
            );

            if (nova) {
                associar(antiga, nova);
            }
        }

        // ETAPA B: ID diferente, mas atributos
        // relevantes idênticos.
        for (const antiga of [
            ...antigasRestantes.values()
        ]) {
            const nova = [
                ...novasRestantes.values()
            ].find(
                candidata =>
                    assinatura(candidata) ===
                    assinatura(antiga)
            );

            if (nova) {
                associar(antiga, nova);
            }
        }

        // ETAPA C: vendedor com exatamente uma
        // oferta em cada snapshot.
        // Nesse caso, permitimos mudanças
        // simultâneas de ID e preço.
        if (
            antigas.length === 1 &&
            novas.length === 1 &&
            antigasRestantes.size === 1 &&
            novasRestantes.size === 1
        ) {
            associar(
                [...antigasRestantes.values()][0],
                [...novasRestantes.values()][0]
            );
        }

        // Comparamos apenas pares identificados.
        for (const { antiga, nova } of pares) {
            if (
                antiga.precoNormalCentavos !==
                nova.precoNormalCentavos
            ) {
                eventos.push({
                    tipo: "PRECO_ALTERADO",
                    vendedor: nova.vendedor,
                    offerId: nova.offerId,
                    antes: moeda(
                        antiga.precoNormalCentavos
                    ),
                    depois: moeda(
                        nova.precoNormalCentavos
                    )
                });
            }

            if (
                antiga.precoExibidoCentavos !==
                nova.precoExibidoCentavos
            ) {
                eventos.push({
                    tipo: "PRECO_PROMOCIONAL_ALTERADO",
                    vendedor: nova.vendedor
                });
            }

            if (
                antiga.freteCentavos !==
                nova.freteCentavos
            ) {
                eventos.push({
                    tipo: "FRETE_ALTERADO",
                    vendedor: nova.vendedor
                });
            }

            if (antiga.maxQty !== nova.maxQty) {
                eventos.push({
                    tipo: "LIMITE_ALTERADO",
                    vendedor: nova.vendedor,
                    antes: antiga.maxQty,
                    depois: nova.maxQty
                });
            }

            if (antiga.enviadoPor !== nova.enviadoPor) {
                eventos.push({
                    tipo: "ENVIO_ALTERADO",
                    vendedor: nova.vendedor
                });
            }
        }

        const faltantes = [
            ...antigasRestantes.values()
        ];

        const aparecidas = [
            ...novasRestantes.values()
        ];

        // Havendo ofertas não associadas dos dois
        // lados, pode ser troca de offerListingId.
        // Não produzimos falsos eventos.
        if (faltantes.length && aparecidas.length) {
            pendencias.push({
                grupo: chave,
                ofertasAntigas: faltantes.length,
                ofertasNovas: aparecidas.length,
                motivo: "Identidade incerta"
            });

            continue;
        }

        // Todas as novas foram associadas:
        // as antigas restantes desapareceram.
        for (const oferta of faltantes) {
            eventos.push({
                tipo: "OFERTA_DESAPARECEU",
                vendedor: oferta.vendedor,
                offerId: oferta.offerId
            });
        }

        // Todas as antigas foram associadas:
        // as novas restantes realmente são novas
        // nesse conjunto de dados.
        for (const oferta of aparecidas) {
            eventos.push({
                tipo: "NOVA_OFERTA",
                vendedor: oferta.vendedor,
                offerId: oferta.offerId
            });
        }
    }

    return {
        estado: pendencias.length
            ? "PARCIAL"
            : "COMPLETO",
        eventos,
        pendencias
    };
}

// ========================================
// TESTES AUTOMATIZADOS
// ========================================

function testar(
    nome,
    base,
    modificar,
    eventosEsperados,
    estadoEsperado = "COMPLETO"
) {
    const atual = copiar(base);

    modificar(atual);

    const resultado = comparar(base, atual);

    const tipos = resultado.eventos
        .map(e => e.tipo)
        .sort();

    assert.equal(
        resultado.estado,
        estadoEsperado,
        `Estado incorreto: ${nome}`
    );

    assert.deepEqual(
        tipos,
        [...eventosEsperados].sort(),
        `Eventos incorretos: ${nome}`
    );

    console.log(`OK - ${nome}`);

    if (resultado.eventos.length) {
        console.table(resultado.eventos);
    }

    if (resultado.pendencias.length) {
        console.log(
            "Pendências:",
            resultado.pendencias
        );
    }
}

// ========================================
// EXECUÇÃO PRINCIPAL
// ========================================

try {
    console.log("\n=== COLETA AMAZON ===\n");

    const original = await coletar();
    const validado = preparar(original);

    console.log("\n=== SNAPSHOT ===");
    console.log(
        "Ofertas recebidas:",
        original.ofertas.length
    );
    console.log(
        "Total informado:",
        original.totalInformado
    );

    if (!validado.ok) {
        throw new Error(validado.erro);
    }

    console.log(
        "Ofertas únicas:",
        validado.ofertas.length
    );

    console.table(
        [...validado.ofertas]
            .sort(
                (a, b) =>
                    a.precoNormalCentavos -
                    b.precoNormalCentavos
            )
            .map(o => ({
                vendedor: o.vendedor,
                precoNormal: moeda(
                    o.precoNormalCentavos
                ),
                maxQty: o.maxQty,
                enviadoPor: o.enviadoPor
            }))
    );

    console.log(
        "\n=== VENDEDORES COM MULTIPLAS OFERTAS ==="
    );

    const gruposDuplicados = [
        ...validado.grupos.values()
    ].filter(grupo => grupo.length > 1);

    if (gruposDuplicados.length) {
        console.table(
            gruposDuplicados.flatMap(grupo =>
                grupo.map(o => ({
                    vendedor: o.vendedor,
                    preco: moeda(
                        o.precoNormalCentavos
                    ),
                    maxQty: o.maxQty
                }))
            )
        );
    } else {
        console.log(
            "Nenhum vendedor com ofertas múltiplas " +
            "nesta coleta."
        );
    }

    // Criamos uma base de teste.
    // Se não houver vendedor com duas ofertas reais,
    // simulamos uma segunda oferta do mesmo vendedor.
    const base = copiar(original);
    let preparado = preparar(base);

    let grupoMultiplo = [
        ...preparado.grupos.values()
    ].find(grupo => grupo.length > 1);

    if (!grupoMultiplo) {
        const nova = copiar(base.ofertas[0]);

        nova.offerId = "OFERTA_SIMULADA_ADICIONAL";
        nova.precoNormalCentavos += 10000;

        if (nova.precoExibidoCentavos !== null) {
            nova.precoExibidoCentavos += 10000;
        }

        base.ofertas.push(nova);
        base.totalInformado += 1;

        preparado = preparar(base);

        grupoMultiplo = [
            ...preparado.grupos.values()
        ].find(grupo => grupo.length > 1);

        console.log(
            "\nSegunda oferta simulada para os testes."
        );
    }

    const referencia = grupoMultiplo[0];

    const ofertasUnicasPorVendedor = [
        ...preparado.grupos.values()
    ].filter(grupo => grupo.length === 1);

    const referenciaUnica =
        ofertasUnicasPorVendedor[0]?.[0];

    console.log("\n=== TESTES ===\n");

    testar(
        "Sem mudanças",
        base,
        s => {},
        []
    );

    testar(
        "Ordem alterada",
        base,
        s => s.ofertas.reverse(),
        []
    );

    testar(
        "Mudança para destaque",
        base,
        s => {
            s.ofertas[0].destaque = true;
        },
        []
    );

    testar(
        "Mesmo ID duplicado no HTML",
        base,
        s => {
            const repetida = copiar(s.ofertas[0]);
            repetida.destaque = true;
            s.ofertas.push(repetida);
        },
        []
    );

    testar(
        "ID mudou, oferta equivalente",
        base,
        s => {
            const oferta = s.ofertas.find(
                o => o.offerId === referencia.offerId
            );

            oferta.offerId = "NOVO_ID_EQUIVALENTE";
        },
        []
    );

    testar(
        "Preço mudou em vendedor com múltiplas ofertas",
        base,
        s => {
            const oferta = s.ofertas.find(
                o => o.offerId === referencia.offerId
            );

            oferta.precoNormalCentavos += 100;
        },
        ["PRECO_ALTERADO"]
    );

    testar(
        "maxQty mudou em oferta específica",
        base,
        s => {
            const oferta = s.ofertas.find(
                o => o.offerId === referencia.offerId
            );

            oferta.maxQty =
                (oferta.maxQty ?? 0) + 5;
        },
        ["LIMITE_ALTERADO"]
    );

    testar(
        "Nova oferta do mesmo vendedor",
        base,
        s => {
            const nova = copiar(referencia);

            nova.offerId = "OFERTA_NOVA_TESTE";
            nova.precoNormalCentavos += 15000;

            s.ofertas.push(nova);
            s.totalInformado += 1;
        },
        ["NOVA_OFERTA"]
    );

    testar(
        "Uma das ofertas do vendedor desapareceu",
        base,
        s => {
            s.ofertas = s.ofertas.filter(
                o => o.offerId !== referencia.offerId
            );

            s.totalInformado -= 1;
        },
        ["OFERTA_DESAPARECEU"]
    );

    testar(
        "ID e preço mudaram em grupo múltiplo",
        base,
        s => {
            const oferta = s.ofertas.find(
                o => o.offerId === referencia.offerId
            );

            oferta.offerId = "NOVO_ID_AMBIGUO";
            oferta.precoNormalCentavos += 100;
        },
        [],
        "PARCIAL"
    );

    if (referenciaUnica) {
        testar(
            "ID e preço mudaram em vendedor único",
            base,
            s => {
                const oferta = s.ofertas.find(
                    o => o.offerId ===
                        referenciaUnica.offerId
                );

                oferta.offerId =
                    "NOVO_ID_VENDEDOR_UNICO";

                oferta.precoNormalCentavos += 100;
            },
            ["PRECO_ALTERADO"]
        );
    }

    testar(
        "Snapshot incompleto",
        base,
        s => {
            s.ofertas.pop();
        },
        [],
        "INCOMPLETO"
    );

    testar(
        "OfferId duplicado com preço divergente",
        base,
        s => {
            const duplicada = copiar(s.ofertas[0]);

            duplicada.precoNormalCentavos += 100;

            s.ofertas.push(duplicada);
        },
        [],
        "INCOMPLETO"
    );

    console.log(
        "\nTODOS OS TESTES DE OFERTAS MULTIPLAS PASSARAM!"
    );

} catch (erro) {
    console.error("\nERRO:", erro.message);
    process.exitCode = 1;
}
