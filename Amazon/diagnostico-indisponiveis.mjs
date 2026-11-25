
import { load } from "cheerio";
import { writeFile } from "node:fs/promises";

const asins = [
    "B0HC8JZC1D",
    "B0HCCTKPGN"
];

function limpar(texto) {
    return texto.replace(/\s+/g, " ").trim();
}

function extrairPreco(bloco) {
    const inteiro = bloco.find(
        ".a-price-whole"
    ).first().text().replace(/\D/g, "");

    const centavos = bloco.find(
        ".a-price-fraction"
    ).first().text().replace(/\D/g, "");

    if (!inteiro) return null;

    return Number(`${inteiro}.${centavos || "00"}`);
}

function extrairVendedor(bloco) {
    const vendidoPor = bloco.find(
        '[id="aod-offer-soldBy"]'
    ).first();

    const link = vendidoPor.find(
        'a[href*="seller="]'
    ).first();

    const nomeLink = limpar(link.text());

    const nomeDireto = limpar(
        vendidoPor.find(".a-col-right > span")
            .first().text()
    );

    const vendedor = nomeLink || nomeDireto || "Não identificado";

    let sellerId = null;

    if (link.attr("href")) {
        const sellerUrl = new URL(
            link.attr("href"),
            "https://www.amazon.com.br"
        );

        sellerId = sellerUrl.searchParams.get("seller");
    }

    const amazonDireta = vendedor === "Amazon.com.br";

    const tipoVendedor = amazonDireta
        ? "AMAZON_DIRECT"
        : sellerId
            ? "THIRD_PARTY"
            : "UNKNOWN";

    return {
        vendedor,
        sellerId,
        tipoVendedor
    };
}

for (const asin of asins) {
    console.log(`\n========== ${asin} ==========`);

    const url = `https://www.amazon.com.br/gp/product/ajax/aodAjaxMain/?asin=${asin}`;

    try {
        const inicio = Date.now();

        const response = await fetch(url, {
            headers: {
                "Accept": "text/html, */*",
                "Accept-Language": "pt-BR,pt;q=0.9"
            },
            signal: AbortSignal.timeout(15000)
        });

        const tempo = Date.now() - inicio;

        console.log("HTTP:", response.status);
        console.log("Tempo:", tempo, "ms");

        if (!response.ok) {
            console.log("Requisição não concluída.");
            continue;
        }

        const html = await response.text();

        await writeFile(
            `aod-${asin}.html`,
            html,
            "utf8"
        );

        const $ = load(html);

        if (!$("#aod-container").length) {
            console.log("Painel AOD não reconhecido.");
            continue;
        }

        const titulo = limpar(
            $("#aod-asin-title-text").first().text()
        );

        const totalInformado = Number(
            $("#aod-total-offer-count").val()
        );

        const ofertaPrincipal = $(
            "#aod-pinned-offer"
        ).find(
            'input[name="items[0.base][offerListingId]"]'
        ).length > 0;

        const resultados = [];

        $('#aod-offer-list [id="aod-offer"]').each((i, el) => {
            const bloco = $(el);

            const {
                vendedor,
                sellerId,
                tipoVendedor
            } = extrairVendedor(bloco);

            const formulario = bloco.find(
                "form.AodAddToCart"
            ).first();

            const offerListingId = formulario.find(
                'input[name="items[0.base][offerListingId]"]'
            ).attr("value");

            const botao = formulario.find(
                'input[name="submit.addToCart"]'
            );

            const enviadoPor = limpar(
                bloco.find(
                    '[id="aod-offer-shipsFrom"] .a-col-right'
                ).first().text()
            );

            const condicao = limpar(
                bloco.find(
                    '[id="aod-offer-heading"]'
                ).first().text()
            );
            
            const acaoCarrinho = bloco.find(
                '[data-aod-atc-action]'
            ).first();

            let minQty = null;
            let maxQty = null;

            try {
                const dados = JSON.parse(
                    acaoCarrinho.attr("data-aod-atc-action") || "{}"
                );
            
                minQty = Number.isInteger(dados.minQty)
                    ? dados.minQty
                    : null;
            
                maxQty = Number.isInteger(dados.maxQty)
                    ? dados.maxQty
                    : null;
            
            } catch (erro) {
                console.log("Quantidade não identificada:", vendedor);
            }

            resultados.push({
                numero: i + 1,
                vendedor,
                sellerId,
                tipoVendedor,
                precoExibido: extrairPreco(bloco),
                enviadoPor,
                condicao,
                possuiOfertaId: Boolean(offerListingId),
                botaoCarrinho: botao.length > 0,
                botaoDesabilitado: botao.is(":disabled"),
                minQty,
                maxQty
            });
            
        });

        console.log("\n=== INFORMAÇÕES DO PRODUTO ===");
        console.log("Título:", titulo);
        console.log("ASIN:", asin);
        console.log("Oferta em destaque:", ofertaPrincipal);
        console.log("Total informado:", totalInformado);
        console.log("Ofertas analisadas:", resultados.length);

        console.log("\n=== TODAS AS OFERTAS ===");
        console.table(resultados);

        const ofertasAmazon = resultados.filter(
            oferta => oferta.tipoVendedor === "AMAZON_DIRECT"
        );

        console.log("\n=== VENDIDO PELA AMAZON ===");

        if (ofertasAmazon.length > 0) {
            console.table(ofertasAmazon);
        } else {
            console.log(
                "Amazon não encontrada nas ofertas analisadas."
            );
        }

        console.log("\n=== RESUMO ===");

        console.log(
            "Ofertas com botão:",
            resultados.filter(x => x.botaoCarrinho).length
        );

        console.log(
            "Ofertas de terceiros:",
            resultados.filter(
                x => x.tipoVendedor === "THIRD_PARTY"
            ).length
        );

        console.log(
            "Ofertas vendidas pela Amazon:",
            ofertasAmazon.length
        );

        console.log(
            "Ofertas não carregadas:",
            Number.isFinite(totalInformado)
                ? Math.max(0, totalInformado - resultados.length)
                : "Desconhecido"
        );

        await writeFile(
            `ofertas-${asin}.json`,
            JSON.stringify({
                asin,
                titulo,
                ofertaPrincipal,
                totalInformado,
                ofertas: resultados
            }, null, 2),
            "utf8"
        );

        console.log("\nHTML e JSON salvos com sucesso.");

    } catch (erro) {
        console.error("Erro:", erro.message);
    }
}
