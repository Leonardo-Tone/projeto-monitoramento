
import { load } from "cheerio";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { performance } from "node:perf_hooks";

const DOMINIO = "https://www.amazon.com.br";

const CATEGORIAS = [
    "AMAZON_DIRETA",
    "TERCEIRO_ENVIO_AMAZON",
    "TERCEIRO_ENVIO_PROPRIO"
];


const PRODUTOS = [
    {
        asin: "B000GAYQJ0",
        nome: "Casio A158WA",
        categorias: [...CATEGORIAS]
    },
    {
        asin: "B0HC8JZC1D",
        nome: "Pokemon Advanced Trainer Box",
        categorias: [...CATEGORIAS]
    },
    {
        asin: "B0HCCTKPGN",
        nome: "Pokemon Binder Collection",
        categorias: [...CATEGORIAS]
    },
    {
        asin: "B0H7XF3LJL",
        nome: "Pokemon Ilustracao Parceiro",
        categorias: [...CATEGORIAS]
    },
    {
        asin: "B0HFNZP4JX",
        nome: "Pokemon Celebracao 30 Anos",
        categorias: [...CATEGORIAS]
    },
    {
        asin: "B0H3Q76WTZ",
        nome: "Pokemon Colecao Greninja",
        categorias: [...CATEGORIAS]
    },
    {
        asin: "B0HDZYGH9X",
        nome: "Pokemon Mega Forcas Darkrai",
        categorias: [...CATEGORIAS]
    },
    {
        asin: "B0HG7L4PWT",
        nome: "Pokemon Forcas Dragonite",
        categorias: [...CATEGORIAS]
    },
    {
        asin: "B0GLT3P8C1",
        nome: "Pokemon Box Mega Charizard",
        categorias: [...CATEGORIAS]
    },
    {
        asin: "B0H3QKR97T",
        nome: "Pokemon Evolucao Escuridao",
        categorias: [...CATEGORIAS]
    }
];


const INTERVALO = Number(process.argv[2] ?? 30);
const DURACAO = Number(process.argv[3] ?? 60);

const TIMEOUT = 12000;
const MAX_PAGINAS = 8;
const OFERTAS_POR_PAGINA = 10;

if (
    ![10, 20, 30].includes(INTERVALO) ||
    !Number.isInteger(DURACAO) ||
    DURACAO < INTERVALO ||
    DURACAO > 300 ||
    DURACAO % INTERVALO !== 0
) {
    console.error(
        "Uso: node teste-aod-real-v2.mjs 30 60"
    );
    process.exit(1);
}

const CICLOS = DURACAO / INTERVALO;

const arquivo = "aod-real-v2-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    ".jsonl";

const saida = createWriteStream(arquivo);
let interromper = false;

const metricas = {
    requisicoes: 0,
    http: {},
    latencias: [],
    snapshotsValidos: 0,
    falhas: 0,
    ciclosConcluidos: 0,
    duracoes: []
};

// ========================================
// UTILITÁRIOS
// ========================================

function limpar(texto = "") {
    return String(texto).replace(/\s+/g, " ").trim();
}

function dormir(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function registrar(dados) {
    saida.write(JSON.stringify({
        horario: new Date().toISOString(),
        ...dados
    }) + "\n");
}

function hash(id) {
    return createHash("sha256")
        .update(id)
        .digest("hex")
        .slice(0, 16);
}

function centavos(texto) {
    const m = String(texto ?? "").match(
        /R\$\s*([\d.]+),(\d{2})/
    );

    if (!m) return null;

    return Number(m[1].replace(/\./g, "")) * 100
        + Number(m[2]);
}

function centavosDecimal(texto) {
    const valor = String(texto ?? "");

    if (!/^\d+(?:\.\d{1,2})?$/.test(valor)) {
        return null;
    }

    const [reais, parte = ""] = valor.split(".");

    return Number(reais) * 100 +
        Number(parte.padEnd(2, "0"));
}

function moeda(valor) {
    if (valor === null) return "Não informado";

    return (valor / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL"
    });
}

function percentil(valores, fracao) {
    if (!valores.length) return null;

    const ordenados = [...valores].sort(
        (a, b) => a - b
    );

    const indice = Math.max(
        0,
        Math.ceil(ordenados.length * fracao) - 1
    );

    return Math.round(ordenados[indice]);
}

