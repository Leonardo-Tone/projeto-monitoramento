
import { writeFile } from "node:fs/promises";

const url =
    "https://produto.mercadolivre.com.br/MLB-5214725509-moltres-dia-_JM";

const campos = [
    "server",
    "content-type",
    "content-length",
    "via",
    "x-cache",
    "cf-ray",
    "x-amz-cf-id",
    "x-request-id",
    "retry-after",
    "location"
];

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

    const html = await resposta.text();
    const tempo = Math.round(performance.now() - inicio);

    const headers = {};

    for (const campo of campos) {
        const valor = resposta.headers.get(campo);
        if (valor !== null) headers[campo] = valor;
    }

    const titulo = html.match(
        /<title[^>]*>([\s\S]*?)<\/title>/i
    )?.[1] ?? null;

    const textoVisivel = html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1200);

    const diagnostico = {
        node: process.version,
        http: resposta.status,
        statusText: resposta.statusText,
        tempoMs: tempo,
        urlFinal: resposta.url,
        houveRedirect: resposta.redirected,
        caracteres: html.length,
        htmlProduto: html.includes("__NORDIC_RENDERING_CTX__"),
        titulo,
        headers,
        mensagem: resposta.ok
            ? "Resposta HTTP aceita"
            : textoVisivel
    };

    console.log("\n=== DIAGNOSTICO ===");
    console.log(JSON.stringify(diagnostico, null, 2));

    await writeFile(
        "diagnostico-ml.json",
        JSON.stringify(diagnostico, null, 2),
        "utf8"
    );

    if (resposta.status === 403) {
        console.log("\n403: acesso negado pelo servidor.");
        console.log("Nenhuma nova tentativa sera realizada.");
    }

    if (resposta.status === 429) {
        console.log("\n429: limite de requisicoes.");
        console.log("Nenhuma nova tentativa sera realizada.");
    }

} catch (erro) {
    console.error("Falha:", erro.message);
}
