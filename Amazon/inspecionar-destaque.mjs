
import { readFile } from "node:fs/promises";
import { load } from "cheerio";

const asins = [
    "B0HC8JZC1D",
    "B0HCCTKPGN"
];

function limpar(texto = "") {
    return texto.replace(/\s+/g, " ").trim();
}

for (const asin of asins) {
    const html = await readFile(`aod-${asin}.html`, "utf8");
    const $ = load(html);

    const principal = $("#aod-pinned-offer");

    const formulario = principal.find(
        "form.AodAddToCart"
    ).first();

    const idOferta = formulario.find(
        'input[name="items[0.base][offerListingId]"]'
    ).attr("value") || null;

    const blocoVendedor = principal.find(
        '[id="aod-offer-soldBy"]'
    ).first();

    const linkVendedor = blocoVendedor.find(
        'a[href*="seller="]'
    ).first();

    const vendedor = limpar(linkVendedor.text()) ||
        limpar(
            blocoVendedor.find(".a-col-right > span")
                .first().text()
        ) || "Não identificado";

    const botao = formulario.find(
        'input[name="submit.addToCart"]'
    ).first();

    const descricaoBotao = limpar(
        botao.attr("aria-label") || ""
    );

    const idsLista = $('#aod-offer-list [id="aod-offer"]')
        .map((i, elemento) => {
            return $(elemento).find(
                'input[name="items[0.base][offerListingId]"]'
            ).first().attr("value") || null;
        })
        .get();

    const idsUnicos = new Set([
        ...idsLista,
        ...(idOferta ? [idOferta] : [])
    ]);

    console.log(`\n========== ${asin} ==========`);

    console.log({
        possuiOfertaDestacada: Boolean(idOferta),
        vendedorDestacado: idOferta ? vendedor : null,
        descricaoBotao: descricaoBotao || null,
        possuiBotaoCompra: botao.length > 0,
        destacadaRepetidaNaLista: idOferta
            ? idsLista.includes(idOferta)
            : null,
        ofertasNaLista: idsLista.length,
        ofertasDistintasNoHTML: idsUnicos.size,
        totalInformado: $("#aod-total-offer-count").val()
    });
}
