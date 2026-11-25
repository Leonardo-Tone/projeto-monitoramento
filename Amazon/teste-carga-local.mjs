
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { load } from "cheerio";

// ========================================
// CONFIGURAÇÃO
// ========================================

const PRODUTOS = 10;
const INTERVALO_MS = 10000;
const LATENCIA_SIMULADA_MS = 250;

// Parâmetros:
// node teste-carga-local.mjs PAGINAS DURACAO CONCORRENCIA

const PAGINAS = Number(process.argv[2] ?? 2);
const DURACAO = Number(process.argv[3] ?? 60);
const CONCORRENCIA = Number(process.argv[4] ?? 3);

if (
    !Number.isInteger(PAGINAS) ||
    PAGINAS < 1 || PAGINAS > 5 ||
    !Number.isInteger(DURACAO) ||
    DURACAO < 10 || DURACAO % 10 !== 0 ||
    !Number.isInteger(CONCORRENCIA) ||
    CONCORRENCIA < 1 || CONCORRENCIA > 10
) {
    console.error(
        "Uso: node teste-carga-local.mjs " +
        "PAGINAS(1-5) DURACAO(multiplo de 10) " +
        "CONCORRENCIA(1-10)"
    );

    process.exit(1);
}

const CICLOS = DURACAO * 1000 / INTERVALO_MS;

const metricas = {
    requisicoes: 0,
    bytes: 0,
    latencias: [],
    temposParser: [],
    verificacoes: 0,
    erros: [],
    duracoesCiclo: [],
    atrasos: [],
    picoMemoria: process.memoryUsage().rss
};

// ========================================
// FUNÇÕES AUXILIARES
// ========================================

function limpar(texto = "") {
    return String(texto).replace(/\s+/g, " ").trim();
}

