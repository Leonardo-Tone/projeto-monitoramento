
import http2 from "node:http2";
import { writeFile } from "node:fs/promises";

const url = new URL(
    "https://produto.mercadolivre.com.br/MLB-5214725509-moltres-dia-_JM"
);

const inicio = performance.now();
const cliente = http2.connect(url.origin);

try {
    const resultado = await new Promise((resolve, reject) => {
        let finalizado = false;

        function concluir(erro, dados) {
            if (finalizado) return;
            finalizado = true;
            clearTimeout(timeout);

            if (erro) reject(erro);
            else resolve(dados);
        }

        const timeout = setTimeout(() => {
            concluir(new Error("Timeout de 15 segundos"));
            cliente.destroy();
        }, 15000);

        cliente.once("error", concluir);

        cliente.once("connect", () => {
            const protocolo = cliente.alpnProtocol;

            if (protocolo !== "h2") {
                concluir(new Error(
                    "HTTP/2 nao negociado. ALPN: " + protocolo
                ));
                return;
            }

            const requisicao = cliente.request({
                ":method": "GET",
                ":path": url.pathname + url.search,
                "accept": "text/html,application/xhtml+xml",
                "accept-language": "pt-BR,pt;q=0.9"
            });

            const partes = [];
            let status = null;
            let headers = {};

            requisicao.on("response", resposta => {
                status = resposta[":status"];
                headers = resposta;
            });

            requisicao.on("data", parte => {
                partes.push(parte);
            });

            requisicao.on("end", () => {
                concluir(null, {
                    protocolo,
                    status,
                    headers,
                    html: Buffer.concat(partes).toString("utf8")
                });
            });

            requisicao.on("error", concluir);
            requisicao.end();
        });
    });

    const valido =
        resultado.status === 200 &&
        resultado.html.includes("__NORDIC_RENDERING_CTX__") &&
        resultado.html.includes("MLB5214725509");

    console.table({
        HTTP: resultado.status,
        Protocolo: resultado.protocolo,
        TempoMs: Math.round(performance.now() - inicio),
        Caracteres: resultado.html.length,
        HTMLValido: valido,
        Servidor: resultado.headers.server ?? null,
        Cache: resultado.headers["x-cache"] ?? null
    });

    if (valido) {
        await writeFile(
            "moltres-http2.html",
            resultado.html,
            "utf8"
        );

        console.log("HTML salvo com sucesso.");
    } else {
        console.log("Resposta nao corresponde ao HTML esperado.");
        console.log("Nenhuma nova tentativa sera feita.");
    }

} catch (erro) {
    console.error("Erro HTTP/2:", erro.message);
} finally {
    cliente.destroy();
}
