
import puppeteer from "./cepo-puppeteer-runtime/src/puppeteer-runtime.js";

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ==================================================
// CONFIGURACOES
// ==================================================

const DURACAO_MS = 5 * 60 * 1000;
const INTERVALO_MS = 60 * 1000;
const TIMEOUT_MS = 20000;

const CONCORRENCIA = Math.min(
    3,
    Math.max(
        1,
        Number.parseInt(process.env.ML_CONCORRENCIA || "3", 10) || 3
    )
);

const SALVAR_HTML = false;

const ORIGEM_PRODUTO = "https://produto.mercadolivre.com.br";
const ORIGEM_CATALOGO = "https://www.mercadolivre.com.br";

const VENDEDOR_ESPERADO = "768826009";

// ==================================================
// PRODUTOS
// ==================================================

const PRODUTOS = [
    {
        id: "MLB5214725509",
        nome: "Moltres_Mini",
        tipo: "produto"
    },
    {
        id: "MLB5214725529",
        nome: "Night",
        tipo: "produto"
    },
    {
        id: "MLB5214725539",
        nome: "Nigh_Pika",
        tipo: "produto"
    },
    {
        id: "MLB5214725541",
        nome: "Mini_5541",
        tipo: "produto"
    },
    {
        id: "MLB5214725543",
        nome: "Mini_5543",
        tipo: "produto"
    },
    {
        id: "MLB5214725553",
        nome: "Espeon",
        tipo: "produto"
    },
    {
        id: "MLB5214725555",
        nome: "Produto_5555",
        tipo: "produto"
    },
    {
        id: "MLB5214725545",
        nome: "Greninja_Night",
        tipo: "catalogo",
        catalogo: "MLB2123122684",
        url: "https://www.mercadolivre.com.br/pokemon-tcg-30th-mini-tin-greninja-night-ingles/p/MLB2123122684?pdp_filters=item_id%3AMLB5483907791"
    },
    {
        id: "MLB5276063543",
        nome: "Pitch_Black",
        tipo: "catalogo",
        catalogo: "MLB76489730",
        url: "https://www.mercadolivre.com.br/pokemontcg-megaevolution-pitch-black-booster-bundle-ingles/p/MLB76489730?pdp_filters=item_id%3AMLB5276063543"
    },
    {
        id: "MLB6823331442",
        nome: "Toxel",
        tipo: "catalogo",
        catalogo: "MLB69735015",
        url: "https://www.mercadolivre.com.br/pokemon-me04-caos-ascendente-blister-quadruplo-toxel-4-boosters-copag/p/MLB69735015?pdp_filters=item_id%3AMLB6823331442"
    }
];

for (const produto of PRODUTOS) {
    if (produto.tipo === "produto") {
        const numero = produto.id.replace("MLB", "");

        produto.url = `${ORIGEM_PRODUTO}/MLB-${numero}-_JM`;
    }
}

const TRADICIONAIS = PRODUTOS.filter(
    produto => produto.tipo === "produto"
);

const CATALOGOS = PRODUTOS.filter(
    produto => produto.tipo === "catalogo"
);

// ==================================================
// EDGE E PERFIL DO CEPO
// ==================================================

function localizarEdge() {
    const candidatos = [
        process.env.CEPO_EDGE_EXECUTABLE,

        ...[
            process.env["ProgramFiles(x86)"],
            process.env.ProgramFiles,
            process.env.LOCALAPPDATA
        ]
            .filter(Boolean)
            .map(raiz =>
                join(
                    raiz,
                    "Microsoft",
                    "Edge",
                    "Application",
                    "msedge.exe"
                )
            )
    ].filter(Boolean);

    return candidatos.find(caminho =>
        existsSync(caminho)
    );
}

async function obterPerfil() {
    if (process.platform !== "win32" || !process.env.APPDATA) {
        throw new Error("Este teste requer Windows.");
    }

    const ambiente = "CEPO-Agent-homolog";

    const raiz = join(process.env.APPDATA, ambiente);

    const config = JSON.parse(
        await readFile(
            join(raiz, "coupon-validator-profile.json"),
            "utf8"
        )
    );

    const userDataDir = join(
        raiz,
        "edge-profile-coupon-validator"
    );

    if (
        config.schemaVersion !== 2 ||
        config.configured !== true ||
        config.profileDirectory !== "Default" ||
        !existsSync(join(userDataDir, "Default"))
    ) {
        throw new Error(
            "Perfil do validador CEPO nao configurado."
        );
    }

    return {
        ambiente,
        userDataDir,
        profileDirectory: config.profileDirectory
    };
}

