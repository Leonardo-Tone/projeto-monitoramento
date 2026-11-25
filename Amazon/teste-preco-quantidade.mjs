
import { load } from "cheerio";

const dominio = "https://www.amazon.com.br";

const produtos = [
    "B0HC8JZC1D",
    "B0HCCTKPGN"
];

function limpar(texto = "") {
    return texto.replace(/\s+/g, " ").trim();
}

function centavosBR(texto) {
    const match = String(texto ?? "").match(
        /R\$\s*([\d.]+),(\d{2})/i
    );

    if (!match) return null;

    return Number(match[1].replace(/\./g, "")) * 100
        + Number(match[2]);
}

function centavosDecimal(texto) {
    if (!/^\d+(?:\.\d{1,2})?$/.test(
        String(texto ?? "")
    )) return null;

    const [inteiro, decimal = ""] = texto.split(".");

    return Number(inteiro) * 100
        + Number(decimal.padEnd(2, "0"));
}

function moeda(valor) {
    if (valor === null) return "Desconhecido";

    return (valor / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL"
    });
}

function extrairPreco(area) {
    const atributo = area.find(
        "[data-csa-c-price-to-pay]"
    ).first().attr("data-csa-c-price-to-pay");

    const valorAtributo = centavosDecimal(atributo);

    if (valorAtributo !== null) {
        return valorAtributo;
    }

    const elemento = area.find(
        ".apex-pricetopay-value"
    ).first();

    const reais = elemento.find(
        ".a-price-whole"
    ).first().text().replace(/\D/g, "");

    const centavos = elemento.find(
        ".a-price-fraction"
    ).first().text().replace(/\D/g, "");

    if (reais && /^\d{2}$/.test(centavos)) {
        return Number(reais) * 100 + Number(centavos);
    }

    const acessibilidade = area.find(
        ".apex-pricetopay-accessibility-label"
    ).first().text();

    return centavosBR(acessibilidade);
}

function extrairFrete(area) {
    const entrega = area.find(
        "[data-csa-c-delivery-price]"
    ).first().attr("data-csa-c-delivery-price");

    if (entrega) {
        if (/gr[aá]tis/i.test(entrega)) return 0;

        const valor = centavosBR(entrega);

        if (valor !== null) return valor;
    }

    const atributo = area.find(
        "[data-csa-c-shipping-charge]"
    ).first().attr("data-csa-c-shipping-charge");

    return centavosDecimal(atributo);
}

function extrairOfertas(html) {
    const $ = load(html);
    const blocos = $('[id="aod-offer"]').toArray();
    const destaque = $("#aod-pinned-offer");

    if (destaque.find(
        'input[name="items[0.base][offerListingId]"]'
    ).length) {
        blocos.unshift(destaque[0]);
    }

    const ofertas = [];

    for (const elemento of blocos) {
        const bloco = $(elemento);

        const offerId = bloco.find(
            'input[name="items[0.base][offerListingId]"]'
        ).first().attr("value");

        if (!offerId) continue;

        const areaPreco = bloco.find(
            '[id="aod-offer-price"]'
        ).first();

        const vendidoPor = bloco.find(
            '[id="aod-offer-soldBy"]'
        ).first();

        const link = vendidoPor.find(
            'a[href*="seller="]'
        ).first();

        const vendedor = limpar(link.text()) ||
            limpar(vendidoPor.find(
                ".a-col-right > span"
            ).first().text()) ||
            "Não identificado";

        const sellerId = link.attr("href")
            ? new URL(
                link.attr("href"), dominio
            ).searchParams.get("seller")
            : vendedor === "Amazon.com.br"
                ? "AMAZON_DIRECT"
                : null;

        const botao = bloco.find(
            'input[name="submit.addToCart"]'
        ).first();

        const descricaoBotao = botao.attr("aria-label") || "";

        const precoExibido = extrairPreco(areaPreco);
        const precoCarrinho = centavosBR(descricaoBotao);
        const frete = extrairFrete(areaPreco);

        const promocao = limpar(
            bloco.find(
                '[id^="aod-offer-promotion"]'
            ).first().text()
        );

        const acao = bloco.find(
            "[data-aod-atc-action]"
        ).first().attr("data-aod-atc-action");

        let minQty = null;
        let maxQty = null;

        if (acao) {
            try {
                const dados = JSON.parse(acao);

                minQty = Number.isInteger(dados.minQty)
                    ? dados.minQty : null;

                maxQty = Number.isInteger(dados.maxQty)
                    ? dados.maxQty : null;
            } catch {}
        }

        const totalEstimado =
            precoCarrinho !== null && frete !== null
                ? precoCarrinho + frete
                : null;

        ofertas.push({
            offerId,
            vendedor,
            sellerId,
            precoExibido,
            precoCarrinho,
            frete,
            totalEstimado,
            promocao,
            minQty,
            maxQty,
            possuiBotao: botao.length > 0,
            botaoDesabilitado: botao.is(":disabled"),
            destaque: elemento === destaque[0]
        });
    }

    return {
        ofertas,
        totalInformado: Number(
            $("#aod-total-offer-count").val()
        ) || null
    };
}

