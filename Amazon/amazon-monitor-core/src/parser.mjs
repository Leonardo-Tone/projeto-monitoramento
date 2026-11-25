import { load } from "cheerio";
import { createHash } from "node:crypto";

const DOMINIO = "https://www.amazon.com.br";

function limpar(texto = "") {
    return String(texto).replace(/\s+/g, " ").trim();
}

function centavos(texto) {
    const achou = String(texto ?? "").match(/R\$\s*([\d.]+),(\d{2})/);
    if (!achou) return null;
    return Number(achou[1].replace(/\./g, "")) * 100 + Number(achou[2]);
}

function centavosDecimal(texto) {
    const valor = String(texto ?? "").trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(valor)) return null;
    const [inteiro, decimal = ""] = valor.split(".");
    return Number(inteiro) * 100 + Number(decimal.padEnd(2, "0"));
}

export function classificarOferta(vendedor, enviadoPor, sellerId = null) {
    const nome = limpar(vendedor);
    const envio = limpar(enviadoPor);
    if (!nome || /^desconhecido$/i.test(nome) || !envio) return "DESCONHECIDA";
    const vendaAmazon = /^amazon\.com\.br$/i.test(nome);
    const entregaAmazon = /^amazon(?:\.com\.br)?$/i.test(envio);
    if (vendaAmazon && entregaAmazon) return "AMAZON_DIRETA";
    if (vendaAmazon) return "REVISAR_MODALIDADE";
    // Não criar alertas/identidade confiável para loja sem sellerId verificável.
    if (!sellerId) return "DESCONHECIDA";
    return entregaAmazon ? "TERCEIRO_ENVIO_AMAZON" : "TERCEIRO_ENVIO_PROPRIO";
}

function analisarOferta($, elemento) {
    const bloco = $(elemento);
    const offerId = bloco.find('input[name="items[0.base][offerListingId]"]')
        .first().attr("value");
    if (!offerId) throw new Error("Bloco de oferta sem offerListingId");

    const soldBy = bloco.find('[id="aod-offer-soldBy"]').first();
    const sellerLink = soldBy.find('a[href*="seller="]').first();
    // As estruturas AOD variam. Uma variação de texto não deve virar
    // automaticamente uma identidade de vendedor confirmada.
    const vendedor = limpar(sellerLink.text()) ||
        limpar(soldBy.find(".a-col-right > span").first().text()) ||
        limpar(soldBy.find(".a-col-right a").first().text()) ||
        limpar(soldBy.find(".a-col-right").first().text()) || "Desconhecido";
    const evidenciaVendedor = limpar(soldBy.text()).slice(0, 160);

    let sellerId = null;
    if (sellerLink.attr("href")) {
        try {
            sellerId = new URL(sellerLink.attr("href"), DOMINIO)
                .searchParams.get("seller");
        } catch { /* Não inventar sellerId */ }
    }
    if (/^amazon\.com\.br$/i.test(vendedor)) sellerId ??= "AMAZON_DIRECT";

    const enviadoPor = limpar(
        bloco.find('[id="aod-offer-shipsFrom"] .a-col-right').first().text()
    );
    const botao = bloco.find('input[name="submit.addToCart"]').first();
    const precoNormalCentavos = centavos(botao.attr("aria-label"));
    const areaPreco = bloco.find('[id="aod-offer-price"]').first();
    let precoExibidoCentavos = centavos(
        areaPreco.find(".apex-pricetopay-accessibility-label").first().text()
    );
    if (precoExibidoCentavos == null) {
        precoExibidoCentavos = centavosDecimal(
            areaPreco.find("[data-csa-c-price-to-pay]").first()
                .attr("data-csa-c-price-to-pay")
        );
    }
    if (precoExibidoCentavos == null) {
        const visual = areaPreco.find(".apex-pricetopay-value").first();
        const reais = visual.find(".a-price-whole").first().text().replace(/\D/g, "");
        const parte = visual.find(".a-price-fraction").first().text().replace(/\D/g, "");
        if (reais && /^\d{2}$/.test(parte)) {
            precoExibidoCentavos = Number(reais) * 100 + Number(parte);
        }
    }

    const textoFrete = bloco.find("[data-csa-c-delivery-price]").first()
        .attr("data-csa-c-delivery-price");
    let freteCentavos = /gr[aá]tis/i.test(textoFrete ?? "")
        ? 0 : centavos(textoFrete);
    if (freteCentavos == null) {
        freteCentavos = centavosDecimal(
            bloco.find("[data-csa-c-shipping-charge]").first()
                .attr("data-csa-c-shipping-charge")
        );
    }

    let minQty = null;
    let maxQty = null;
    try {
        const dados = JSON.parse(
            bloco.find("[data-aod-atc-action]").first()
                .attr("data-aod-atc-action") || "{}"
        );
        if (Number.isInteger(dados.minQty)) minQty = dados.minQty;
        if (Number.isInteger(dados.maxQty)) maxQty = dados.maxQty;
    } catch { /* Quantidade desconhecida, não zero */ }

    return {
        offerId,
        // Apenas auditoria: offerListingId e hash mudam entre leituras.
        offerHash: createHash("sha256").update(offerId).digest("hex").slice(0, 16),
        sellerId,
        vendedor,
        enviadoPor,
        categoria: classificarOferta(vendedor, enviadoPor, sellerId),
        // Campo diagnóstico: disponível para inspeção, não é identidade de compra.
        ...(sellerId == null && !/^amazon\.com\.br$/i.test(vendedor)
            ? { vendedorDiagnostico: {
                textoBloco: evidenciaVendedor,
                possuiLinkSeller: sellerLink.length > 0
            } } : {}),
        precoNormalCentavos,
        precoExibidoCentavos,
        freteCentavos,
        minQty,
        maxQty
    };
}

