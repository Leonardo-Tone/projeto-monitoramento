
import { load } from "cheerio";

const asins = [
    "B000GAYQJ0",
    "B0HC8JZC1D",
    "B0HCCTKPGN"
];

async function consultar(asin) {
    const url = `https://www.amazon.com.br/gp/product/ajax/aodAjaxMain/?asin=${asin}`;

    const inicio = Date.now();

    try {
        const response = await fetch(url, {
            headers: {
                "Accept": "text/html, */*",
                "Accept-Language": "pt-BR,pt;q=0.9"
            },
            signal: AbortSignal.timeout(15000)
        });

        const html = await response.text();
        const $ = load(html);

        const ofertas = $('#aod-offer-list [id="aod-offer"]');
        const painel = $("#aod-container").length > 0;

        const totalInformado = $("#aod-total-offer-count")
            .attr("value") ?? null;

        const titulo = $("#aod-asin-title-text")
            .first().text().replace(/\s+/g, " ").trim();

        const ofertaPrincipal = $("#aod-pinned-offer")
            .find('input[name="items[0.base][offerListingId]"]')
            .length > 0;

        const verificacao = /captcha|robot check|digite os caracteres|automated access/i
            .test(html);

        let estado = "UNKNOWN";

        if (response.status === 429) {
            estado = "RATE_LIMITED";
        } else if (verificacao) {
            estado = "VERIFICACAO";
        } else if (response.ok && painel) {
            if (ofertas.length > 0 || ofertaPrincipal) {
                estado = "OFFER_VISIBLE";
            } else {
                estado = "NO_OFFERS_IN_PANEL";
            }
        }

        return {
            asin,
            http: response.status,
            tempoMs: Date.now() - inicio,
            bytes: Buffer.byteLength(html),
            painel,
            ofertas: ofertas.length,
            ofertaPrincipal,
            totalInformado,
            estado,
            titulo: titulo.slice(0, 55),
            inicioResposta: painel ? "" : html.slice(0, 150)
        };

    } catch (erro) {
        return {
            asin,
            estado: "REQUEST_ERROR",
            erro: erro.message
        };
    }
}

const resultados = [];

for (const asin of asins) {
    console.log(`Consultando ${asin}...`);
    resultados.push(await consultar(asin));
}

console.log("\n=== COMPARAÇÃO ===");
console.table(resultados);
