
import http2 from "node:http2";
import { writeFile } from "node:fs/promises";
import {
    gunzipSync,
    brotliDecompressSync,
    inflateSync
} from "node:zlib";

const URL_INICIAL =
    "https://produto.mercadolivre.com.br/MLB-5214725509-moltres-dia-_JM";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15000;
const MAX_BYTES = 5 * 1024 * 1024;

function dominioPermitido(url) {
    return url.protocol === "https:" &&
        (
            url.hostname === "mercadolivre.com.br" ||
            url.hostname.endsWith(".mercadolivre.com.br")
        );
}

function extrairTexto(buffer, encoding) {
    switch (encoding) {
        case "gzip":
            return gunzipSync(buffer).toString("utf8");
        case "br":
            return brotliDecompressSync(buffer).toString("utf8");
        case "deflate":
            return inflateSync(buffer).toString("utf8");
        case undefined:
        case "identity":
            return buffer.toString("utf8");
        default:
            throw new Error("Codificacao desconhecida: " + encoding);
    }
}

async function solicitarHTTP2(url) {
    const cliente = http2.connect(url.origin);

    try {
        return await new Promise((resolve, reject) => {
            let finalizado = false;

            const timer = setTimeout(() => {
                concluir(new Error("Timeout de 15 segundos"));
            }, TIMEOUT_MS);

            function concluir(erro, resposta) {
                if (finalizado) return;
                finalizado = true;

                clearTimeout(timer);

                if (erro) reject(erro);
                else resolve(resposta);
            }

            cliente.once("error", concluir);

            cliente.once("connect", () => {
                const protocolo = cliente.alpnProtocol;

                if (protocolo !== "h2") {
                    concluir(new Error(
                        "HTTP/2 nao negociado: " + protocolo
                    ));
                    return;
                }

                let requisicao;

                try {
                    requisicao = cliente.request({
                        ":method": "GET",
                        ":path": url.pathname + url.search,
                        "accept": "text/html,application/xhtml+xml",
                        "accept-language": "pt-BR,pt;q=0.9"
                    });
                } catch (erro) {
                    concluir(erro);
                    return;
                }

                let headers = {};
                const partes = [];
                let tamanho = 0;

                requisicao.on("response", resposta => {
                    headers = resposta;
                });

                requisicao.on("data", parte => {
                    tamanho += parte.length;

                    if (tamanho > MAX_BYTES) {
                        requisicao.close();
                        concluir(new Error("Resposta muito grande"));
                        return;
                    }

                    partes.push(parte);
                });

                requisicao.on("end", () => {
                    concluir(null, {
                        status: headers[":status"],
                        headers,
                        buffer: Buffer.concat(partes),
                        protocolo
                    });
                });

                requisicao.on("error", concluir);
                requisicao.end();
            });
        });
    } finally {
        cliente.destroy();
    }
}

async function executar() {
    let url = new URL(URL_INICIAL);
    const historico = [];
    const visitadas = new Set();

    const inicio = performance.now();

    for (let etapa = 0; etapa <= MAX_REDIRECTS; etapa++) {
        if (!dominioPermitido(url)) {
            throw new Error("Dominio nao permitido: " + url.hostname);
        }

        if (visitadas.has(url.href)) {
            throw new Error("Loop de redirecionamento");
        }

        visitadas.add(url.href);

        console.log(
            `\n[${etapa + 1}] Consultando ${url.origin}${url.pathname}`
        );

        const inicioRequisicao = performance.now();
        const resposta = await solicitarHTTP2(url);

        const tempo = Math.round(
            performance.now() - inicioRequisicao
        );

        historico.push({
            etapa: etapa + 1,
            http: resposta.status,
            protocolo: resposta.protocolo,
            tempoMs: tempo,
            servidor: resposta.headers.server ?? "-",
            cache: resposta.headers["x-cache"] ?? "-"
        });

        console.log("HTTP:", resposta.status);
        console.log("Tempo:", tempo, "ms");

        if ([301, 302, 303, 307, 308].includes(resposta.status)) {
            const location = resposta.headers.location;

            if (!location) {
                console.warn("Redirecionamento sem Location.");
                break;
            }

            const destino = new URL(location, url);

            console.log(
                "Redirecionamento para:",
                destino.origin + destino.pathname
            );

            if (!dominioPermitido(destino)) {
                console.warn("Destino externo. Consulta interrompida.");
                break;
            }

            url = destino;
            continue;
        }

        if (resposta.status === 200) {
            const html = extrairTexto(
                resposta.buffer,
                resposta.headers["content-encoding"]
            );

            const valido =
                html.includes("__NORDIC_RENDERING_CTX__") &&
                html.includes("MLB5214725509");

            console.table({
                HTTP: resposta.status,
                Protocolo: resposta.protocolo,
                Caracteres: html.length,
                HTMLValido: valido,
                TempoTotalMs: Math.round(performance.now() - inicio)
            });

            if (valido) {
                await writeFile(
                    "moltres-http2-direto.html",
                    html,
                    "utf8"
                );

                console.log("HTML salvo com sucesso!");
            } else {
                console.warn("HTTP 200, mas HTML inesperado.");
            }

            break;
        }

        console.warn(
            "Resposta HTTP nao utilizavel:",
            resposta.status
        );

        if ([403, 429].includes(resposta.status)) {
            console.warn(
                "Restricao detectada. Sem novas tentativas."
            );
        }

        break;
    }

    console.log("\n=== HISTORICO HTTP/2 ===");
    console.table(historico);
}

executar().catch(erro => {
    console.error("Erro:", erro.message);
});
