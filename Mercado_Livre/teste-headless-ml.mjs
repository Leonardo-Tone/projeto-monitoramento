
import puppeteer from "./cepo-puppeteer-runtime/src/puppeteer-runtime.js";

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ==================================================
// CONFIGURACOES
// ==================================================

const HEADLESS = process.argv.includes("--headless");

const CONCORRENCIA = Math.min(
    10,
    Math.max(1, Number(process.env.ML_CONCORRENCIA || 3))
);

const TIMEOUT_MS = 20000;
const DURACAO_MS = 5 * 60 * 1000;
const INTERVALO_MS = 60 * 1000;

const SALVAR_HTML = false;

const ORIGEM = "https://produto.mercadolivre.com.br";
const VENDEDOR_ESPERADO = "768826009";

// ==================================================
// PRODUTOS - TODOS NO DOMINIO PRODUTO
// ==================================================

const PRODUTOS = [
    {
        id: "MLB5214725509",
        nome: "Moltres_Mini"
    },
    {
        id: "MLB5214725529",
        nome: "Night"
    },
    {
        id: "MLB5214725539",
        nome: "Nigh_Pika"
    },
    {
        id: "MLB5214725541",
        nome: "Mini_5541"
    },
    {
        id: "MLB5214725543",
        nome: "Mini_5543"
    },
    {
        id: "MLB5214725553",
        nome: "Espeon"
    },
    {
        id: "MLB5214725555",
        nome: "Produto_5555"
    },
    {
        id: "MLB5214725545",
        nome: "Greninja_Night",
        catalogo: "MLB2123122684"
    },
    {
        id: "MLB5276063543",
        nome: "Pitch_Black",
        catalogo: "MLB76489730"
    },
    {
        id: "MLB6823331442",
        nome: "Toxel",
        catalogo: "MLB69735015"
    }
];

for (const produto of PRODUTOS) {
    const numero = produto.id.replace("MLB", "");

    produto.url = `${ORIGEM}/MLB-${numero}-_JM`;
}

// ==================================================
// PERFIL CEPO
// ==================================================

