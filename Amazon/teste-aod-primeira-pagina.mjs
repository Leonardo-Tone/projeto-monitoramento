
import { load } from "cheerio";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { performance } from "node:perf_hooks";

// ========================================
// CONFIGURAÇÃO
// ========================================

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

const INTERVALO = Number(process.argv[2] ?? 10);
const DURACAO = Number(process.argv[3] ?? 600);

const TIMEOUT_MS = 12000;
const DURACAO_MAXIMA = 1800;
const OFERTAS_POR_PAGINA = 10;

// ========================================
// VALIDAR CONFIGURAÇÃO
// ========================================

if (
    ![10, 20, 30].includes(INTERVALO) ||
    !Number.isInteger(DURACAO) ||
    DURACAO < INTERVALO ||
    DURACAO > DURACAO_MAXIMA ||
    DURACAO % INTERVALO !== 0
) {
    console.error(
        "\nConfiguração inválida."
    );

    console.error(
        "Uso: node teste-aod-primeira-pagina.mjs 10 600"
    );

    console.error(
        "Intervalos permitidos: 10, 20 ou 30 segundos."
    );

    console.error(
        "Duração máxima: 1800 segundos (30 minutos)."
    );

    process.exit(1);
}

const CICLOS = DURACAO / INTERVALO;

const arquivo = "aod-primeira-pagina-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    ".jsonl";

const saida = createWriteStream(arquivo, {
    flags: "a"
});

let interromper = false;

const metricas = {
    requisicoesTentadas: 0,
    respostasHTTP: {},
    bytesRecebidos: 0,
    latencias: [],
    snapshotsValidos: 0,
    snapshotsParciais: 0,
    falhas: 0,
    ciclosConcluidos: 0,
    ciclosProgramados: CICLOS,
    duracoesCiclos: [],
    atrasosCiclos: []
};

// ========================================
// UTILITÁRIOS
// ========================================

function limpar(texto = "") {
    return String(texto)
        .replace(/\s+/g, " ")
        .trim();
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
    const match = String(texto ?? "").match(
        /R\$\s*([\d.]+),(\d{2})/
    );

    if (!match) {
        return null;
    }

    const reais = Number(
        match[1].replace(/\./g, "")
    );

    const parte = Number(match[2]);

    return reais * 100 + parte;
}

function centavosDecimal(texto) {
    const valor = String(texto ?? "").trim();

    if (!/^\d+(?:\.\d{1,2})?$/.test(valor)) {
        return null;
    }

    const [reais, parte = ""] = valor.split(".");

    return (
        Number(reais) * 100 +
        Number(parte.padEnd(2, "0"))
    );
}

function moeda(valor) {
    if (valor === null) {
        return "Não informado";
    }

    return (valor / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL"
    });
}

function percentil(valores, fracao) {
    if (!valores.length) {
        return null;
    }

    const ordenados = [...valores].sort(
        (a, b) => a - b
    );

    const indice = Math.max(
        0,
        Math.ceil(ordenados.length * fracao) - 1
    );

    return Math.round(ordenados[indice]);
}

// ========================================
// CLASSIFICAR OFERTA
// ========================================

function categoriaOferta(vendedor, enviadoPor) {
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

    // ------------------------------------
    // VENDEDOR
    // ------------------------------------

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
        ) ||
        "Desconhecido";

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

    // ------------------------------------
    // RESPONSÁVEL PELO ENVIO
    // ------------------------------------

    const enviadoPor = limpar(
        bloco.find(
            '[id="aod-offer-shipsFrom"] .a-col-right'
        ).first().text()
    );

    const categoria = categoriaOferta(
        vendedor,
        enviadoPor
    );

    // ------------------------------------
    // PREÇO NORMAL
    // ------------------------------------

    const botao = bloco.find(
        'input[name="submit.addToCart"]'
    ).first();

    const precoNormalCentavos = centavos(
        botao.attr("aria-label")
    );

    // ------------------------------------
    // PREÇO EXIBIDO / PIX
    // ------------------------------------

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
            ).first().attr(
                "data-csa-c-price-to-pay"
            )
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

        if (
            reais &&
            /^\d{2}$/.test(parte)
        ) {
            precoExibidoCentavos =
                Number(reais) * 100 +
                Number(parte);
        }
    }

    // ------------------------------------
    // FRETE
    // ------------------------------------

    const textoFrete = bloco.find(
        "[data-csa-c-delivery-price]"
    ).first().attr(
        "data-csa-c-delivery-price"
    );

    let freteCentavos = null;

    if (/gr[aá]tis/i.test(textoFrete ?? "")) {
        freteCentavos = 0;
    } else {
        freteCentavos = centavos(
            textoFrete
        );
    }

    if (freteCentavos === null) {
        freteCentavos = centavosDecimal(
            bloco.find(
                "[data-csa-c-shipping-charge]"
            ).first().attr(
                "data-csa-c-shipping-charge"
            )
        );
    }

    // ------------------------------------
    // QUANTIDADE
    // ------------------------------------

    let minQty = null;
    let maxQty = null;

    try {
        const acao = JSON.parse(
            bloco.find(
                "[data-aod-atc-action]"
            ).first().attr(
                "data-aod-atc-action"
            ) || "{}"
        );

        if (Number.isInteger(acao.minQty)) {
            minQty = acao.minQty;
        }

        if (Number.isInteger(acao.maxQty)) {
            maxQty = acao.maxQty;
        }

    } catch {}

    return {
        offerId,
        offerHash: hash(offerId),
        sellerId,
        vendedor,
        enviadoPor,
        categoria,
        precoNormalCentavos,
        precoExibidoCentavos,
        freteCentavos,
        minQty,
        maxQty
    };
}