function categoriaOferta(vendedor, enviadoPor) {
    const nome = limpar(vendedor);
    const envio = limpar(enviadoPor);

    if (!nome || nome === "Desconhecido" || !envio) {
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
// EXTRAIR UMA OFERTA
// ========================================

function analisarOferta($, elemento) {
    const bloco = $(elemento);

    const offerId = bloco.find(
        'input[name="items[0.base][offerListingId]"]'
    ).first().attr("value");

    if (!offerId) {
        throw new Error(
            "Bloco de oferta sem offerListingId"
        );
    }

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

    if (/^amazon\.com\.br$/i.test(vendedor)) {
        sellerId ??= "AMAZON_DIRECT";
    }

    const enviadoPor = limpar(
        bloco.find(
            '[id="aod-offer-shipsFrom"] .a-col-right'
        ).first().text()
    );

    const botao = bloco.find(
        'input[name="submit.addToCart"]'
    ).first();

    const precoNormalCentavos = centavos(
        botao.attr("aria-label")
    );

    const areaPreco = bloco.find(
        '[id="aod-offer-price"]'
    ).first();

    let precoExibidoCentavos = centavos(
        areaPreco.find(
            ".apex-pricetopay-accessibility-label"
        ).first().text()
    );

    if (precoExibidoCentavos === null) {
        precoExibidoCentavos = centavosDecimal(
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

        const parte = visual.find(
            ".a-price-fraction"
        ).first().text().replace(/\D/g, "");

        if (reais && /^\d{2}$/.test(parte)) {
            precoExibidoCentavos =
                Number(reais) * 100 + Number(parte);
        }
    }

    const textoFrete = bloco.find(
        "[data-csa-c-delivery-price]"
    ).first().attr("data-csa-c-delivery-price");

    let freteCentavos = null;

    if (/gr[aá]tis/i.test(textoFrete ?? "")) {
        freteCentavos = 0;
    } else {
        freteCentavos = centavos(textoFrete);
    }

    if (freteCentavos === null) {
        freteCentavos = centavosDecimal(
            bloco.find(
                "[data-csa-c-shipping-charge]"
            ).first().attr("data-csa-c-shipping-charge")
        );
    }

    let minQty = null;
    let maxQty = null;

    try {
        const dados = JSON.parse(
            bloco.find(
                "[data-aod-atc-action]"
            ).first().attr("data-aod-atc-action") || "{}"
        );

        if (Number.isInteger(dados.minQty)) {
            minQty = dados.minQty;
        }

        if (Number.isInteger(dados.maxQty)) {
            maxQty = dados.maxQty;
        }
    } catch {}

    return {
        offerId,
        offerHash: hash(offerId),
        sellerId,
        vendedor,
        enviadoPor,
        categoria: categoriaOferta(vendedor, enviadoPor),
        precoNormalCentavos,
        precoExibidoCentavos,
        freteCentavos,
        minQty,
        maxQty
    };
}

// ========================================
// SEPARAR LISTA E DESTAQUE
// ========================================

function analisarHTML(html, pagina) {
    const $ = load(html);

    // O destaque não deve ser contabilizado
    // como uma oferta da lista paginada.
    const elementosLista = $(
        '[id="aod-offer"]'
    ).toArray().filter(
        elemento =>
            $(elemento).closest(
                "#aod-pinned-offer"
            ).length === 0
    );

    const lista = elementosLista.map(
        elemento => analisarOferta($, elemento)
    );

    let destaque = null;

    if (pagina === 1) {
        const elemento = $(
            "#aod-pinned-offer"
        ).first();

        if (
            elemento.length &&
            elemento.find(
                'input[name="items[0.base][offerListingId]"]'
            ).length
        ) {
            destaque = analisarOferta($, elemento);
        }
    }

    let totalInformado = null;

    if (pagina === 1) {
        const contador = $(
            "#aod-total-offer-count"
        ).first();

        const texto = String(
            contador.attr("value") ??
            contador.val() ??
            contador.text() ??
            ""
        ).trim();

        if (/^\d+$/.test(texto)) {
            totalInformado = Number(texto);
        }
    }

    return {
        lista,
        destaque,
        totalInformado
    };
}

// ========================================
// VERIFICAR DUPLICATAS
// ========================================

function adicionarOferta(mapa, oferta) {
    const existente = mapa.get(oferta.offerId);

    if (!existente) {
        mapa.set(oferta.offerId, oferta);
        return true;
    }

    const conflito = (
        existente.sellerId !== oferta.sellerId ||
        existente.vendedor !== oferta.vendedor ||
        existente.enviadoPor !== oferta.enviadoPor ||
        existente.precoNormalCentavos !==
            oferta.precoNormalCentavos
    );

    if (conflito) {
        throw new Error(
            "Mesmo offerListingId com dados divergentes"
        );
    }

    return false;
}

// ========================================
// URL DO AOD
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
// REQUISIÇÃO HTTP
// ========================================

async function requisitar(asin, pagina, ciclo) {
    if (interromper) {
        throw new Error("Teste interrompido");
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
                signal: AbortSignal.timeout(TIMEOUT)
            }
        );

        html = await resposta.text();

    } catch (erro) {
        interromper = true;

        const causa = erro.cause;

        const diagnostico = {
            tipo: "ERRO_TRANSPORTE",
            ciclo,
            asin,
            pagina,
            duracaoMs: Math.round(
                performance.now() - inicio
            ),
            nome: erro.name ?? null,
            mensagem: erro.message ?? null,
            codigo: causa?.code ?? erro.code ?? null,
            causa: causa?.message ?? null,
            errosInternos: Array.isArray(causa?.errors)
                ? causa.errors.map(e => ({
                    codigo: e.code ?? null,
                    mensagem: e.message ?? null
                }))
                : []
        };

        console.error(
            "\n=== DIAGNÓSTICO DE REDE ==="
        );

        console.table({
            asin: diagnostico.asin,
            pagina: diagnostico.pagina,
            duracaoMs: diagnostico.duracaoMs,
            erro: diagnostico.mensagem,
            codigo: diagnostico.codigo,
            causa: diagnostico.causa
        });

        if (diagnostico.errosInternos.length) {
            console.table(
                diagnostico.errosInternos
            );
        }

        registrar(diagnostico);

        throw new Error(
            `Falha de rede em ${asin}, página ${pagina}: ` +
            `${diagnostico.codigo ?? diagnostico.mensagem}`
        );
    }

    const duracaoMs = Math.round(
        performance.now() - inicio
    );

    metricas.requisicoes++;
    metricas.latencias.push(duracaoMs);

    metricas.http[resposta.status] =
        (metricas.http[resposta.status] ?? 0) + 1;

    registrar({
        tipo: "REQUISICAO",
        ciclo,
        asin,
        pagina,
        httpStatus: resposta.status,
        duracaoMs,
        bytes: Buffer.byteLength(html)
    });

    if (resposta.status !== 200) {
        interromper = true;

        throw new Error(
            `${asin} página ${pagina}: HTTP ${resposta.status}`
        );
    }

    const captcha = (
        /<title[^>]*>\s*robot check/i.test(html) ||
        /\/errors\/validateCaptcha/i.test(html) ||
        /id=["']captchacharacters["']/i.test(html)
    );

    if (captcha) {
        interromper = true;

        throw new Error(
            `Desafio de acesso identificado em ${asin}`
        );
    }

    return analisarHTML(html, pagina);
}

// ========================================
// COLETA COMPLETA DO PRODUTO
// ========================================

async function coletarProduto(produto, ciclo) {
    const inicio = performance.now();

    const lista = new Map();
    const paginas = [];

    let destaque = null;
    let totalInformado = null;

    const primeira = await requisitar(
        produto.asin,
        1,
        ciclo
    );

    totalInformado = primeira.totalInformado;
    destaque = primeira.destaque;

    if (
        !Number.isInteger(totalInformado) ||
        totalInformado < 0
    ) {
        throw new Error(
            `${produto.asin}: total AOD inválido`
        );
    }

    if (totalInformado === 0) {
        throw new Error(
            `${produto.asin}: zero ofertas requer revisão`
        );
    }

    const totalPaginas = Math.ceil(
        totalInformado / OFERTAS_POR_PAGINA
    );

    if (totalPaginas > MAX_PAGINAS) {
        throw new Error(
            `${produto.asin}: necessita ${totalPaginas} páginas; ` +
            `limite do teste é ${MAX_PAGINAS}`
        );
    }

    function processarPagina(numero, resultado) {
        const antes = lista.size;

        for (const oferta of resultado.lista) {
            adicionarOferta(lista, oferta);
        }

        paginas.push({
            pagina: numero,
            blocosLista: resultado.lista.length,
            novosIdsLista: lista.size - antes
        });
    }

    processarPagina(1, primeira);

    for (
        let pagina = 2;
        pagina <= totalPaginas;
        pagina++
    ) {
        if (interromper) {
            throw new Error("Teste interrompido");
        }

        const resultado = await requisitar(
            produto.asin,
            pagina,
            ciclo
        );

        processarPagina(pagina, resultado);
    }

    // ====================================
    // CONFERIR O TOTAL REAL
    // ====================================

    const destaqueExclusivo = Boolean(
        destaque &&
        !lista.has(destaque.offerId)
    );

    const totalLista = lista.size;

    const totalUnico = (
        totalLista + Number(destaqueExclusivo)
    );

    let modoContagem = "INCONCLUSIVO";

    if (totalLista === totalInformado) {
        if (destaqueExclusivo) {
            modoContagem = "DESTAQUE_FORA_DO_TOTAL";
        } else {
            modoContagem = "TOTAL_EXATO";
        }
    } else if (
        totalLista + 1 === totalInformado &&
        destaqueExclusivo
    ) {
        // Possível total que inclui um destaque.
        // A contagem fecha, mas a interpretação
        // permanece sob observação.
        modoContagem = "TOTAL_COM_DESTAQUE_POSSIVEL";
    }

    const diagnostico = {
        totalInformado,
        totalLista,
        possuiDestaque: Boolean(destaque),
        destaqueExclusivo,
        totalUnico,
        modoContagem,
        paginas
    };

    registrar({
        tipo: "COBERTURA",
        ciclo,
        asin: produto.asin,
        ...diagnostico
    });

    console.log(
        `\n${produto.asin} - CONFERÊNCIA`
    );

    console.table({
        totalInformado,
        ofertasUnicasLista: totalLista,
        destaquePresente: Boolean(destaque),
        destaqueExclusivo,
        ofertasUnicasTotal: totalUnico,
        modoContagem
    });

    console.table(paginas);

    if (modoContagem === "INCONCLUSIVO") {
        throw new Error(
            `${produto.asin}: cobertura inconclusiva ` +
            `(${totalLista} na lista, ` +
            `${totalUnico} no total, ` +
            `${totalInformado} informadas)`
        );
    }

    // A lista e o destaque são preservados
    // como ofertas independentes somente
    // quando possuem identificadores diferentes.
    const ofertas = [...lista.values()];

    if (destaqueExclusivo) {
        ofertas.push(destaque);
    }

    const contagem = {
        AMAZON_DIRETA: 0,
        TERCEIRO_ENVIO_AMAZON: 0,
        TERCEIRO_ENVIO_PROPRIO: 0,
        DESCONHECIDA: 0,
        REVISAR_MODALIDADE: 0
    };

    for (const oferta of ofertas) {
        contagem[oferta.categoria]++;
    }

    const selecionadas = ofertas.filter(
        oferta => produto.categorias.includes(
            oferta.categoria
        )
    );

    const comPreco = selecionadas.filter(
        oferta =>
            Number.isInteger(
                oferta.precoNormalCentavos
            )
    );

    comPreco.sort(
        (a, b) =>
            a.precoNormalCentavos -
            b.precoNormalCentavos
    );

    const duracaoMs = Math.round(
        performance.now() - inicio
    );

    metricas.snapshotsValidos++;

    registrar({
        tipo: "SNAPSHOT",
        ciclo,
        asin: produto.asin,
        nome: produto.nome,
        duracaoMs,
        contagem,
        categoriasSelecionadas: produto.categorias,
        ofertasSelecionadas: selecionadas.length,
        ...diagnostico,
        ofertas: ofertas.map(
            ({ offerId, ...campos }) => campos
        )
    });

    return {
        produto,
        contagem,
        totalUnico,
        modoContagem,
        paginas: totalPaginas,
        maisBarata: comPreco[0] ?? null,
        duracaoMs
    };
}

// ========================================
// EXECUTAR OS CICLOS
// ========================================

async function executar() {
    const inicio = performance.now();
    const intervaloMs = INTERVALO * 1000;

    console.log("\n=== TESTE REAL AOD V2 ===");
    console.log("Produtos:", PRODUTOS.length);
    console.log("Intervalo:", INTERVALO, "segundos");
    console.log("Ciclos:", CICLOS);
    console.log("Histórico:", arquivo);

    for (let ciclo = 0; ciclo < CICLOS; ciclo++) {
        if (interromper) break;

        const previsto = inicio + ciclo * intervaloMs;
        await dormir(
            Math.max(0, previsto - performance.now())
        );

        const atraso = performance.now() - previsto;

        if (atraso > 1000) {
            interromper = true;
            throw new Error(
                `Ciclo ${ciclo + 1}: atraso excessivo`
            );
        }

        console.log(
            `\n========== CICLO ${ciclo + 1}/${CICLOS} ==========`
        );

        const inicioCiclo = performance.now();

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

                console.error(
                    "\nERRO:",
                    PRODUTOS[i].asin,
                    resultado.reason.message
                );

                registrar({
                    tipo: "ERRO",
                    ciclo: ciclo + 1,
                    asin: PRODUTOS[i].asin,
                    mensagem: resultado.reason.message
                });

                continue;
            }

            const dados = resultado.value;

            console.log(
                `\n${dados.produto.nome}: ` +
                `${dados.totalUnico} ofertas únicas`
            );

            console.log(
                "Amazon direta:",
                dados.contagem.AMAZON_DIRETA,
                "| Terceiro/Amazon:",
                dados.contagem.TERCEIRO_ENVIO_AMAZON,
                "| Terceiro/próprio:",
                dados.contagem.TERCEIRO_ENVIO_PROPRIO
            );

            if (dados.maisBarata) {
                console.log(
                    "Menor oferta selecionada:",
                    dados.maisBarata.vendedor,
                    moeda(
                        dados.maisBarata.precoNormalCentavos
                    )
                );
            }
        }

        const duracaoCiclo = Math.round(
            performance.now() - inicioCiclo
        );

        metricas.duracoes.push(duracaoCiclo);

        console.log(
            "\nDuração do ciclo:",
            duracaoCiclo,
            "ms"
        );

        if (duracaoCiclo > intervaloMs) {
            interromper = true;

            console.error(
                "Ciclo excedeu o intervalo."
            );
        }

        if (interromper) {
            console.error(
                "\nTESTE INTERROMPIDO."
            );
            break;
        }

        metricas.ciclosConcluidos++;
    }

    if (!interromper) {
        await dormir(
            Math.max(
                0,
                inicio + DURACAO * 1000 -
                    performance.now()
            )
        );
    }
}