async function obterPerfilAutenticado() {
    if (process.platform !== "win32" || !process.env.APPDATA) {
        throw new Error(
            "O perfil do CEPO requer Windows e APPDATA."
        );
    }

    const ambiente = process.argv.includes("--cepo-producao")
        ? "CEPO Agent"
        : "CEPO-Agent-homolog";

    const raizAgent = join(process.env.APPDATA, ambiente);

    const config = JSON.parse(
        await readFile(
            join(raizAgent, "coupon-validator-profile.json"),
            "utf8"
        )
    );

    const userDataDir = join(
        raizAgent,
        "edge-profile-coupon-validator"
    );

    if (
        config.schemaVersion !== 2 ||
        config.configured !== true ||
        config.profileDirectory !== "Default" ||
        !existsSync(join(userDataDir, "Default"))
    ) {
        throw new Error(
            "Perfil autenticado do CEPO nao configurado."
        );
    }

    return {
        ambiente,
        userDataDir,
        profileDirectory: config.profileDirectory
    };
}

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
        /(?:^|[\\/])msedge\.exe$/i.test(caminho) &&
        existsSync(caminho)
    );
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
                "Feche os Agents e o Edge do perfil CEPO."
            );
        }

        throw new Error(
            "Nao foi possivel confirmar se o perfil esta livre.",
            { cause: erro }
        );
    }
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

    const posicaoInicial = script.indexOf("{", inicio.index);

    let nivel = 0;
    let dentroString = false;
    let escapado = false;
    let fim = -1;

    for (let i = posicaoInicial; i < script.length; i++) {
        const caractere = script[i];

        if (dentroString) {
            if (escapado) {
                escapado = false;
            } else if (caractere === "\\") {
                escapado = true;
            } else if (caractere === '"') {
                dentroString = false;
            }

            continue;
        }

        if (caractere === '"') {
            dentroString = true;
        } else if (caractere === "{") {
            nivel++;
        } else if (caractere === "}") {
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
// CLASSIFICACAO SEGURA
// ==================================================

function classificar(produto, estado) {
    const idsPaginaPermitidos = [
        produto.id,
        produto.catalogo
    ].filter(Boolean);

    if (
        !estado.idPagina ||
        !idsPaginaPermitidos.includes(String(estado.idPagina))
    ) {
        return "identity_mismatch";
    }

    // A identidade comercial precisa estar presente
    // antes de declarar a oferta disponivel.
    if (!estado.idOferta || estado.vendedor == null) {
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
        )
    ) {
        return "unavailable";
    }

    if (estado.hasStock === false) {
        return "unavailable";
    }

    if (estado.hasStock === true) {
        return "available";
    }

    return "unknown";
}

// ==================================================
// VALIDACOES
// ==================================================

function urlDeVerificacao(url) {
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

function origemCorreta(url) {
    try {
        return new URL(url).origin === ORIGEM;
    } catch {
        return false;
    }
}

// ==================================================
// BOOTSTRAP - UMA ABA
// ==================================================

async function prepararAba(browser) {
    const page = await browser.newPage();

    const inicio = performance.now();

    try {
        // Usa um anuncio real da propria lista.
        const resposta = await page.goto(PRODUTOS[0].url, {
            waitUntil: "domcontentloaded",
            timeout: TIMEOUT_MS
        });

        const http = resposta?.status() ?? null;
        const urlFinal = page.url();

        const estadoPagina = await page.evaluate(() => ({
            origem: location.origin,
            visibilidade: document.visibilityState,
            temNordic: !!document.querySelector(
                "#__NORDIC_RENDERING_CTX__"
            )
        }));

        const verificacao = urlDeVerificacao(urlFinal);

        const pronto =
            http === 200 &&
            origemCorreta(urlFinal) &&
            estadoPagina.temNordic &&
            !verificacao;

        const resultado = {
            page,
            http,
            urlFinal,
            tempoMs: Math.round(
                performance.now() - inicio
            ),
            pronto,
            visibilidade: estadoPagina.visibilidade,
            motivo: verificacao
                ? "verificacao_requerida"
                : !origemCorreta(urlFinal)
                    ? "origem_divergente"
                    : http !== 200
                        ? "http_" + http
                        : !estadoPagina.temNordic
                            ? "nordic_ausente"
                            : "ok"
        };

        console.log("\n[BOOTSTRAP]", JSON.stringify({
            http: resultado.http,
            urlFinal: resultado.urlFinal,
            tempoMs: resultado.tempoMs,
            pronto: resultado.pronto,
            visibilidade: resultado.visibilidade,
            motivo: resultado.motivo
        }));

        return resultado;

    } catch (erro) {
        const resultado = {
            page,
            http: null,
            urlFinal: page.url(),
            pronto: false,
            motivo: "erro_bootstrap",
            erro: erro.message
        };

        console.error("[BOOTSTRAP]", erro.message);

        return resultado;
    }
}

// ==================================================
// FETCH DENTRO DO EDGE
// ==================================================

async function consultar(page, produto) {
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
            let httpRecebido = null;
            let urlFinal = null;

            try {
                if (new URL(url).origin !== location.origin) {
                    return {
                        http: null,
                        html: null,
                        etapa: "validacao_origem",
                        erro: "origem_incorreta"
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

                httpRecebido = resposta.status;
                urlFinal = resposta.url;

                etapa = "lendo_html";

                const html = resposta.ok
                    ? await resposta.text()
                    : null;

                etapa = "concluido";

                return {
                    http: resposta.status,
                    urlFinal: resposta.url,
                    redirect: resposta.redirected,
                    tempoFetchMs: Math.round(
                        performance.now() - inicioFetch
                    ),
                    etapa,
                    timeout: false,
                    html
                };

            } catch (erro) {
                return {
                    http: httpRecebido,
                    urlFinal,
                    etapa,
                    timeout: controller.signal.aborted,
                    tempoFetchMs: Math.round(
                        performance.now() - inicioFetch
                    ),
                    erro: erro.name + ": " + erro.message,
                    html: null
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

    resultado.tempoTotalMs = Math.round(
        performance.now() - inicio
    );

    return resultado;
}

// ==================================================
// AUXILIARES
// ==================================================

async function aguardarAte(horario, deveParar) {
    while (!deveParar() && Date.now() < horario) {
        const restante = horario - Date.now();

        await new Promise(resolve =>
            setTimeout(
                resolve,
                Math.min(1000, restante)
            )
        );
    }
}

function contarClassificacoes(consultas) {
    const contagem = {};

    for (const consulta of consultas) {
        const tipo =
            consulta.disponibilidade ??
            consulta.resultado;

        contagem[tipo] = (contagem[tipo] ?? 0) + 1;
    }

    return contagem;
}

// ==================================================
// EXECUCAO PRINCIPAL
// ==================================================

async function executar() {
    const executavel = localizarEdge();

    if (!executavel) {
        throw new Error("Microsoft Edge nao encontrado.");
    }

    const perfil = await obterPerfilAutenticado();

    await verificarPerfilLivre(perfil.userDataDir);

    const pasta = join(
        process.cwd(),
        "ml-persistente-produto-" +
        new Date().toISOString().replace(/[:.]/g, "-")
    );

    await mkdir(pasta, { recursive: true });

    console.log("\n=== CONFIGURACAO ===");

    console.table({
        Navegador: executavel,
        Headless: HEADLESS,
        Perfil: perfil.ambiente,
        Origem: ORIGEM,
        Abas: 1,
        DuracaoSegundos: DURACAO_MS / 1000,
        IntervaloSegundos: INTERVALO_MS / 1000,
        Concorrencia: CONCORRENCIA,
        Produtos: PRODUTOS.length
    });

    console.log("Pasta:", pasta);

    const relatorio = [];
    const rodadas = [];

    let browser = null;
    let bootstrap = null;

    let interrompido = false;
    let motivoParada = null;

    let emAndamento = 0;
    let picoConcorrencia = 0;

    let inicioMonitor = null;
    let fimMonitor = null;

    const inicioGeral = performance.now();

    function solicitarParada(motivo) {
        if (interrompido) return;

        interrompido = true;
        motivoParada = motivo;

        console.warn("\nPARADA SOLICITADA:", motivo);
    }

    function aoPressionarCtrlC() {
        solicitarParada("interrompido_pelo_usuario");
    }

    process.on("SIGINT", aoPressionarCtrlC);

    async function salvarProgresso() {
        await writeFile(
            join(pasta, "progresso.json"),
            JSON.stringify({
                atualizadoEm: new Date().toISOString(),
                inicioMonitor:
                    inicioMonitor
                        ? new Date(inicioMonitor).toISOString()
                        : null,
                duracaoMs: DURACAO_MS,
                intervaloMs: INTERVALO_MS,
                interrompido,
                motivoParada,
                bootstrap,
                rodadas,
                consultas: relatorio
            }, null, 2),
            "utf8"
        );
    }

    // ----------------------------------------------
    // PROCESSAR UM PRODUTO
    // ----------------------------------------------

    async function processarProduto(page, produto, rodada) {
        const resposta = await consultar(page, produto);

        const registro = {
            rodada,
            horario: new Date().toISOString(),
            id: produto.id,
            nome: produto.nome,
            urlSolicitada: produto.url,
            http: resposta.http,
            urlFinal: resposta.urlFinal ?? null,
            redirect: resposta.redirect ?? null,
            etapa: resposta.etapa ?? null,
            timeout: resposta.timeout ?? false,
            tempoMs: resposta.tempoTotalMs,
            tempoFetchMs: resposta.tempoFetchMs ?? null
        };

        if (urlDeVerificacao(resposta.urlFinal)) {
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

        } else if (!origemCorreta(resposta.urlFinal)) {
            registro.resultado = "origem_divergente";

            solicitarParada("origem_divergente");

        } else if (resposta.http !== 200) {
            registro.resultado = "http_inesperado";

            solicitarParada(
                "http_" + resposta.http
            );

        } else if (!resposta.html) {
            registro.resultado = "html_vazio";

            solicitarParada("html_vazio");

        } else {
            registro.caracteres = resposta.html.length;

            try {
                const estado = extrairEstado(resposta.html);

                registro.parser = "ok";
                registro.estado = estado;

                registro.disponibilidade = classificar(
                    produto,
                    estado
                );

                registro.resultado = "html_recuperado";

            } catch (erro) {
                registro.parser = "erro";
                registro.erroParser = erro.message;
                registro.resultado = "erro_parser";

                solicitarParada("erro_parser");
            }

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
        }

        return registro;
    }

    try {
        // ==========================================
        // INICIAR EDGE
        // ==========================================

        const posicao = (
            process.env.CEPO_EDGE_WINDOW_POSITION || ""
        ).trim();

        const tamanho = (
            process.env.CEPO_EDGE_WINDOW_SIZE || ""
        ).trim();

        const launchOptions = {
            executablePath: executavel,
            userDataDir: perfil.userDataDir,
            timeout: 15000,
            args: [
                `--profile-directory=${perfil.profileDirectory}`,
                `--window-position=${
                    /^-?\d{1,5},-?\d{1,5}$/.test(posicao)
                        ? posicao
                        : "100,100"
                }`,
                `--window-size=${
                    /^\d{3,5},\d{3,5}$/.test(tamanho)
                        ? tamanho
                        : "1280,900"
                }`
            ]
        };

        browser = HEADLESS
            ? await createRequire(
                new URL(
                    "./cepo-puppeteer-runtime/package.json",
                    import.meta.url
                )
            )("cepo-puppeteer-runtime").launch({
                ...puppeteer.buildLaunchOptions(
                    launchOptions
                ),
                headless: true
            })
            : await puppeteer.launch(launchOptions);

        console.log("\nEdge iniciado.");

        // ==========================================
        // BOOTSTRAP UNICO
        // ==========================================

        const aba = await prepararAba(browser);

        bootstrap = {
            http: aba.http,
            urlFinal: aba.urlFinal,
            tempoMs: aba.tempoMs ?? null,
            pronto: aba.pronto,
            motivo: aba.motivo,
            visibilidade: aba.visibilidade ?? null
        };

        if (!aba.pronto) {
            solicitarParada("bootstrap_failed");

        } else if (!interrompido) {
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
            // LOOP PERSISTENTE
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

                const estadoAba = await aba.page.evaluate(
                    () => ({
                        url: location.href,
                        origem: location.origin,
                        visibilidade: document.visibilityState
                    })
                );

                console.log(
                    "[ABA]",
                    JSON.stringify(estadoAba)
                );

                if (
                    estadoAba.origem !== ORIGEM ||
                    urlDeVerificacao(estadoAba.url)
                ) {
                    solicitarParada("aba_origem_invalida");
                    break;
                }

                let proximo = 0;

                async function trabalhador(numero) {
                    while (
                        !interrompido &&
                        proximo < PRODUTOS.length
                    ) {
                        const produto = PRODUTOS[proximo++];

                        emAndamento++;

                        picoConcorrencia = Math.max(
                            picoConcorrencia,
                            emAndamento
                        );

                        console.log(
                            `[R${rodada}] Worker ${numero}: ${produto.id}`
                        );

                        let registro;

                        try {
                            registro = await processarProduto(
                                aba.page,
                                produto,
                                rodada
                            );

                        } catch (erro) {
                            registro = {
                                rodada,
                                horario: new Date().toISOString(),
                                id: produto.id,
                                nome: produto.nome,
                                resultado: "erro_execucao",
                                erro: erro.message
                            };

                            solicitarParada("erro_execucao");

                        } finally {
                            emAndamento--;
                        }

                        relatorio.push(registro);

                        console.log(
                            produto.id,
                            registro.resultado,
                            registro.http ?? "-",
                            registro.disponibilidade ?? "-",
                            registro.tempoMs != null
                                ? `${registro.tempoMs}ms`
                                : "-"
                        );
                    }
                }

                // Tres fetches simultaneos,
                // compartilhando a mesma aba.
                await Promise.all(
                    Array.from(
                        { length: CONCORRENCIA },
                        (_, i) => trabalhador(i + 1)
                    )
                );

                const resultadosRodada = relatorio.filter(
                    r => r.rodada === rodada
                );

                const recuperados = resultadosRodada.filter(
                    r => r.resultado === "html_recuperado"
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

                if (interrompido) {
                    break;
                }

                console.log(
                    "Rodada concluida. Edge permanece aberto."
                );
            }

            // Mantem a sessao viva ate completar
            // o periodo total de cinco minutos.
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
        // ENCERRAR NAVEGADOR
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
            r => r.resultado === "html_recuperado"
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
            headless: HEADLESS,
            navegador: executavel,
            perfil: perfil.ambiente,
            origem: ORIGEM,

            duracaoConfiguradaMs: DURACAO_MS,
            intervaloMs: INTERVALO_MS,
            tempoTotalMs,

            inicioMonitor:
                inicioMonitor
                    ? new Date(inicioMonitor).toISOString()
                    : null,

            concorrenciaConfigurada: CONCORRENCIA,
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
            rodadas.map(r => ({
                Rodada: r.rodada,
                Consultas: r.consultas,
                Recuperados: r.recuperados,
                Falhas: r.falhas,
                TempoMs: r.tempoMs
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
