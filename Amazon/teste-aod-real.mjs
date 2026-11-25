
import { load } from "cheerio";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { performance } from "node:perf_hooks";

// ========================================
// CONFIGURAÇÃO
// ========================================

const DOMINIO = "https://www.amazon.com.br";

const TODAS = [
    "AMAZON_DIRETA",
    "TERCEIRO_ENVIO_AMAZON",
    "TERCEIRO_ENVIO_PROPRIO"
];

const PRODUTOS = [
    {
        asin: "B000GAYQJ0",
        nome: "Casio A158WA",
        categorias: [...TODAS]
    },
    {
        asin: "B0HC8JZC1D",
        nome: "Pokemon Advanced Trainer Box",
        categorias: [...TODAS]
    },
    {
        asin: "B0HCCTKPGN",
        nome: "Pokemon Binder Collection",
        categorias: [...TODAS]
    }
];

const INTERVALO_S = Number(process.argv[2] ?? 30);
const DURACAO_S = Number(process.argv[3] ?? 60);

const MAX_PAGINAS = 5;
const TIMEOUT_MS = 12000;

if (
    ![10, 20, 30].includes(INTERVALO_S) ||
    !Number.isInteger(DURACAO_S) ||
    DURACAO_S < INTERVALO_S ||
    DURACAO_S > 300 ||
    DURACAO_S % INTERVALO_S !== 0
) {
    console.error(
        "Uso: node teste-aod-real.mjs INTERVALO DURACAO"
    );
    console.error(
        "Intervalos permitidos: 30, 20 ou 10 segundos."
    );
    process.exit(1);
}

const CICLOS = DURACAO_S / INTERVALO_S;

const arquivo = (
    "aod-real-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    ".jsonl"
);

const saida = createWriteStream(arquivo, {
    flags: "a"
});

const metricas = {
    requisicoes: 0,
    respostas: {},
    latencias: [],
    snapshotsValidos: 0,
    falhas: 0,
    ciclos: [],
    ciclosPulados: 0
};

let interromper = false;

// ========================================
// UTILITÁRIOS
// ========================================

class PararTeste extends Error {}

function gravar(registro) {
    saida.write(JSON.stringify({
        horario: new Date().toISOString(),
        ...registro
    }) + "\n");
}

function limpar(valor = "") {
    return String(valor).replace(/\s+/g, " ").trim();
}

function dormir(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function identificadorCurto(id) {
    return createHash("sha256")
        .update(id)
        .digest("hex")
        .slice(0, 16);
}

function reaisParaCentavos(texto) {
    const match = String(texto ?? "").match(
        /R\$\s*([\d.]+),(\d{2})/
    );

    if (!match) return null;

    return Number(match[1].replace(/\./g, "")) * 100
        + Number(match[2]);
}

function decimalParaCentavos(texto) {
    const valor = String(texto ?? "");

    if (!/^\d+(?:\.\d{1,2})?$/.test(valor)) {
        return null;
    }

    const [reais, centavos = ""] = valor.split(".");

    return Number(reais) * 100 +
        Number(centavos.padEnd(2, "0"));
}

function moeda(centavos) {
    if (centavos === null) return "Não informado";

    return (centavos / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL"
    });
}

function percentil(valores, percentual) {
    if (!valores.length) return null;

    const ordenados = [...valores].sort((a, b) => a - b);
    const indice = Math.ceil(
        ordenados.length * percentual
    ) - 1;

    return Math.round(ordenados[Math.max(0, indice)]);
}

// ========================================
// CLASSIFICAÇÃO DOS VENDEDORES
// ========================================

function classificar(vendedor, enviadoPor) {
    const nome = limpar(vendedor);
    const envio = limpar(enviadoPor);

    if (
        !nome ||
        nome === "Desconhecido" ||
        !envio
    ) {
        return "DESCONHECIDA";
    }

    const vendidoAmazon =
        /^amazon\.com\.br$/i.test(nome);

    const enviadoAmazon =
        /^amazon(?:\.com\.br)?$/i.test(envio);

    if (vendidoAmazon && enviadoAmazon) {
        return "AMAZON_DIRETA";
    }

    if (vendidoAmazon) {
        return "REVISAR_MODALIDADE";
    }

    if (enviadoAmazon) {
        return "TERCEIRO_ENVIO_AMAZON";
    }

    return "TERCEIRO_ENVIO_PROPRIO";
}

