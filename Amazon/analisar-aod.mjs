
import { readFile, writeFile } from "node:fs/promises";
import { load } from "cheerio";

const asin = "B000GAYQJ0";
const vendedorAlvo = "A1J10D9IK94X8K";

const html = await readFile(`aod-${asin}.html`, "utf8");
const $ = load(html);

function texto(valor) {
    return valor.replace(/\s+/g, " ").trim();
}

function extrairPreco(bloco) {
    const precoCompleto = texto(
        bloco.find(".a-price .a-offscreen").first().text()
    );

    const encontrado = precoCompleto.match(/([\d.,]+),(\d{2})/);

    if (encontrado) {
        const inteiro = encontrado[1].replace(/\D/g, "");
        return Number(`${inteiro}.${encontrado[2]}`);
    }

    const inteiro = bloco.find(".a-price-whole").first()
        .text().replace(/\D/g, "");

    const centavos = bloco.find(".a-price-fraction").first()
        .text().replace(/\D/g, "");

    if (!inteiro) return null;

    return Number(`${inteiro}.${centavos || "00"}`);
}

const ofertas = [];

$('[id="aod-pinned-offer"], [id="aod-offer"]').each((i, elemento) => {
    const bloco = $(elemento);

    if (bloco.closest("#aod-sticky-pinned-offer").length) {
        return;
    }

    const vendidoPor = bloco.find('[id="aod-offer-soldBy"]')
        .first();

    const enviadoPor = bloco.find('[id="aod-offer-shipsFrom"]')
        .first();

    const vendedor = texto(
        vendidoPor.find(".a-col-right").first().text()
    );

    const transportador = texto(
        enviadoPor.find(".a-col-right").first().text()
    );

    const condicao = texto(
        bloco.find('[id="aod-offer-heading"]').first().text()
    );

    const preco = extrairPreco(bloco);

    const htmlOferta = $.html(bloco);

    ofertas.push({
        numero: ofertas.length + 1,
        destaque: bloco.attr("id") === "aod-pinned-offer",
        preco,
        vendedor: vendedor || null,
        enviadoPor: transportador || null,
        condicao: condicao || null,
        idAlvoPresente: htmlOferta.includes(vendedorAlvo),
        elementoCarrinho: bloco.find(
            'input[name="submit.addToCart"], [id*="aod-atc"]'
        ).length > 0
    });
});

console.log("\n=== OFERTAS ENCONTRADAS ===");
console.table(ofertas);

console.log("\n=== VENDEDOR DO LINK ORIGINAL ===");
console.log("ID:", vendedorAlvo);
console.table(ofertas.filter(o => o.idAlvoPresente));

console.log("\nTotal de blocos:", ofertas.length);
console.log(
    "Ofertas com preço:",
    ofertas.filter(o => o.preco !== null).length
);

await writeFile(
    `ofertas-${asin}.json`,
    JSON.stringify(ofertas, null, 2),
    "utf8"
);

console.log("\nResultado salvo em JSON.");
