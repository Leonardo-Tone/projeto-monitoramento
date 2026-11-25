
import { readFile } from "node:fs/promises";
import { load } from "cheerio";

const asin = "B000GAYQJ0";
const html = await readFile(`aod-${asin}.html`, "utf8");
const $ = load(html);

const blocos = $('[id="aod-pinned-offer"], [id="aod-offer"]');

const resultado = [];

blocos.each((i, elemento) => {
    const bloco = $(elemento);

    const vendedor = bloco
        .find('[id="aod-offer-soldBy"] .a-col-right')
        .first();

    const texto = vendedor.text().replace(/\s+/g, " ").trim();

    const nome = texto
        .split("A classificação do vendedor")[0]
        .trim();

    const ids = new Set();

    vendedor.find("a[href]").each((j, link) => {
        const href = $(link).attr("href");

        if (!href) return;

        const url = new URL(href, "https://www.amazon.com.br");

        for (const chave of ["seller", "smid", "sellerID"]) {
            const id = url.searchParams.get(chave);
            if (id) ids.add(id);
        }
    });

    resultado.push({
        bloco: i + 1,
        tipo: bloco.attr("id"),
        vendedor: nome,
        ids: [...ids].join(", ") || "Não encontrado"
    });
});

console.table(resultado);
