
import { writeFile } from "node:fs/promises";

const asin = "B000GAYQJ0";

const url = `https://www.amazon.com.br/gp/product/ajax/aodAjaxMain/?asin=${asin}`;

async function testarEndpoint() {
    try {
        console.log("Consultando:", url);

        const inicio = Date.now();

        const response = await fetch(url, {
            method: "GET",
            headers: {
                "Accept": "text/html, */*",
                "Accept-Language": "pt-BR,pt;q=0.9"
            },
            signal: AbortSignal.timeout(15000)
        });

        const html = await response.text();

        console.log("\n=== RESULTADO ===");
        console.log("Status HTTP:", response.status);
        console.log("Tempo:", Date.now() - inicio, "ms");
        console.log("Tamanho:", Buffer.byteLength(html), "bytes");
        console.log("Content-Type:", response.headers.get("content-type"));

        console.log("\n=== CONTEÚDO INICIAL ===");
        console.log(html.slice(0, 1500));

        console.log("\n=== VERIFICAÇÕES ===");
        console.log("Contém aod-offer:", html.includes("aod-offer"));
        console.log("Contém preço:", html.includes("a-price"));
        console.log("Contém vendedor:", html.includes("aod-offer-soldBy"));

        await writeFile(`aod-${asin}.html`, html, "utf8");

        console.log("\nResposta salva em HTML.");

        if (!response.ok) {
            console.log("A requisição não foi aceita.");
        }

    } catch (erro) {
        console.error("Erro:", erro.message);
    }
}

testarEndpoint();