// ========================================
// EXTRAIR PRIMEIRA PÁGINA
// ========================================

function analisarHTML(html) {
    const $ = load(html);

    // ------------------------------------
    // LISTA DE OFERTAS
    // ------------------------------------

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

    // ------------------------------------
    // OFERTA DESTACADA
    // ------------------------------------

    let destaque = null;

    const elementoDestaque = $(
        "#aod-pinned-offer"
    ).first();

    if (
        elementoDestaque.length &&
        elementoDestaque.find(
            'input[name="items[0.base][offerListingId]"]'
        ).length
    ) {
        destaque = analisarOferta(
            $,
            elementoDestaque
        );
    }

    // ------------------------------------
    // TOTAL INFORMADO PELO AOD
    // ------------------------------------

    const contador = $(
        "#aod-total-offer-count"
    ).first();

    const texto = String(
        contador.attr("value") ??
        contador.val() ??
        contador.text() ??
        ""
    ).trim();

    const totalInformado = /^\d+$/.test(texto)
        ? Number(texto)
        : null;

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
    const existente = mapa.get(
        oferta.offerId
    );

    if (!existente) {
        mapa.set(
            oferta.offerId,
            oferta
        );

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
// MONTAR URL DA PRIMEIRA PÁGINA
// ========================================

function montarURL(asin) {
    const url = new URL(
        "/gp/product/ajax/aodAjaxMain/",
        DOMINIO
    );

    url.searchParams.set(
        "asin",
        asin
    );

    return url;
}

// ========================================
// REQUISIÇÃO HTTP
// ========================================

async function requisitar(asin, ciclo) {
    if (interromper) {
        throw new Error(
            "Teste interrompido"
        );
    }

    const inicio = performance.now();

    metricas.requisicoesTentadas++;

    let resposta;
    let html;

    try {
        resposta = await fetch(
            montarURL(asin),
            {
                headers: {
                    "Accept": "text/html, */*",
                    "Accept-Language": "pt-BR,pt;q=0.9"
                },
                signal: AbortSignal.timeout(
                    TIMEOUT_MS
                )
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
            pagina: 1,
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

        registrar(diagnostico);

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

        throw new Error(
            `Falha de rede em ${asin}: ` +
            `${diagnostico.codigo ?? diagnostico.mensagem}`
        );
    }

    // ------------------------------------
    // MÉTRICAS HTTP
    // ------------------------------------

    const duracaoMs = Math.round(
        performance.now() - inicio
    );

    const bytes = Buffer.byteLength(
        html
    );

    metricas.bytesRecebidos += bytes;

    metricas.latencias.push(
        duracaoMs
    );

    metricas.respostasHTTP[resposta.status] =
        (metricas.respostasHTTP[resposta.status] ?? 0) + 1;

    registrar({
        tipo: "REQUISICAO",
        ciclo,
        asin,
        pagina: 1,
        httpStatus: resposta.status,
        duracaoMs,
        bytes
    });

    // ------------------------------------
    // VALIDAR HTTP
    // ------------------------------------

    if (resposta.status !== 200) {
        interromper = true;

        throw new Error(
            `${asin}: HTTP ${resposta.status}`
        );
    }

    // ------------------------------------
    // DETECTAR DESAFIOS DE ACESSO
    // ------------------------------------

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

    return analisarHTML(html);
}

// ========================================
// COLETA DE UM PRODUTO
// ========================================

async function coletarProduto(produto, ciclo) {
    const inicio = performance.now();

    // Apenas uma página será requisitada.
    const resultado = await requisitar(
        produto.asin,
        ciclo
    );

    const totalInformado = resultado.totalInformado;
    const destaque = resultado.destaque;

    // ------------------------------------
    // VALIDAR CONTADOR DO AOD
    // ------------------------------------

    if (
        !Number.isInteger(totalInformado) ||
        totalInformado < 0
    ) {
        throw new Error(
            `${produto.asin}: total AOD inválido`
        );
    }

    // ------------------------------------
    // PROCESSAR OFERTAS
    // ------------------------------------

    const lista = new Map();

    for (const oferta of resultado.lista) {
        adicionarOferta(
            lista,
            oferta
        );
    }

    const totalLista = lista.size;

    const destaqueExclusivo = Boolean(
        destaque &&
        !lista.has(destaque.offerId)
    );

    const totalUnico = (
        totalLista + Number(destaqueExclusivo)
    );

    // ------------------------------------
    // VALIDAR PRIMEIRA PÁGINA
    // ------------------------------------

    const esperadoNaPagina = Math.min(
        totalInformado,
        OFERTAS_POR_PAGINA
    );

    if (totalLista !== esperadoNaPagina) {
        throw new Error(
            `${produto.asin}: primeira página inconsistente. ` +
            `Esperado: ${esperadoNaPagina}; ` +
            `identificado: ${totalLista}`
        );
    }

    // ------------------------------------
    // IDENTIFICAR TIPO DE COBERTURA
    // ------------------------------------

    let modoContagem;

    if (totalInformado === 0) {
        modoContagem = "SEM_OFERTAS_NA_LISTA";

    } else if (
        totalInformado > OFERTAS_POR_PAGINA
    ) {
        modoContagem = "PARCIAL_PRIMEIRA_PAGINA";

    } else if (destaqueExclusivo) {
        modoContagem = "DESTAQUE_FORA_DO_TOTAL";

    } else {
        modoContagem = "TOTAL_EXATO";
    }

    const snapshotCompleto = (
        totalInformado <= OFERTAS_POR_PAGINA
    );

    const ofertasNaoConsultadasEstimadas = Math.max(
        0,
        totalInformado - totalLista
    );

    // ------------------------------------
    // CONSOLIDAR LISTA E DESTAQUE
    // ------------------------------------

    const ofertas = [
        ...lista.values()
    ];

    if (destaqueExclusivo) {
        ofertas.push(destaque);
    }

    // ------------------------------------
    // CONTAR CATEGORIAS
    // ------------------------------------

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

    // ------------------------------------
    // APLICAR FILTROS CONFIGURADOS
    // ------------------------------------

    const selecionadas = ofertas.filter(
        oferta => produto.categorias.includes(
            oferta.categoria
        )
    );

    // ------------------------------------
    // ORDENAR PREÇOS IDENTIFICADOS
    // ------------------------------------

    const comPreco = selecionadas.filter(
        oferta => Number.isInteger(
            oferta.precoNormalCentavos
        )
    );

    comPreco.sort(
        (a, b) =>
            a.precoNormalCentavos -
            b.precoNormalCentavos
    );

    const maisBarata = comPreco[0] ?? null;

    // ------------------------------------
    // DIAGNÓSTICO DE COBERTURA
    // ------------------------------------

    const diagnostico = {
        totalInformado,
        totalLista,
        possuiDestaque: Boolean(destaque),
        destaqueExclusivo,
        totalUnico,
        modoContagem,
        snapshotCompleto,
        ofertasNaoConsultadasEstimadas,
        paginasConsultadas: 1
    };

    const duracaoMs = Math.round(
        performance.now() - inicio
    );

    // ------------------------------------
    // MÉTRICAS DO PRODUTO
    // ------------------------------------

    metricas.snapshotsValidos++;

    if (!snapshotCompleto) {
        metricas.snapshotsParciais++;
    }

    // ------------------------------------
    // HISTÓRICO DE COBERTURA
    // ------------------------------------

    registrar({
        tipo: "COBERTURA_PRIMEIRA_PAGINA",
        ciclo,
        asin: produto.asin,
        ...diagnostico
    });

    // ------------------------------------
    // HISTÓRICO DAS OFERTAS
    // ------------------------------------

    registrar({
        tipo: "SNAPSHOT_PRIMEIRA_PAGINA",
        ciclo,
        asin: produto.asin,
        nome: produto.nome,
        duracaoMs,
        categoriasSelecionadas: produto.categorias,
        ofertasSelecionadas: selecionadas.length,
        contagem,
        ...diagnostico,
        ofertas: ofertas.map(
            ({ offerId, ...dados }) => dados
        )
    });

    // ------------------------------------
    // RESULTADO
    // ------------------------------------

    return {
        produto,
        totalUnico,
        contagem,
        modoContagem,
        snapshotCompleto,
        ofertasNaoConsultadasEstimadas,
        maisBarata,
        duracaoMs
    };
}

// ========================================
// EXECUTAR MONITORAMENTO
// ========================================

async function executar() {
    const inicioGlobal = performance.now();
    const intervaloMs = INTERVALO * 1000;

    console.log(
        "\n=== MONITOR AOD - PRIMEIRA PÁGINA ==="
    );

    console.table({
        produtos: PRODUTOS.length,
        paginasPorProduto: 1,
        intervaloSegundos: INTERVALO,
        duracaoSegundos: DURACAO,
        ciclosProgramados: CICLOS,
        verificacoesEsperadas: PRODUTOS.length * CICLOS,
        requisicoesPlanejadas: PRODUTOS.length * CICLOS,
        concorrenciaMaxima: PRODUTOS.length
    });

    console.log(
        "\nHistórico:",
        arquivo
    );

    console.log(
        "\nCategorias por produto:"
    );

    for (const produto of PRODUTOS) {
        console.log(
            produto.asin,
            produto.categorias.join(", ")
        );
    }

    // ------------------------------------
    // CICLOS
    // ------------------------------------

    for (
        let ciclo = 0;
        ciclo < CICLOS;
        ciclo++
    ) {
        if (interromper) {
            break;
        }

        const horarioPrevisto = (
            inicioGlobal +
            ciclo * intervaloMs
        );

        const espera = (
            horarioPrevisto -
            performance.now()
        );

        if (espera > 0) {
            await dormir(espera);
        }

        const atraso = Math.max(
            0,
            performance.now() - horarioPrevisto
        );

        metricas.atrasosCiclos.push(
            Math.round(atraso)
        );

        // Não executar ciclos atrasados.
        if (atraso > 1000) {
            interromper = true;

            registrar({
                tipo: "ATRASO_EXCESSIVO",
                ciclo: ciclo + 1,
                atrasoMs: Math.round(atraso)
            });

            throw new Error(
                `Ciclo ${ciclo + 1}: atraso de ` +
                `${Math.round(atraso)} ms`
            );
        }

        const numeroCiclo = ciclo + 1;
        const inicioCiclo = performance.now();

        console.log(
            `\n========== CICLO ${numeroCiclo}/${CICLOS} ==========`
        );

        // Os dez produtos são consultados
        // em paralelo neste ciclo.
        const resultados = await Promise.allSettled(
            PRODUTOS.map(
                produto => coletarProduto(
                    produto,
                    numeroCiclo
                )
            )
        );

        // --------------------------------
        // EXIBIR RESULTADOS
        // --------------------------------

        for (
            let i = 0;
            i < resultados.length;
            i++
        ) {
            const resultado = resultados[i];

            if (resultado.status === "rejected") {
                metricas.falhas++;
                interromper = true;

                const mensagem = (
                    resultado.reason?.message ??
                    String(resultado.reason)
                );

                console.error(
                    "\nERRO:",
                    PRODUTOS[i].asin,
                    mensagem
                );

                registrar({
                    tipo: "ERRO",
                    ciclo: numeroCiclo,
                    asin: PRODUTOS[i].asin,
                    mensagem
                });

                continue;
            }

            const dados = resultado.value;

            console.log(
                `\n${dados.produto.nome}`
            );

            console.log(
                "ASIN:",
                dados.produto.asin
            );

            console.log(
                "Ofertas na primeira página:",
                dados.totalUnico
            );

            console.log(
                "Amazon direta:",
                dados.contagem.AMAZON_DIRETA,
                "| Terceiro/Amazon:",
                dados.contagem.TERCEIRO_ENVIO_AMAZON,
                "| Terceiro/próprio:",
                dados.contagem.TERCEIRO_ENVIO_PROPRIO
            );

            console.log(
                "Cobertura:",
                dados.modoContagem
            );

            if (!dados.snapshotCompleto) {
                console.log(
                    "Ofertas nas outras páginas (estimadas):",
                    dados.ofertasNaoConsultadasEstimadas
                );
            }

            if (dados.maisBarata) {
                console.log(
                    "Menor preço observado:",
                    dados.maisBarata.vendedor,
                    moeda(
                        dados.maisBarata.precoNormalCentavos
                    )
                );
            } else {
                console.log(
                    "Nenhuma oferta selecionada com preço."
                );
            }

            console.log(
                "Duração:",
                dados.duracaoMs,
                "ms"
            );
        }

        // --------------------------------
        // FECHAR CICLO
        // --------------------------------

        const duracaoCiclo = Math.round(
            performance.now() - inicioCiclo
        );

        metricas.duracoesCiclos.push(
            duracaoCiclo
        );

        console.log(
            "\nDuração do ciclo:",
            duracaoCiclo,
            "ms"
        );

        registrar({
            tipo: "CICLO",
            ciclo: numeroCiclo,
            duracaoMs: duracaoCiclo,
            atrasoMs: Math.round(atraso),
            errosAcumulados: metricas.falhas,
            interrompido: interromper
        });

        if (duracaoCiclo > intervaloMs) {
            interromper = true;

            console.error(
                "\nCiclo excedeu o intervalo."
            );
        }

        if (interromper) {
            console.error(
                "\nMONITORAMENTO INTERROMPIDO."
            );

            break;
        }

        metricas.ciclosConcluidos++;
    }

    // ------------------------------------
    // COMPLETAR JANELA DE TEMPO
    // ------------------------------------

    if (!interromper) {
        const fimPrevisto = (
            inicioGlobal +
            DURACAO * 1000
        );

        await dormir(
            Math.max(
                0,
                fimPrevisto - performance.now()
            )
        );
    }
}

// ========================================
// RELATÓRIO FINAL
// ========================================

function relatorio() {
    const snapshotsEsperados = (
        PRODUTOS.length * CICLOS
    );

    const requisicoesEsperadas = (
        PRODUTOS.length * CICLOS
    );

    const maiorCicloMs = (
        metricas.duracoesCiclos.length
            ? Math.max(...metricas.duracoesCiclos)
            : null
    );

    const maiorAtrasoMs = (
        metricas.atrasosCiclos.length
            ? Math.max(...metricas.atrasosCiclos)
            : null
    );

    const aprovado = (
        !interromper &&
        metricas.falhas === 0 &&
        metricas.snapshotsValidos ===
            snapshotsEsperados &&
        metricas.ciclosConcluidos === CICLOS &&
        maiorCicloMs !== null &&
        maiorCicloMs <= INTERVALO * 1000
    );

    const resumo = {
        produtos: PRODUTOS.length,
        paginasPorProduto: 1,
        intervaloSegundos: INTERVALO,
        duracaoSegundos: DURACAO,
        ciclosEsperados: CICLOS,
        ciclosConcluidos: metricas.ciclosConcluidos,
        snapshotsEsperados,
        snapshotsValidos: metricas.snapshotsValidos,
        snapshotsParciais: metricas.snapshotsParciais,
        requisicoesEsperadas,
        requisicoesTentadas:
            metricas.requisicoesTentadas,
        respostasHTTP:
            JSON.stringify(metricas.respostasHTTP),
        falhas: metricas.falhas,
        latenciaP50ms:
            percentil(metricas.latencias, 0.50),
        latenciaP95ms:
            percentil(metricas.latencias, 0.95),
        maiorCicloMs,
        maiorAtrasoMs,
        dadosRecebidosMB: (
            metricas.bytesRecebidos /
            (1024 * 1024)
        ).toFixed(2),
        aprovado
    };

    console.log(
        "\n========== RELATÓRIO FINAL =========="
    );

    console.table(resumo);

    console.log(
        aprovado
            ? "\nTESTE DE PRIMEIRA PÁGINA APROVADO!"
            : "\nTESTE INCOMPLETO OU REPROVADO."
    );

    registrar({
        tipo: "RESUMO",
        ...resumo
    });

    console.log(
        "\nHistórico salvo em:",
        arquivo
    );

    return aprovado;
}

// ========================================
// EXECUÇÃO PRINCIPAL
// ========================================

try {
    await executar();

    const aprovado = relatorio();

    if (!aprovado) {
        process.exitCode = 1;
    }

} catch (erro) {
    interromper = true;

    console.error(
        "\nERRO FATAL:",
        erro.message
    );

    registrar({
        tipo: "ERRO_FATAL",
        mensagem: erro.message
    });

    relatorio();

    process.exitCode = 1;

} finally {
    await new Promise(
        resolve => saida.end(resolve)
    );
}
