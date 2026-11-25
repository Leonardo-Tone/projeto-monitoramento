
import { writeFile } from "node:fs/promises";

const url =
    "https://produto.mercadolivre.com.br/MLB-5214725509-moltres-dia-_JM";

const inicio = performance.now();

try {
    const resposta = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
        headers: {
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "pt-BR,pt;q=0.9"
        }
    });

    const tempo = Math.round(performance.now() - inicio);
    const html = await resposta.text();

    const htmlValido =
        resposta.ok &&
        html.includes("__NORDIC_RENDERING_CTX__") &&
        html.includes("MLB5214725509");

    console.table({
        HTTP: resposta.status,
        TempoMs: tempo,
        URLFinal: resposta.url,
        Caracteres: html.length,
        HTMLValido: htmlValido
    });

    if (htmlValido) {
        await writeFile("moltres-node.html", html);
        console.log("HTML salvo com sucesso.");
    } else {
        console.log("HTML nao salvo: resposta invalida.");
    }

    if ([403, 429].includes(resposta.status)) {
        console.warn("Restricao recebida. Sem novas tentativas.");
    }

} catch (erro) {
    console.error("Erro:", erro.message);
}