function dormir(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function percentil(valores, porcentagem) {
    if (!valores.length) return 0;

    const ordenados = [...valores].sort((a, b) => a - b);

    const indice = Math.max(
        0,
        Math.ceil(ordenados.length * porcentagem) - 1
    );

    return ordenados[indice];
}

function atualizarMemoria() {
    metricas.picoMemoria = Math.max(
        metricas.picoMemoria,
        process.memoryUsage().rss
    );
}

// ========================================
// CARREGAR HTML REAL DO DISCO
// ========================================

async function carregarModelos() {
    const arquivos = (await readdir(".")).filter(
        nome => /^aod-[A-Z0-9]{10}\.html$/i.test(nome)
    );

    if (!arquivos.length) {
        throw new Error(
            "Nenhum arquivo aod-ASIN.html encontrado. " +
            "Execute novamente o diagnóstico anterior " +
            "para gerar pelo menos um HTML AOD."
        );
    }

    const modelos = [];

    for (const arquivo of arquivos) {
        const html = await readFile(arquivo, "utf8");
        const $ = load(html);

        const blocos = $('[id="aod-offer"]');

        const ofertas = blocos.toArray()
            .map(elemento => $.html(elemento))
            .filter(Boolean);

        if (ofertas.length < 1) {
            console.log(
                `Ignorando ${arquivo}: nenhuma oferta encontrada.`
            );
            continue;
        }

        modelos.push({
            arquivo,
            ofertas
        });

        console.log(
            `${arquivo}: ${ofertas.length} ofertas-base`
        );
    }

    if (!modelos.length) {
        throw new Error("Nenhum HTML AOD válido encontrado.");
    }

    return modelos;
}

// ========================================
// CONSTRUIR RESPOSTAS LOCAIS
// ========================================

function gerarOferta(htmlOriginal, produto, pagina, indice) {
    const id = `LOCAL_${produto}_P${pagina}_O${indice + 1}`;

    let html = htmlOriginal.replace(
        /(<input\b[^>]*name="items\[0\.base\]\[offerListingId\]"[^>]*value=")[^"]*(")/i,
        (_, antes, depois) => antes + id + depois
    );

    if (html === htmlOriginal) {
        throw new Error(
            "Não foi possível substituir o offerListingId."
        );
    }

    // Remover tokens dos arquivos originais.
    html = html.replace(
        /(<input\b[^>]*name="anti-csrftoken-a2z"[^>]*value=")[^"]*(")/gi,
        (_, antes, depois) => antes + "TOKEN_LOCAL" + depois
    );

    return html;
}

function gerarRespostas(modelos) {
    const respostas = new Map();

    for (let produto = 1; produto <= PRODUTOS; produto++) {
        const codigo = String(produto).padStart(2, "0");

        const modelo = modelos[
            (produto - 1) % modelos.length
        ];

        for (let pagina = 1; pagina <= PAGINAS; pagina++) {
            const ofertas = [];

            // Dez ofertas em cada página simulada.
            for (let i = 0; i < 10; i++) {
                const original = modelo.ofertas[
                    i % modelo.ofertas.length
                ];

                ofertas.push(
                    gerarOferta(original, codigo, pagina, i)
                );
            }

            let html;

            if (pagina === 1) {
                html = `
                    <div id="aod-container">
                        <input
                            id="aod-total-offer-count"
                            value="${PAGINAS * 10}"
                        >
                        <div id="aod-offer-list">
                            ${ofertas.join("\n")}
                        </div>
                    </div>
                `;
            } else {
                // Fragmento semelhante às páginas extras
                // que encontramos na Amazon.
                html = ofertas.join("\n");
            }

            respostas.set(`${codigo}:${pagina}`, html);
        }
    }

    return respostas;
}

// ========================================
// SERVIDOR HTTP LOCAL
// ========================================

async function iniciarServidor(respostas) {
    const servidor = createServer((req, res) => {
        const url = new URL(
            req.url,
            "http://127.0.0.1"
        );

        const match = url.pathname.match(
            /^\/produto\/(\d{2})\/pagina\/(\d+)$/
        );

        if (!match) {
            res.writeHead(404);
            res.end("Rota inexistente");
            return;
        }

        const chave = `${match[1]}:${Number(match[2])}`;
        const html = respostas.get(chave);

        if (!html) {
            res.writeHead(404);
            res.end("Página inexistente");
            return;
        }

        // Simula a latência da resposta externa.
        setTimeout(() => {
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store"
            });

            res.end(html);
        }, LATENCIA_SIMULADA_MS);
    });

    await new Promise((resolve, reject) => {
        servidor.once("error", reject);
        servidor.listen(0, "127.0.0.1", resolve);
    });

    const porta = servidor.address().port;

    return {
        servidor,
        baseURL: `http://127.0.0.1:${porta}`
    };
}

// ========================================
// PARSER DAS OFERTAS
// ========================================

function analisarPagina(html) {
    const inicio = performance.now();
    const $ = load(html);

    const ofertas = [];

    $('[id="aod-offer"]').each((indice, elemento) => {
        const bloco = $(elemento);

        const offerId = bloco.find(
            'input[name="items[0.base][offerListingId]"]'
        ).first().attr("value");

        const vendidoPor = bloco.find(
            '[id="aod-offer-soldBy"]'
        ).first();

        const link = vendidoPor.find(
            'a[href*="seller="]'
        ).first();

        const vendedor = limpar(link.text()) ||
            limpar(
                vendidoPor.find(".a-col-right > span")
                    .first().text()
            );

        const precoArea = bloco.find(
            '[id="aod-offer-price"]'
        ).first();

        const reais = precoArea.find(
            ".apex-pricetopay-value .a-price-whole"
        ).first().text().replace(/\D/g, "");

        const centavos = precoArea.find(
            ".apex-pricetopay-value .a-price-fraction"
        ).first().text().replace(/\D/g, "");

        const precoCentavos =
            reais && /^\d{2}$/.test(centavos)
                ? Number(reais) * 100 + Number(centavos)
                : null;

        const acao = bloco.find(
            "[data-aod-atc-action]"
        ).first().attr("data-aod-atc-action");

        let maxQty = null;

        try {
            const dados = JSON.parse(acao || "{}");
            maxQty = Number.isInteger(dados.maxQty)
                ? dados.maxQty
                : null;
        } catch {}

        if (!offerId || !vendedor || precoCentavos === null) {
            throw new Error(
                `Oferta inválida na posição ${indice + 1}`
            );
        }

        ofertas.push({
            offerId,
            vendedor,
            precoCentavos,
            maxQty
        });
    });

    metricas.temposParser.push(
        performance.now() - inicio
    );

    atualizarMemoria();

    return {
        ofertas,
        totalInformado: Number(
            $("#aod-total-offer-count").val()
        ) || null
    };
}

// ========================================
// CONSULTAR PÁGINA DO SERVIDOR LOCAL
// ========================================

async function consultarPagina(baseURL, produto, pagina) {
    const inicio = performance.now();

    const url = (
        `${baseURL}/produto/${produto}/pagina/${pagina}`
    );

    const resposta = await fetch(url, {
        signal: AbortSignal.timeout(10000)
    });

    const html = await resposta.text();

    metricas.requisicoes++;
    metricas.bytes += Buffer.byteLength(html);
    metricas.latencias.push(performance.now() - inicio);

    if (!resposta.ok) {
        throw new Error(`HTTP ${resposta.status}`);
    }

    return analisarPagina(html);
}

// ========================================
// VERIFICAÇÃO COMPLETA DE UM PRODUTO
// ========================================

async function verificarProduto(baseURL, produto) {
    const ofertas = new Map();
    let totalInformado = null;

    for (let pagina = 1; pagina <= PAGINAS; pagina++) {
        const resultado = await consultarPagina(
            baseURL,
            produto,
            pagina
        );

        if (pagina === 1) {
            totalInformado = resultado.totalInformado;
        }

        for (const oferta of resultado.ofertas) {
            ofertas.set(oferta.offerId, oferta);
        }
    }

    const esperado = PAGINAS * 10;

    if (
        totalInformado !== esperado ||
        ofertas.size !== esperado
    ) {
        throw new Error(
            `Cobertura incorreta: ${ofertas.size}/${esperado}`
        );
    }

    metricas.verificacoes++;
    atualizarMemoria();
}

// ========================================
// FILA DE CONCORRÊNCIA LIMITADA
// ========================================

async function executarFila(itens, limite, executar) {
    let proximo = 0;

    const trabalhadores = Array.from(
        { length: Math.min(limite, itens.length) },
        async () => {
            while (true) {
                const indice = proximo++;

                if (indice >= itens.length) {
                    return;
                }

                try {
                    await executar(itens[indice]);
                } catch (erro) {
                    metricas.erros.push({
                        item: itens[indice],
                        mensagem: erro.message
                    });
                }
            }
        }
    );

    await Promise.all(trabalhadores);
}

// ========================================
// EXECUTAR TESTE DE CARGA
// ========================================

async function executarTeste(baseURL) {
    const produtos = Array.from(
        { length: PRODUTOS },
        (_, i) => String(i + 1).padStart(2, "0")
    );

    const inicioGlobal = performance.now();

    for (let ciclo = 0; ciclo < CICLOS; ciclo++) {
        const horarioEsperado = (
            inicioGlobal + ciclo * INTERVALO_MS
        );

        const espera = horarioEsperado - performance.now();

        if (espera > 0) {
            await dormir(espera);
        }

        const atraso = Math.max(
            0,
            performance.now() - horarioEsperado
        );

        metricas.atrasos.push(atraso);

        const inicioCiclo = performance.now();

        await executarFila(
            produtos,
            CONCORRENCIA,
            produto => verificarProduto(baseURL, produto)
        );

        const duracaoCiclo = (
            performance.now() - inicioCiclo
        );

        metricas.duracoesCiclo.push(duracaoCiclo);

        const estado = duracaoCiclo <= INTERVALO_MS
            ? "OK"
            : "ATRASADO";

        console.log(
            `Ciclo ${String(ciclo + 1).padStart(2, "0")}` +
            `/${CICLOS} | ${duracaoCiclo.toFixed(0)} ms` +
            ` | ${estado} | Erros: ${metricas.erros.length}`
        );
    }
}

// ========================================
// RELATÓRIO
// ========================================

function relatorio() {
    const esperadoVerificacoes = PRODUTOS * CICLOS;

    const esperadoRequisicoes = (
        esperadoVerificacoes * PAGINAS
    );

    const maiorCiclo = Math.max(
        ...metricas.duracoesCiclo
    );

    const maiorAtraso = Math.max(
        ...metricas.atrasos
    );

    const aprovado = (
        metricas.erros.length === 0 &&
        metricas.verificacoes === esperadoVerificacoes &&
        metricas.requisicoes === esperadoRequisicoes &&
        maiorCiclo <= INTERVALO_MS &&
        maiorAtraso < 1000
    );

    console.log("\n========== RELATÓRIO FINAL ==========");

    console.table({
        produtos: PRODUTOS,
        paginasPorProduto: PAGINAS,
        intervaloProdutoSegundos: INTERVALO_MS / 1000,
        ciclos: CICLOS,
        verificacoesEsperadas: esperadoVerificacoes,
        verificacoesConcluidas: metricas.verificacoes,
        requisicoesEsperadas: esperadoRequisicoes,
        requisicoesRealizadas: metricas.requisicoes,
        requisicoesPorMinutoPlanejadas:
            esperadoRequisicoes / (DURACAO / 60),
        erros: metricas.erros.length,
        latenciaP50ms:
            Math.round(percentil(metricas.latencias, 0.5)),
        latenciaP95ms:
            Math.round(percentil(metricas.latencias, 0.95)),
        parserP95ms:
            Math.round(percentil(metricas.temposParser, 0.95)),
        maiorCicloMs: Math.round(maiorCiclo),
        maiorAtrasoMs: Math.round(maiorAtraso),
        memoriaPicoMB:
            (metricas.picoMemoria / 1048576).toFixed(1),
        dadosTransferidosMB:
            (metricas.bytes / 1048576).toFixed(1)
    });

    if (metricas.erros.length) {
        console.log("\nErros:");
        console.table(metricas.erros.slice(0, 10));
    }

    console.log(
        aprovado
            ? "\nTESTE LOCAL APROVADO!"
            : "\nTESTE LOCAL REPROVADO OU INCONCLUSIVO."
    );

    return aprovado;
}

// ========================================
// EXECUÇÃO PRINCIPAL
// ========================================

let servidor = null;

try {
    console.log("\n=== TESTE DE CARGA LOCAL ===");
    console.log("Nenhuma requisição será enviada à Amazon.\n");

    const modelos = await carregarModelos();
    const respostas = gerarRespostas(modelos);

    const local = await iniciarServidor(respostas);
    servidor = local.servidor;

    console.log("\nConfiguração:");
    console.table({
        produtos: PRODUTOS,
        paginas: PAGINAS,
        duracaoSegundos: DURACAO,
        concorrencia: CONCORRENCIA,
        intervaloSegundos: INTERVALO_MS / 1000,
        latenciaSimuladaMs: LATENCIA_SIMULADA_MS
    });

    console.log("\n=== EXECUTANDO CICLOS ===");

    await executarTeste(local.baseURL);

    const aprovado = relatorio();

    if (!aprovado) {
        process.exitCode = 1;
    }

} catch (erro) {
    console.error("\nERRO:", erro.message);
    process.exitCode = 1;

} finally {
    if (servidor) {
        await new Promise(resolve => {
            servidor.close(resolve);
        });
    }
}