// ========================================
// EXTRAÇÃO DO AOD
// ========================================

function extrairOfertas(html) {
    const $ = load(html);

    const elementos = $('[id="aod-offer"]').toArray();

    const destaque = $("#aod-pinned-offer").first();

    if (
        destaque.length &&
        destaque.find(
            'input[name="items[0.base][offerListingId]"]'
        ).length
    ) {
        elementos.unshift(destaque[0]);
    }

    const ofertas = [];

    for (const elemento of elementos) {
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

        let sellerId = null;

        if (link.attr("href")) {
            try {
                sellerId = new URL(
                    link.attr("href"),
                    DOMINIO
                ).searchParams.get("seller");
            } catch {}
        }

        const enviadoPor = limpar(
            bloco.find(
                '[id="aod-offer-shipsFrom"] .a-col-right'
            ).first().text()
        );

        const categoria = classificar(
            vendedor,
            enviadoPor
        );

        const botao = bloco.find(
            'input[name="submit.addToCart"]'
        ).first();

        const precoNormalCentavos = reaisParaCentavos(
            botao.attr("aria-label")
        );

        const areaPreco = bloco.find(
            '[id="aod-offer-price"]'
        ).first();

        const precoExibidoTexto = areaPreco.find(
            ".apex-pricetopay-accessibility-label"
        ).first().text();

        let precoExibidoCentavos =
            reaisParaCentavos(precoExibidoTexto);

        if (precoExibidoCentavos === null) {
            precoExibidoCentavos = decimalParaCentavos(
                areaPreco.find(
                    "[data-csa-c-price-to-pay]"
                ).first().attr("data-csa-c-price-to-pay")
            );
        }

        if (precoExibidoCentavos === null) {
            const visual = areaPreco.find(
                ".apex-pricetopay-value"
            ).first();

            const reais = visual.find(
                ".a-price-whole"
            ).first().text().replace(/\D/g, "");

            const centavos = visual.find(
                ".a-price-fraction"
            ).first().text().replace(/\D/g, "");

            if (
                reais &&
                /^\d{2}$/.test(centavos)
            ) {
                precoExibidoCentavos =
                    Number(reais) * 100 +
                    Number(centavos);
            }
        }

        const textoFrete = bloco.find(
            "[data-csa-c-delivery-price]"
        ).first().attr("data-csa-c-delivery-price");

        let freteCentavos = null;

        if (/gr[aá]tis/i.test(textoFrete ?? "")) {
            freteCentavos = 0;
        } else {
            freteCentavos = reaisParaCentavos(
                textoFrete
            );
        }

        if (freteCentavos === null) {
            freteCentavos = decimalParaCentavos(
                bloco.find(
                    "[data-csa-c-shipping-charge]"
                ).first().attr("data-csa-c-shipping-charge")
            );
        }

        let minQty = null;
        let maxQty = null;

        try {
            const acao = JSON.parse(
                bloco.find(
                    "[data-aod-atc-action]"
                ).first().attr("data-aod-atc-action") || "{}"
            );

            if (Number.isInteger(acao.minQty)) {
                minQty = acao.minQty;
            }

            if (Number.isInteger(acao.maxQty)) {
                maxQty = acao.maxQty;
            }
        } catch {}

        ofertas.push({
            offerId,
            offerHash: identificadorCurto(offerId),
            sellerId,
            vendedor,
            enviadoPor,
            categoria,
            precoNormalCentavos,
            precoExibidoCentavos,
            freteCentavos,
            minQty,
            maxQty
        });
    }

    const elementoTotal = $(
        "#aod-total-offer-count"
    ).first();

    const totalTexto = String(
        elementoTotal.attr("value") ??
        elementoTotal.val() ??
        elementoTotal.text() ??
        ""
    ).trim();

    const totalInformado = /^\d+$/.test(totalTexto)
        ? Number(totalTexto)
        : null;

    return {
        ofertas,
        totalInformado
    };
}