// ========================================
// RELATÓRIO FINAL
// ========================================

function relatorio() {
    const esperado = PRODUTOS.length * CICLOS;

    const aprovado = (
        !interromper &&
        metricas.falhas === 0 &&
        metricas.snapshotsValidos === esperado &&
        metricas.ciclosConcluidos === CICLOS
    );

    console.log("\n=== RELATÓRIO FINAL ===");

    console.table({
        produtos: PRODUTOS.length,
        snapshotsEsperados: esperado,
        snapshotsValidos: metricas.snapshotsValidos,
        requisicoes: metricas.requisicoes,
        respostasHTTP: JSON.stringify(metricas.http),
        falhas: metricas.falhas,
        ciclosConcluidos: metricas.ciclosConcluidos,
        latenciaP50ms: percentil(
            metricas.latencias, 0.5
        ),
        latenciaP95ms: percentil(
            metricas.latencias, 0.95
        ),
        maiorCicloMs: metricas.duracoes.length
            ? Math.max(...metricas.duracoes)
            : null
    });

    console.log(
        aprovado
            ? "\nTESTE REAL V2 CONCLUÍDO SEM FALHAS OBSERVADAS."
            : "\nTESTE INCOMPLETO OU REPROVADO."
    );

    registrar({
        tipo: "RESUMO",
        aprovado,
        metricas
    });

    console.log("Histórico:", arquivo);

    return aprovado;
}

// ========================================
// EXECUÇÃO PRINCIPAL
// ========================================

try {
    await executar();

    if (!relatorio()) {
        process.exitCode = 1;
    }

} catch (erro) {
    console.error("\nERRO FATAL:", erro.message);

    registrar({
        tipo: "ERRO_FATAL",
        mensagem: erro.message
    });

    process.exitCode = 1;

} finally {
    await new Promise(
        resolve => saida.end(resolve)
    );
}