export function parseAodPrimeiraPagina(html) {
    const $ = load(html);
    const contador = $("#aod-total-offer-count").first();
    const texto = String(
        contador.attr("value") ?? contador.val() ?? contador.text() ?? ""
    ).trim();
    if (!/^\d+$/.test(texto)) throw new Error("Contador AOD ausente/inválido");
    const totalInformado = Number(texto);

    const lista = $('[id="aod-offer"]').toArray()
        .filter(e => $(e).closest("#aod-pinned-offer").length === 0)
        .map(e => analisarOferta($, e));

    const destaqueEl = $("#aod-pinned-offer").first();
    const destaque = destaqueEl.length && destaqueEl.find(
        'input[name="items[0.base][offerListingId]"]'
    ).length ? analisarOferta($, destaqueEl) : null;

    const mapa = new Map();
    for (const oferta of lista) {
        const anterior = mapa.get(oferta.offerId);
        if (anterior) {
            throw new Error("offerListingId duplicado na página AOD");
        }
        mapa.set(oferta.offerId, oferta);
    }
    const esperado = Math.min(totalInformado, 10);
    if (mapa.size !== esperado) {
        throw new Error(`Primeira página inconsistente: ${mapa.size}/${esperado}`);
    }

    const destaqueExclusivo = Boolean(destaque && !mapa.has(destaque.offerId));
    const ofertas = [...mapa.values()];
    if (destaqueExclusivo) ofertas.push(destaque);

    return {
        totalInformado,
        totalLista: mapa.size,
        totalVisivel: ofertas.length,
        destaquePresente: Boolean(destaque),
        destaqueExclusivo,
        cobertura: totalInformado > 10 ? "PRIMEIRA_PAGINA_PARCIAL" : "PRIMEIRA_PAGINA_COMPLETA",
        ofertasNaoConsultadasEstimadas: Math.max(0, totalInformado - mapa.size),
        ofertas
    };
}