// ========================================
// URLs DAS PÁGINAS
// ========================================

function montarURL(asin, pagina) {
    if (pagina === 1) {
        const url = new URL(
            "/gp/product/ajax/aodAjaxMain/",
            DOMINIO
        );

        url.searchParams.set("asin", asin);

        return url;
    }

    const url = new URL(
        `/gp/product/ajax/aodAjaxMain/ref=aod_page_${pagina}`,
        DOMINIO
    );

    const parametros = {
        asin,
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

// ========================================
// REQUISIÇÃO REAL
// ========================================

async function requisitar(asin, pagina, ciclo) {
    if (interromper) {
        throw new PararTeste("Teste interrompido.");
    }

    const inicio = performance.now();

    let resposta;
    let html;

    try {
        resposta = await fetch(
            montarURL(asin, pagina),
            {
                headers: {
                    "Accept": "text/html, */*",
                    "Accept-Language": "pt-BR,pt;q=0.9"
                },
                signal: AbortSignal.timeout(TIMEOUT_MS)
            }
        );

        html = await resposta.text();

    } catch (erro) {
        interromper = true;

        throw new PararTeste(
            `Falha de rede em ${asin}: ${erro.message}`
        );
    }

    const duracaoMs = Math.round(
        performance.now() - inicio
    );

    metricas.requisicoes++;

    const status = resposta.status;

    metricas.respostas[status] =
        (metricas.respostas[status] || 0) + 1;

    metricas.latencias.push(duracaoMs);

    gravar({
        tipo: "REQUISICAO",
        ciclo,
        asin,
        pagina,
        httpStatus: status,
        duracaoMs,
        bytes: Buffer.byteLength(html)
    });

    if (status !== 200) {
        interromper = true;

        throw new PararTeste(
            `${asin}, página ${pagina}: HTTP ${status}`
        );
    }

    // Detectar páginas de verificação
    // em vez do HTML de ofertas.
    const desafio = (
        /<title[^>]*>\s*robot check/i.test(html) ||
        /\/errors\/validateCaptcha/i.test(html) ||
        /id=["']captchacharacters["']/i.test(html)
    );

    if (desafio) {
        interromper = true;

        throw new PararTeste(
            `Desafio de acesso identificado: ${asin}`
        );
    }

    return extrairOfertas(html);
}

// ========================================
// COLETA COMPLETA DE UM PRODUTO
// ========================================

async function coletarProduto(produto, ciclo) {
    const inicio = performance.now();

    const ofertas = new Map();

    let totalInformado = null;
    let paginasConsultadas = 0;

    for (
        let pagina = 1;
        pagina <= MAX_PAGINAS;
        pagina++
    ) {
        if (interromper) {
            throw new PararTeste("Teste interrompido.");
        }

        const resultado = await requisitar(
            produto.asin,
            pagina,
            ciclo
        );

        paginasConsultadas++;

        if (pagina === 1) {
            totalInformado = resultado.totalInformado;

            if (
                !Number.isInteger(totalInformado) ||
                totalInformado < 0
            ) {
                interromper = true;

                throw new PararTeste(
                    `AOD sem total válido: ${produto.asin}`
                );
            }
        }

        const antes = ofertas.size;

        for (const oferta of resultado.ofertas) {
            const existente = ofertas.get(
                oferta.offerId
            );

            if (existente) {
                const conflito = (
                    existente.vendedor !== oferta.vendedor ||
                    existente.enviadoPor !== oferta.enviadoPor ||
                    existente.precoNormalCentavos !==
                        oferta.precoNormalCentavos
                );

                if (conflito) {
                    interromper = true;

                    throw new PararTeste(
                        `Oferta duplicada divergente: ${produto.asin}`
                    );
                }
            } else {
                ofertas.set(
                    oferta.offerId,
                    oferta
                );
            }
        }

        if (ofertas.size >= totalInformado) {
            break;
        }

        if (
            pagina > 1 &&
            ofertas.size === antes
        ) {
            interromper = true;

            throw new PararTeste(
                `Paginação sem progresso: ${produto.asin}`
            );
        }
    }

    if (
        ofertas.size !== totalInformado ||
        (totalInformado === 0 && paginasConsultadas === 1)
    ) {
        interromper = true;

        throw new PararTeste(
            `Cobertura não confirmada em ${produto.asin}: ` +
            `${ofertas.size}/${totalInformado}`
        );
    }

    const todas = [...ofertas.values()];

    const selecionadas = todas.filter(
        oferta => produto.categorias.includes(
            oferta.categoria
        )
    );

    const contagem = {
        AMAZON_DIRETA: 0,
        TERCEIRO_ENVIO_AMAZON: 0,
        TERCEIRO_ENVIO_PROPRIO: 0,
        DESCONHECIDA: 0,
        REVISAR_MODALIDADE: 0
    };

    for (const oferta of todas) {
        contagem[oferta.categoria]++;
    }

    const precos = selecionadas
        .filter(o => o.precoNormalCentavos !== null)
        .sort(
            (a, b) =>
                a.precoNormalCentavos -
                b.precoNormalCentavos
        );

    const maisBarata = precos[0] || null;

    const duracaoMs = Math.round(
        performance.now() - inicio
    );

    metricas.snapshotsValidos++;

    // Não armazenar o offerListingId completo.
    const ofertasParaLog = todas.map(
        ({ offerId, ...dados }) => dados
    );

    gravar({
        tipo: "SNAPSHOT",
        ciclo,
        asin: produto.asin,
        nome: produto.nome,
        duracaoMs,
        paginasConsultadas,
        totalInformado,
        categoriasSelecionadas: produto.categorias,
        contagem,
        ofertasSelecionadas: selecionadas.length,
        ofertas: ofertasParaLog
    });

    return {
        produto,
        paginasConsultadas,
        totalInformado,
        selecionadas: selecionadas.length,
        contagem,
        maisBarata,
        duracaoMs
    };
}

// ========================================
// EXECUÇÃO DOS CICLOS
// ========================================

async function executar() {
    const intervaloMs = INTERVALO_S * 1000;
    const inicioGlobal = performance.now();

    console.log("\n=== TESTE REAL AOD ===");
    console.log("Produtos:", PRODUTOS.length);
    console.log("Intervalo:", INTERVALO_S, "segundos");
    console.log("Duração:", DURACAO_S, "segundos");
    console.log("Ciclos programados:", CICLOS);
    console.log("Concorrência máxima por ciclo: 3 produtos");
    console.log("Arquivo:", arquivo);

    console.log("\nFiltros:");

    for (const produto of PRODUTOS) {
        console.log(
            produto.asin,
            produto.categorias.join(", ")
        );
    }

    for (let ciclo = 0; ciclo < CICLOS; ciclo++) {
        const horarioPrevisto = (
            inicioGlobal + ciclo * intervaloMs
        );

        const espera = (
            horarioPrevisto - performance.now()
        );

        if (espera > 0) {
            await dormir(espera);
        }

        const atraso = (
            performance.now() - horarioPrevisto
        );

        // Não acumular ciclos atrasados.
        if (atraso > 1000) {
            metricas.ciclosPulados++;

            console.warn(
                `Ciclo ${ciclo + 1} pulado: atraso de ` +
                `${Math.round(atraso)} ms`
            );

            gravar({
                tipo: "CICLO_PULADO",
                ciclo: ciclo + 1,
                atrasoMs: Math.round(atraso)
            });

            continue;
        }

        const inicioCiclo = performance.now();

        console.log(
            `\n=== CICLO ${ciclo + 1}/${CICLOS} ===`
        );

        // Os três produtos começam juntos.
        const resultados = await Promise.allSettled(
            PRODUTOS.map(
                produto => coletarProduto(
                    produto,
                    ciclo + 1
                )
            )
        );

        for (let i = 0; i < resultados.length; i++) {
            const resultado = resultados[i];

            if (resultado.status === "rejected") {
                metricas.falhas++;

                interromper = true;

                const mensagem = resultado.reason.message;

                console.error(
                    PRODUTOS[i].asin,
                    "ERRO:",
                    mensagem
                );

                gravar({
                    tipo: "ERRO",
                    ciclo: ciclo + 1,
                    asin: PRODUTOS[i].asin,
                    mensagem
                });

                continue;
            }

            const dados = resultado.value;

            console.log(
                `${dados.produto.asin} | ` +
                `${dados.totalInformado} ofertas | ` +
                `${dados.paginasConsultadas} pág. | ` +
                `${dados.duracaoMs} ms`
            );

            console.log(
                "  Amazon direta:",
                dados.contagem.AMAZON_DIRETA,
                "| Terceiro/Amazon:",
                dados.contagem.TERCEIRO_ENVIO_AMAZON,
                "| Terceiro/terceiro:",
                dados.contagem.TERCEIRO_ENVIO_PROPRIO
            );

            if (dados.maisBarata) {
                console.log(
                    "  Menor oferta selecionada:",
                    dados.maisBarata.vendedor,
                    moeda(
                        dados.maisBarata.precoNormalCentavos
                    )
                );
            } else {
                console.log(
                    "  Nenhuma oferta selecionada observada."
                );
            }
        }

        const duracaoCicloMs = Math.round(
            performance.now() - inicioCiclo
        );

        metricas.ciclos.push(duracaoCicloMs);

        console.log(
            "Duração do ciclo:",
            duracaoCicloMs,
            "ms"
        );

        if (duracaoCicloMs > intervaloMs) {
            console.warn(
                "Ciclo excedeu o intervalo solicitado."
            );
        }

        if (interromper) {
            console.error(
                "\nTESTE INTERROMPIDO POR SEGURANÇA."
            );
            break;
        }
    }

    if (!interromper) {
        const fimPrevisto = (
            inicioGlobal + DURACAO_S * 1000
        );

        await dormir(Math.max(
            0,
            fimPrevisto - performance.now()
        ));
    }
}

// ========================================
// RELATÓRIO FINAL
// ========================================

function relatorio() {
    const maiorCiclo = metricas.ciclos.length
        ? Math.max(...metricas.ciclos)
        : null;

    const aprovado = (
        !interromper &&
        metricas.falhas === 0 &&
        metricas.ciclosPulados === 0 &&
        metricas.snapshotsValidos ===
            PRODUTOS.length * CICLOS &&
        maiorCiclo !== null &&
        maiorCiclo <= INTERVALO_S * 1000
    );

    console.log("\n=== RELATÓRIO FINAL ===");

    console.table({
        produtos: PRODUTOS.length,
        verificacoesEsperadas: PRODUTOS.length * CICLOS,
        snapshotsValidos: metricas.snapshotsValidos,
        requisicoesHTTP: metricas.requisicoes,
        respostasHTTP: JSON.stringify(metricas.respostas),
        falhas: metricas.falhas,
        ciclosPulados: metricas.ciclosPulados,
        latenciaP50ms:
            percentil(metricas.latencias, 0.50),
        latenciaP95ms:
            percentil(metricas.latencias, 0.95),
        maiorCicloMs: maiorCiclo
    });

    console.log(
        aprovado
            ? "\nTESTE REAL CONCLUÍDO SEM FALHAS OBSERVADAS."
            : "\nTESTE INTERROMPIDO OU REQUISITO NÃO ATENDIDO."
    );

    console.log("Histórico salvo em:", arquivo);

    gravar({
        tipo: "RESUMO",
        aprovado,
        metricas
    });

    return aprovado;
}

// ========================================
// INICIAR
// ========================================

try {
    await executar();

    const aprovado = relatorio();

    if (!aprovado) {
        process.exitCode = 1;
    }

} catch (erro) {
    console.error("\nERRO FATAL:", erro.message);

    gravar({
        tipo: "ERRO_FATAL",
        mensagem: erro.message
    });

    process.exitCode = 1;

} finally {
    await new Promise(resolve => saida.end(resolve));
}