async function verificarPerfilLivre(userDataDir) {
    const powershell = join(
        process.env.SystemRoot || "C:/Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
    );

    const script = [
        "$ErrorActionPreference='Stop'",
        "$target=$env:CEPO_COUPON_PROFILE_TARGET",
        "$processes=Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='CEPO Agent.exe'\"",
        "foreach($p in $processes){if($p.Name -eq 'CEPO Agent.exe' -or -not $p.CommandLine -or $p.CommandLine.IndexOf($target,[StringComparison]::OrdinalIgnoreCase) -ge 0){exit 10}}"
    ].join("; ");

    try {
        await promisify(execFile)(
            powershell,
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script
            ],
            {
                windowsHide: true,
                timeout: 10000,
                env: {
                    ...process.env,
                    CEPO_COUPON_PROFILE_TARGET: userDataDir
                }
            }
        );

    } catch (erro) {
        if (erro.code === 10) {
            throw new Error(
                "Feche o CEPO Agent e o Edge desse perfil."
            );
        }

        throw new Error(
            "Nao foi possivel confirmar que o perfil esta livre.",
            { cause: erro }
        );
    }
}

// ==================================================
// UTILITARIOS
// ==================================================

function origemDe(url) {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

function exigeVerificacao(url) {
    if (!url) return false;

    try {
        const caminho = new URL(url).pathname.toLowerCase();

        return (
            caminho.includes("account-verification") ||
            caminho.includes("captcha") ||
            caminho.includes("challenge")
        );
    } catch {
        return false;
    }
}

async function aguardarAte(horario, deveParar) {
    while (!deveParar() && Date.now() < horario) {
        const restante = horario - Date.now();

        await new Promise(resolve =>
            setTimeout(resolve, Math.min(1000, restante))
        );
    }
}

function contarClassificacoes(consultas) {
    const contagem = {};

    for (const consulta of consultas) {
        const chave =
            consulta.disponibilidade ??
            consulta.resultado;

        contagem[chave] = (contagem[chave] || 0) + 1;
    }

    return contagem;
}

// ==================================================
// PARSER NORDIC
// ==================================================

function extrairEstado(html) {
    const match = html.match(
        /<script\b(?=[^>]*\bid=["']__NORDIC_RENDERING_CTX__["'])[^>]*>([\s\S]*?)<\/script\s*>/i
    );

    if (!match) {
        throw new Error("NORDIC_RENDERING_CTX ausente");
    }

    const script = match[1];

    const inicio = /_n\.ctx\.r\s*=\s*\{/.exec(script);

    if (!inicio) {
        throw new Error("Objeto Nordic nao encontrado");
    }

    const posicaoInicial = script.indexOf(
        "{",
        inicio.index
    );

    let nivel = 0;
    let dentroString = false;
    let escapado = false;
    let fim = -1;

    for (let i = posicaoInicial; i < script.length; i++) {
        const c = script[i];

        if (dentroString) {
            if (escapado) {
                escapado = false;
            } else if (c === "\\") {
                escapado = true;
            } else if (c === '"') {
                dentroString = false;
            }

            continue;
        }

        if (c === '"') {
            dentroString = true;
        } else if (c === "{") {
            nivel++;
        } else if (c === "}") {
            nivel--;

            if (nivel === 0) {
                fim = i + 1;
                break;
            }
        }
    }

    if (fim === -1) {
        throw new Error("JSON Nordic incompleto");
    }

    const dados = JSON.parse(
        script.slice(posicaoInicial, fim)
    );

    const estado = dados.appProps?.pageProps?.initialState;

    if (!estado) {
        throw new Error("initialState ausente");
    }

    const tracking =
        estado.track?.melidata_event?.event_data ??
        estado.components?.track?.melidata_event?.event_data ??
        {};

    return {
        idPagina: estado.id ?? null,
        layout: estado.layout ?? null,
        idOferta: tracking.item_id ?? null,
        vendedor: tracking.seller_id ?? null,
        lojaOficial: tracking.official_store_id ?? null,
        status: tracking.item_status ?? null,
        hasStock: tracking.has_stock ?? null,
        quantidade: tracking.quantity ?? null,
        inativo: estado.no_active_item ?? null,
        preco: tracking.price ?? null
    };
}

// ==================================================
// CLASSIFICACAO COM IDENTIDADE
// ==================================================

function classificar(produto, estado) {
    const idsPermitidos = [
        produto.id,
        produto.catalogo
    ].filter(Boolean);

    if (
        estado.idPagina == null ||
        !idsPermitidos.includes(String(estado.idPagina))
    ) {
        return "identity_mismatch";
    }

    if (estado.idOferta == null || estado.vendedor == null) {
        return "unknown_identity";
    }

    if (
        String(estado.idOferta) !== produto.id ||
        String(estado.vendedor) !== VENDEDOR_ESPERADO
    ) {
        return "identity_mismatch";
    }

    if (
        estado.inativo === true ||
        (
            estado.status != null &&
            estado.status !== "active"
        ) ||
        estado.hasStock === false
    ) {
        return "unavailable";
    }

    if (estado.hasStock === true) {
        return "available";
    }

    return "unknown";
}

// ==================================================
// BOOTSTRAP DE UMA ABA
// ==================================================

async function prepararAba(
    browser,
    nome,
    url,
    origemEsperada,
    exigirNordic
) {
    const page = await browser.newPage();

    const inicio = performance.now();

    try {
        const resposta = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: TIMEOUT_MS
        });

        const http = resposta?.status() ?? null;
        const urlFinal = page.url();

        const temNordic = exigirNordic
            ? await page.evaluate(() =>
                Boolean(
                    document.querySelector(
                        "#__NORDIC_RENDERING_CTX__"
                    )
                )
            )
            : null;

        const verificacao = exigeVerificacao(urlFinal);
        const origemValida =
            origemDe(urlFinal) === origemEsperada;

        const pronto =
            http === 200 &&
            origemValida &&
            !verificacao &&
            (!exigirNordic || temNordic);

        const motivo = verificacao
            ? "verificacao_requerida"
            : !origemValida
                ? "origem_divergente"
                : http !== 200
                    ? "http_" + http
                    : exigirNordic && !temNordic
                        ? "nordic_ausente"
                        : "ok";

        const resultado = {
            page,
            nome,
            http,
            urlFinal,
            tempoMs: Math.round(
                performance.now() - inicio
            ),
            pronto,
            motivo
        };

        console.log(
            `[BOOTSTRAP ${nome}]`,
            JSON.stringify({
                http,
                urlFinal,
                tempoMs: resultado.tempoMs,
                pronto,
                motivo
            })
        );

        return resultado;

    } catch (erro) {
        console.error(
            `[BOOTSTRAP ${nome}]`,
            erro.message
        );

        return {
            page,
            nome,
            http: null,
            urlFinal: page.url(),
            pronto: false,
            motivo: "erro_bootstrap",
            erro: erro.message
        };
    }
}

// ==================================================
// CONSULTA TRADICIONAL - FETCH PARALELO
// ==================================================

async function consultarProduto(page, produto) {
    const inicio = performance.now();

    const resultado = await page.evaluate(
        async ({ url, timeoutMs }) => {
            const controller = new AbortController();

            const timer = setTimeout(
                () => controller.abort(),
                timeoutMs
            );

            const inicioFetch = performance.now();

            let etapa = "iniciando";
            let http = null;
            let urlFinal = null;

            try {
                if (new URL(url).origin !== location.origin) {
                    return {
                        erro: "origem_incorreta",
                        etapa: "validacao_origem"
                    };
                }

                etapa = "aguardando_resposta";

                const resposta = await fetch(url, {
                    method: "GET",
                    credentials: "same-origin",
                    redirect: "follow",
                    cache: "no-store",
                    signal: controller.signal
                });

                http = resposta.status;
                urlFinal = resposta.url;

                etapa = "lendo_html";

                const html = resposta.ok
                    ? await resposta.text()
                    : null;

                etapa = "concluido";

                return {
                    http,
                    urlFinal,
                    html,
                    etapa,
                    redirect: resposta.redirected,
                    tempoFetchMs: Math.round(
                        performance.now() - inicioFetch
                    )
                };

            } catch (erro) {
                return {
                    http,
                    urlFinal,
                    html: null,
                    etapa,
                    timeout: controller.signal.aborted,
                    erro: erro.name + ": " + erro.message,
                    tempoFetchMs: Math.round(
                        performance.now() - inicioFetch
                    )
                };

            } finally {
                clearTimeout(timer);
            }
        },
        {
            url: produto.url,
            timeoutMs: TIMEOUT_MS
        }
    );

    return {
        ...resultado,
        metodo: "fetch",
        tempoMs: Math.round(
            performance.now() - inicio
        )
    };
}

// ==================================================
// CONSULTA CATALOGO - NAVEGACAO SEQUENCIAL
// ==================================================

async function consultarCatalogo(page, produto) {
    const inicio = performance.now();

    let etapa = "navegando";
    let http = null;
    let urlFinal = null;

    try {
        const resposta = await page.goto(produto.url, {
            waitUntil: "domcontentloaded",
            timeout: TIMEOUT_MS
        });

        http = resposta?.status() ?? null;
        urlFinal = page.url();

        // Nao ler o HTML de paginas bloqueadas.
        if (
            http !== 200 ||
            exigeVerificacao(urlFinal)
        ) {
            return {
                metodo: "page.goto",
                http,
                urlFinal,
                etapa,
                html: null,
                tempoMs: Math.round(
                    performance.now() - inicio
                )
            };
        }

        etapa = "lendo_html";

        const html = await page.content();

        etapa = "concluido";

        return {
            metodo: "page.goto",
            http,
            urlFinal,
            etapa,
            html,
            tempoMs: Math.round(
                performance.now() - inicio
            )
        };

    } catch (erro) {
        return {
            metodo: "page.goto",
            http,
            urlFinal: page.url(),
            etapa,
            erro: erro.name + ": " + erro.message,
            timeout: erro.name === "TimeoutError",
            html: null,
            tempoMs: Math.round(
                performance.now() - inicio
            )
        };
    }
}

// ==================================================
// EXECUCAO PRINCIPAL
// ==================================================

async function executar() {
    const executavel = localizarEdge();

    if (!executavel) {
        throw new Error("Microsoft Edge nao encontrado.");
    }

    const perfil = await obterPerfil();

    await verificarPerfilLivre(perfil.userDataDir);

    const pasta = join(
        process.cwd(),
        "ml-persistente-v2-" +
        new Date().toISOString().replace(/[:.]/g, "-")
    );

    await mkdir(pasta, { recursive: true });

    console.log("\n=== CONFIGURACAO ===");

    console.table({
        Navegador: executavel,
        Perfil: perfil.ambiente,
        Headless: false,
        DuracaoSegundos: DURACAO_MS / 1000,
        IntervaloSegundos: INTERVALO_MS / 1000,
        ConcorrenciaProduto: CONCORRENCIA,
        ProdutosTradicionais: TRADICIONAIS.length,
        ProdutosCatalogo: CATALOGOS.length,
        Abas: 2
    });

    console.log("Pasta:", pasta);

    const relatorio = [];
    const rodadas = [];
    const bootstrap = [];

    let browser = null;
    let interrompido = false;
    let motivoParada = null;

    let picoConcorrencia = 0;
    let emAndamento = 0;

    let inicioMonitor = null;
    let fimMonitor = null;

    const inicioGeral = performance.now();

    function solicitarParada(motivo) {
        if (interrompido) return;

        interrompido = true;
        motivoParada = motivo;

        console.warn(
            "\nPARADA SOLICITADA:",
            motivo
        );
    }

    const aoPressionarCtrlC = () => {
        solicitarParada("interrompido_pelo_usuario");
    };

    process.on("SIGINT", aoPressionarCtrlC);

    async function salvarProgresso() {
        const dados = {
            atualizadoEm: new Date().toISOString(),
            iniciadoEm: inicioMonitor
                ? new Date(inicioMonitor).toISOString()
                : null,
            interrompido,
            motivoParada,
            bootstrap,
            rodadas,
            consultas: relatorio
        };

        await writeFile(
            join(pasta, "progresso.json"),
            JSON.stringify(dados, null, 2),
            "utf8"
        );
    }

    // ----------------------------------------------
    // PROCESSAR RESPOSTA
    // ----------------------------------------------

    async function processarResposta(
        produto,
        resposta,
        rodada
    ) {
        const registro = {
            rodada,
            horario: new Date().toISOString(),
            id: produto.id,
            nome: produto.nome,
            tipo: produto.tipo,
            metodo: resposta.metodo,
            urlSolicitada: produto.url,
            urlFinal: resposta.urlFinal ?? null,
            http: resposta.http ?? null,
            etapa: resposta.etapa ?? null,
            tempoMs: resposta.tempoMs ?? null,
            tempoFetchMs: resposta.tempoFetchMs ?? null,
            timeout: resposta.timeout ?? false
        };

        if (exigeVerificacao(resposta.urlFinal)) {
            registro.resultado = "verificacao_requerida";
            solicitarParada("verificacao_requerida");

        } else if (
            resposta.http === 403 ||
            resposta.http === 429
        ) {
            registro.resultado = "acesso_restrito";
            solicitarParada("http_" + resposta.http);

        } else if (resposta.timeout) {
            registro.resultado = "timeout";
            registro.erro = resposta.erro;
            solicitarParada("timeout");

        } else if (resposta.erro) {
            registro.resultado = "erro_rede";
            registro.erro = resposta.erro;
            solicitarParada("erro_rede");

        } else if (resposta.http !== 200) {
            registro.resultado = "http_inesperado";
            solicitarParada("http_" + resposta.http);

        } else {
            const origemEsperada = produto.tipo === "produto"
                ? ORIGEM_PRODUTO
                : ORIGEM_CATALOGO;

            if (
                origemDe(resposta.urlFinal) !== origemEsperada
            ) {
                registro.resultado = "origem_divergente";
                solicitarParada("origem_divergente");

            } else if (!resposta.html) {
                registro.resultado = "html_vazio";
                solicitarParada("html_vazio");

            } else {
                registro.caracteres = resposta.html.length;

                try {
                    const estado = extrairEstado(
                        resposta.html
                    );

                    registro.parser = "ok";
                    registro.estado = estado;

                    registro.disponibilidade = classificar(
                        produto,
                        estado
                    );

                    registro.resultado = "html_recuperado";

                    if (SALVAR_HTML) {
                        const arquivo =
                            `r${rodada}_${produto.id}.html`;

                        await writeFile(
                            join(pasta, arquivo),
                            resposta.html,
                            "utf8"
                        );

                        registro.arquivo = arquivo;
                    }

                } catch (erro) {
                    registro.resultado = "erro_parser";
                    registro.erroParser = erro.message;

                    solicitarParada("erro_parser");
                }
            }
        }

        return registro;
    }

    // ----------------------------------------------
    // TRABALHADORES - PRODUTO
    // ----------------------------------------------

    async function executarTradicionais(page, rodada) {
        let proximo = 0;

        async function trabalhador(numero) {
            while (
                !interrompido &&
                proximo < TRADICIONAIS.length
            ) {
                const produto = TRADICIONAIS[proximo++];

                emAndamento++;
                picoConcorrencia = Math.max(
                    picoConcorrencia,
                    emAndamento
                );

                console.log(
                    `[R${rodada}] FETCH W${numero}: ${produto.id}`
                );

                try {
                    const resposta = await consultarProduto(
                        page,
                        produto
                    );

                    const registro = await processarResposta(
                        produto,
                        resposta,
                        rodada
                    );

                    relatorio.push(registro);

                    console.log(
                        produto.id,
                        registro.resultado,
                        registro.http ?? "-",
                        registro.disponibilidade ?? "-",
                        `${registro.tempoMs}ms`
                    );

                } catch (erro) {
                    relatorio.push({
                        rodada,
                        id: produto.id,
                        tipo: produto.tipo,
                        resultado: "erro_execucao",
                        erro: erro.message
                    });

                    solicitarParada("erro_execucao");

                } finally {
                    emAndamento--;
                }
            }
        }

        await Promise.all(
            Array.from(
                { length: CONCORRENCIA },
                (_, i) => trabalhador(i + 1)
            )
        );
    }

    // ----------------------------------------------
    // CONSULTAS SEQUENCIAIS - CATALOGO
    // ----------------------------------------------

    async function executarCatalogos(page, rodada) {
        for (const produto of CATALOGOS) {
            if (interrompido) break;

            console.log(
                `[R${rodada}] GOTO: ${produto.id}`
            );

            const resposta = await consultarCatalogo(
                page,
                produto
            );

            const registro = await processarResposta(
                produto,
                resposta,
                rodada
            );

            relatorio.push(registro);

            console.log(
                produto.id,
                registro.resultado,
                registro.http ?? "-",
                registro.disponibilidade ?? "-",
                `${registro.tempoMs}ms`
            );
        }
    }

    try {
        // ==========================================
        // INICIAR EDGE VISIVEL
        // ==========================================

        const launchOptions = {
            executablePath: executavel,
            userDataDir: perfil.userDataDir,
            timeout: 15000,
            args: [
                `--profile-directory=${perfil.profileDirectory}`,
                "--window-position=100,100",
                "--window-size=1280,900"
            ]
        };

        browser = await puppeteer.launch(
            launchOptions
        );

        console.log("\nEdge iniciado.");

        // ==========================================
        // BOOTSTRAP - DUAS ABAS
        // ==========================================

        const [abaProduto, abaCatalogo] =
            await Promise.all([
                prepararAba(
                    browser,
                    "produto",
                    TRADICIONAIS[0].url,
                    ORIGEM_PRODUTO,
                    true
                ),
                prepararAba(
                    browser,
                    "catalogo",
                    ORIGEM_CATALOGO + "/",
                    ORIGEM_CATALOGO,
                    false
                )
            ]);

        for (const aba of [abaProduto, abaCatalogo]) {
            bootstrap.push({
                nome: aba.nome,
                http: aba.http,
                urlFinal: aba.urlFinal,
                pronto: aba.pronto,
                motivo: aba.motivo,
                tempoMs: aba.tempoMs
            });
        }

        if (
            !abaProduto.pronto ||
            !abaCatalogo.pronto
        ) {
            solicitarParada("bootstrap_failed");

        } else {
            console.log(
                "\nBootstrap concluido. " +
                "Iniciando teste persistente."
            );

            inicioMonitor = Date.now();
            fimMonitor = inicioMonitor + DURACAO_MS;

            const totalRodadas = Math.ceil(
                DURACAO_MS / INTERVALO_MS
            );

            // ======================================
            // RODADAS
            // ======================================

            for (
                let rodada = 1;
                rodada <= totalRodadas && !interrompido;
                rodada++
            ) {
                const horarioPrevisto =
                    inicioMonitor +
                    (rodada - 1) * INTERVALO_MS;

                await aguardarAte(
                    horarioPrevisto,
                    () => interrompido
                );

                if (
                    interrompido ||
                    Date.now() >= fimMonitor
                ) {
                    break;
                }

                console.log(
                    `\n========== RODADA ${rodada}/${totalRodadas} ==========`
                );

                const inicioRodada = performance.now();
                const horarioInicio = new Date().toISOString();

                // Confirma que a aba de fetch
                // continua na origem correta.
                const estadoAba = await abaProduto.page.evaluate(
                    () => ({
                        url: location.href,
                        origem: location.origin,
                        visibilidade: document.visibilityState
                    })
                );

                console.log(
                    "[ABA PRODUTO]",
                    JSON.stringify(estadoAba)
                );

                if (
                    estadoAba.origem !== ORIGEM_PRODUTO ||
                    exigeVerificacao(estadoAba.url)
                ) {
                    solicitarParada("aba_produto_invalida");
                    break;
                }

                // 1. Sete fetches com concorrencia 3.
                await executarTradicionais(
                    abaProduto.page,
                    rodada
                );

                // 2. Tres navegacoes sequenciais.
                // Comecam apenas se a primeira
                // etapa terminou sem restricoes.
                if (!interrompido) {
                    await executarCatalogos(
                        abaCatalogo.page,
                        rodada
                    );
                }

                const resultadosRodada = relatorio.filter(
                    item => item.rodada === rodada
                );

                const recuperados = resultadosRodada.filter(
                    item => item.resultado === "html_recuperado"
                ).length;

                const falhas =
                    resultadosRodada.length - recuperados;

                const tempoMs = Math.round(
                    performance.now() - inicioRodada
                );

                const resumo = {
                    rodada,
                    inicio: horarioInicio,
                    fim: new Date().toISOString(),
                    tempoMs,
                    consultas: resultadosRodada.length,
                    recuperados,
                    falhas,
                    classificacoes: contarClassificacoes(
                        resultadosRodada
                    )
                };

                rodadas.push(resumo);

                await salvarProgresso();

                console.log(
                    `\n=== RESUMO RODADA ${rodada} ===`
                );

                console.table({
                    Consultas: resumo.consultas,
                    Recuperados: resumo.recuperados,
                    Falhas: resumo.falhas,
                    TempoMs: resumo.tempoMs
                });

                console.log(
                    "Classificacoes:",
                    resumo.classificacoes
                );

                if (!interrompido) {
                    console.log(
                        "Rodada concluida. " +
                        "Edge e abas preservados."
                    );
                }
            }

            // Mantem o browser ate completar
            // cinco minutos de observacao.
            if (!interrompido) {
                await aguardarAte(
                    fimMonitor,
                    () => interrompido
                );
            }
        }

    } catch (erro) {
        solicitarParada("falha_geral");

        console.error(
            "Falha geral:",
            erro.stack ?? erro.message
        );

    } finally {
        // ==========================================
        // ENCERRAMENTO
        // ==========================================

        if (browser) {
            try {
                await browser.close();

                console.log("\nEdge encerrado.");

            } catch (erro) {
                console.error(
                    "Erro ao encerrar Edge:",
                    erro.message
                );
            }
        }

        const tempoTotalMs = Math.round(
            performance.now() - inicioGeral
        );

        const completos = relatorio.filter(
            item => item.resultado === "html_recuperado"
        ).length;

        const rodadasPrevistas = Math.ceil(
            DURACAO_MS / INTERVALO_MS
        );

        const consultasEsperadas =
            PRODUTOS.length * rodadasPrevistas;

        const testeCompleto =
            !interrompido &&
            rodadas.length === rodadasPrevistas &&
            completos === consultasEsperadas;

        const resultadoFinal = {
            geradoEm: new Date().toISOString(),
            navegador: executavel,
            perfil: perfil.ambiente,

            duracaoConfiguradaMs: DURACAO_MS,
            intervaloMs: INTERVALO_MS,
            tempoTotalMs,

            inicioMonitor: inicioMonitor
                ? new Date(inicioMonitor).toISOString()
                : null,

            concorrenciaProduto: CONCORRENCIA,
            picoConcorrencia,

            rodadasPrevistas,
            rodadasExecutadas: rodadas.length,

            produtosPorRodada: PRODUTOS.length,
            consultasEsperadas,
            consultasRealizadas: relatorio.length,
            htmlsRecuperados: completos,

            interrompido,
            motivoParada,
            testeCompleto,

            bootstrap,
            rodadas,
            classificacoesGerais:
                contarClassificacoes(relatorio),

            consultas: relatorio
        };

        try {
            await writeFile(
                join(pasta, "relatorio.json"),
                JSON.stringify(resultadoFinal, null, 2),
                "utf8"
            );

            console.log(
                "\nRelatorio salvo:",
                join(pasta, "relatorio.json")
            );

        } catch (erro) {
            console.error(
                "Erro ao salvar relatorio:",
                erro.message
            );

            process.exitCode = 1;
        }

        console.log(
            "\n========== RESULTADO FINAL =========="
        );

        console.table(
            rodadas.map(item => ({
                Rodada: item.rodada,
                Consultas: item.consultas,
                Recuperados: item.recuperados,
                Falhas: item.falhas,
                TempoMs: item.tempoMs
            }))
        );

        console.log("\nRESUMO GERAL");

        console.table({
            Rodadas: rodadas.length,
            Consultas: relatorio.length,
            HTMLs: `${completos}/${consultasEsperadas}`,
            PicoConcorrencia: picoConcorrencia,
            TempoTotalMs: tempoTotalMs,
            Interrompido: interrompido,
            MotivoParada: motivoParada ?? "-",
            TesteCompleto: testeCompleto
        });

        console.log(
            "\nClassificacoes:",
            resultadoFinal.classificacoesGerais
        );

        if (testeCompleto) {
            console.log(
                "\nSUCESSO: teste persistente concluido."
            );

        } else {
            console.warn(
                "\nTeste nao concluido integralmente."
            );

            process.exitCode ||= 1;
        }

        process.removeListener(
            "SIGINT",
            aoPressionarCtrlC
        );
    }
}

executar().catch(erro => {
    console.error(
        "Falha inicial:",
        erro.stack ?? erro.message
    );

    process.exitCode = 1;
});