function montarURL(asin, pagina = 1) {
    if (pagina === 1) {
        const url = new URL(
            "/gp/product/ajax/aodAjaxMain/",
            dominio
        );

        url.searchParams.set("asin", asin);

        return url;
    }

    const url = new URL(
        `/gp/product/ajax/aodAjaxMain/ref=aod_page_${pagina}`,
        dominio
    );

    const parametros = {
        asin,
        m: "",
        qid: "",
        smid: "",
        sourcecustomerorglistid: "",
        sourcecustomerorglistitemid: "",
        sr: "",
        pc: "dp",
        isonlyrenderofferlist: "true",
        pageno: String(pagina)
    };

    for (const [chave, valor] of Object.entries(parametros)) {
        url.searchParams.set(chave, valor);
    }

    return url;
}

async function consultar(url) {
    const resposta = await fetch(url, {
        headers: {
            "Accept": "text/html, */*",
            "Accept-Language": "pt-BR,pt;q=0.9"
        },
        signal: AbortSignal.timeout(15000)
    });

    if (!resposta.ok) {
        throw new Error(`HTTP ${resposta.status}`);
    }

    return resposta.text();
}

for (const asin of produtos) {
    console.log(`\n========== ${asin} ==========`);

    try {
        const primeira = extrairOfertas(
            await consultar(montarURL(asin))
        );

        const todas = new Map();

        for (const oferta of primeira.ofertas) {
            todas.set(oferta.offerId, oferta);
        }

        const totalInformado = primeira.totalInformado;

        // Consulta páginas adicionais apenas quando necessário.
        // Limite de segurança para este experimento.
        for (
            let pagina = 2;
            pagina <= 5 &&
            totalInformado !== null &&
            todas.size < totalInformado;
            pagina++
        ) {
            const anterior = todas.size;

            const resultado = extrairOfertas(
                await consultar(montarURL(asin, pagina))
            );

            for (const oferta of resultado.ofertas) {
                todas.set(oferta.offerId, oferta);
            }

            console.log(
                `Página ${pagina}: ` +
                `${todas.size - anterior} novas ofertas`
            );

            if (todas.size === anterior) break;
        }

        const ofertas = [...todas.values()];

        ofertas.sort((a, b) => {
            const precoA = a.totalEstimado ??
                a.precoCarrinho ??
                a.precoExibido ??
                Infinity;

            const precoB = b.totalEstimado ??
                b.precoCarrinho ??
                b.precoExibido ??
                Infinity;

            return precoA - precoB;
        });

        console.log("\n=== OFERTAS ===");

        console.table(ofertas.map(o => ({
            vendedor: o.vendedor,
            exibido: moeda(o.precoExibido),
            carrinho: moeda(o.precoCarrinho),
            frete: moeda(o.frete),
            totalEstimado: moeda(o.totalEstimado),
            minQty: o.minQty,
            maxQty: o.maxQty,
            amazonDireta: o.sellerId === "AMAZON_DIRECT"
        })));

        console.log("\n=== DIAGNOSTICO ===");
        console.log("Total informado:", totalInformado);
        console.log("Ofertas únicas:", ofertas.length);

        console.log(
            "Preços exibidos identificados:",
            ofertas.filter(
                o => o.precoExibido !== null
            ).length
        );

        console.log(
            "Preços do botão identificados:",
            ofertas.filter(
                o => o.precoCarrinho !== null
            ).length
        );

        console.log(
            "Fretes identificados:",
            ofertas.filter(
                o => o.frete !== null
            ).length
        );

        console.log(
            "Quantidades identificadas:",
            ofertas.filter(
                o => o.maxQty !== null
            ).length
        );

        console.log(
            "Preços exibidos diferentes do botão:",
            ofertas.filter(o =>
                o.precoExibido !== null &&
                o.precoCarrinho !== null &&
                o.precoExibido !== o.precoCarrinho
            ).length
        );

        console.log("\n=== PROMOCOES ===");

        for (const oferta of ofertas) {
            if (oferta.promocao) {
                console.log(
                    `${oferta.vendedor}: ${oferta.promocao}`
                );
            }
        }

        console.log(
            "\nCobertura aparente:",
            totalInformado !== null &&
            ofertas.length === totalInformado
                ? "COMPLETA"
                : "PARCIAL OU DESCONHECIDA"
        );

    } catch (erro) {
        console.error("Erro:", erro.message);
    }
}
