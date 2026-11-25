
(async () => {
    // ========================================
    // CONFIGURAÇÃO DO TESTE
    // ========================================

    
    const CONFIG = {
        asin: "B0HC8JZC1D",
        sellerId: "AMAZON_DIRECT",
        quantidade: 1,
        precoMaximoTotal: 600,
    
        exigirVendidoAmazon: true,
        exigirEnviadoAmazon: true
    };


    // ========================================
    // FUNÇÕES AUXILIARES
    // ========================================

    function limpar(texto = "") {
        return String(texto).replace(/\s+/g, " ").trim();
    }

    function extrairReais(texto) {
        const resultado = String(texto ?? "").match(
            /R\$\s*([\d.]+),(\d{2})/
        );

        if (!resultado) return null;

        return Number(
            resultado[1].replace(/\./g, "")
        ) + Number(resultado[2]) / 100;
    }

    function moeda(valor) {
        return valor === null
            ? "Desconhecido"
            : valor.toLocaleString("pt-BR", {
                style: "currency",
                currency: "BRL"
            });
    }

    function obterSellerId(link) {
        if (!link) return null;

        try {
            return new URL(
                link.getAttribute("href"),
                location.origin
            ).searchParams.get("seller");
        } catch {
            return null;
        }
    }

    function analisar(bloco) {
        const ofertaId = bloco.querySelector(
            'input[name="items[0.base][offerListingId]"]'
        )?.value;

        if (!ofertaId) return null;

        const vendidoPor = bloco.querySelector(
            '[id="aod-offer-soldBy"]'
        );

        const link = vendidoPor?.querySelector(
            'a[href*="seller="]'
        );

        const vendedor = limpar(link?.textContent) ||
            limpar(
                vendidoPor?.querySelector(
                    ".a-col-right > span"
                )?.textContent
            ) ||
            "Desconhecido";

        const sellerId = obterSellerId(link) ||
            (/^amazon\.com\.br$/i.test(vendedor)
                ? "AMAZON_DIRECT"
                : null);

        const enviadoPor = limpar(
            bloco.querySelector(
                '[id="aod-offer-shipsFrom"] .a-col-right'
            )?.textContent
        );

        const vendidoAmazon =
            /^amazon\.com\.br$/i.test(vendedor);

        const enviadoAmazon =
            /^amazon(?:\.com\.br)?$/i.test(enviadoPor);

        let categoria = "DESCONHECIDA";

        if (vendidoAmazon && enviadoAmazon) {
            categoria = "AMAZON_DIRETA";
        } else if (vendidoAmazon) {
            categoria = "REVISAR_MODALIDADE";
        } else if (!sellerId || !enviadoPor) {
            categoria = "DESCONHECIDA";
        } else if (enviadoAmazon) {
            categoria = "TERCEIRO_ENVIO_AMAZON";
        } else {
            categoria = "TERCEIRO_ENVIO_PROPRIO";
        }

        const botao = bloco.querySelector(
            'form.AodAddToCart input[name="submit.addToCart"]'
        );

        const precoCarrinho = extrairReais(
            botao?.getAttribute("aria-label")
        );

        const areaPreco = bloco.querySelector(
            '[id="aod-offer-price"]'
        );

        const precoExibido = extrairReais(
            areaPreco?.querySelector(
                ".apex-pricetopay-accessibility-label"
            )?.textContent
        );

        const elementoFrete = bloco.querySelector(
            "[data-csa-c-delivery-price]"
        );

        const textoFrete = elementoFrete?.getAttribute(
            "data-csa-c-delivery-price"
        );

        let frete = null;

        if (textoFrete) {
            if (/gr[aá]tis/i.test(textoFrete)) {
                frete = 0;
            } else {
                frete = extrairReais(textoFrete);
            }
        }

        if (frete === null) {
            const shipping = bloco.querySelector(
                "[data-csa-c-shipping-charge]"
            )?.getAttribute("data-csa-c-shipping-charge");

            if (
                shipping !== null &&
                shipping !== undefined &&
                /^\d+(\.\d+)?$/.test(shipping)
            ) {
                frete = Number(shipping);
            }
        }

        const acao = bloco.querySelector(
            "[data-aod-atc-action]"
        )?.getAttribute("data-aod-atc-action");

        let minQty = null;
        let maxQty = null;

        try {
            const dados = JSON.parse(acao || "{}");

            if (Number.isInteger(dados.minQty)) {
                minQty = dados.minQty;
            }

            if (Number.isInteger(dados.maxQty)) {
                maxQty = dados.maxQty;
            }
        } catch {}

        const totalEstimado =
            precoCarrinho !== null && frete !== null
                ? Math.round(
                    (precoCarrinho + frete) * 100
                ) / 100
                : null;

        return {
            bloco,
            vendedor,
            sellerId,
            enviadoPor,
            categoria,
            vendidoAmazon,
            enviadoAmazon,
            precoExibido,
            precoCarrinho,
            frete,
            totalEstimado,
            minQty,
            maxQty,
            botao,
            botaoDisponivel: Boolean(
                botao && !botao.disabled
            )
        };
    }

    // ========================================
    // IDENTIFICAÇÃO DAS OFERTAS
    // ========================================

    const asinPagina = location.pathname.match(
        /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i
    )?.[1];

    if (
        asinPagina &&
        asinPagina.toUpperCase() !== CONFIG.asin
    ) {
        console.error("ASIN da página diferente do configurado.");
        return;
    }

    const blocos = [
        ...document.querySelectorAll(
            '#aod-offer-list [id="aod-offer"]'
        )
    ];

    const destaque = document.querySelector(
        "#aod-pinned-offer"
    );

    if (destaque) {
        blocos.unshift(destaque);
    }

    const ofertas = blocos.map(analisar).filter(Boolean);

    console.log("\n=== OFERTAS IDENTIFICADAS ===");

    console.table(ofertas.map(o => ({
        vendedor: o.vendedor,
        enviadoPor: o.enviadoPor,
        categoria: o.categoria,
        precoCarrinho: moeda(o.precoCarrinho),
        frete: moeda(o.frete),
        total: moeda(o.totalEstimado),
        maxQty: o.maxQty
    })));

    // ========================================
    // LOCALIZAÇÃO DA OFERTA DESEJADA
    // ========================================

    const candidatas = ofertas.filter(
        o => o.sellerId === CONFIG.sellerId
    );

    if (!candidatas.length) {
        console.warn(
            "OFERTA NÃO ENCONTRADA.",
            "O vendedor pode estar ausente ou",
            "a lista ainda não foi totalmente carregada."
        );
        return;
    }

    if (candidatas.length !== 1) {
        console.warn(
            "OFERTA AMBÍGUA:",
            candidatas.length,
            "ofertas correspondem ao vendedor."
        );
        return;
    }

    const oferta = candidatas[0];

    console.log("\n=== OFERTA SELECIONADA ===");

    console.table({
        vendedor: oferta.vendedor,
        enviadoPor: oferta.enviadoPor,
        categoria: oferta.categoria,
        vendidoAmazon: oferta.vendidoAmazon,
        enviadoAmazon: oferta.enviadoAmazon,
        precoExibido: moeda(oferta.precoExibido),
        precoCarrinho: moeda(oferta.precoCarrinho),
        frete: moeda(oferta.frete),
        totalEstimado: moeda(oferta.totalEstimado),
        minQty: oferta.minQty,
        maxQty: oferta.maxQty,
        botaoDisponivel: oferta.botaoDisponivel
    });

    // ========================================
    // VALIDAÇÕES ANTES DO CARRINHO
    // ========================================

    const problemas = [];

    if (
        CONFIG.exigirVendidoAmazon &&
        !oferta.vendidoAmazon
    ) {
        problemas.push(
            "A oferta não é vendida pela Amazon."
        );
    }

    if (
        CONFIG.exigirEnviadoAmazon &&
        !oferta.enviadoAmazon
    ) {
        problemas.push(
            "A oferta não é enviada pela Amazon."
        );
    }

    if (!oferta.botaoDisponivel) {
        problemas.push(
            "Botão de carrinho ausente ou desabilitado."
        );
    }

    if (
        oferta.minQty === null ||
        oferta.maxQty === null ||
        CONFIG.quantidade < oferta.minQty ||
        CONFIG.quantidade > oferta.maxQty
    ) {
        problemas.push(
            "Quantidade não validada pelo limite exibido."
        );
    }

    if (oferta.totalEstimado === null) {
        problemas.push(
            "Preço total estimado desconhecido."
        );
    } else if (
        oferta.totalEstimado > CONFIG.precoMaximoTotal
    ) {
        problemas.push(
            "Preço total estimado acima do limite."
        );
    }

    if (problemas.length > 0) {
        console.error("\nVERIFICAÇÃO PRELIMINAR REPROVADA");

        for (const problema of problemas) {
            console.error("-", problema);
        }

        return;
    }

    console.log("\nVERIFICAÇÃO PRELIMINAR APROVADA");
    console.log("Vendedor e envio compatíveis.");
    console.log("Preço e limite de quantidade compatíveis.");
    console.log("O estoque efetivo ainda não foi confirmado.");

    // ========================================
    // PREPARAÇÃO DO TESTE NO CARRINHO
    // ========================================

    oferta.bloco.scrollIntoView({
        behavior: "smooth",
        block: "center"
    });

    oferta.bloco.style.outline =
        "3px solid #16a34a";

    const sucesso = oferta.bloco.querySelector(
        '[id^="aod-offer-added-to-cart-"]'
    );

    const falha = oferta.bloco.querySelector(
        '[id^="aod-offer-not-added-to-cart-"]'
    );

    function visivel(elemento) {
        if (!elemento) return false;

        return !elemento.classList.contains(
            "aok-hidden"
        ) && !elemento.classList.contains(
            "aod-visibility-hidden"
        );
    }

    let ultimoEstado = "";

    const observador = new MutationObserver(() => {
        let estado = "";

        if (visivel(falha)) {
            estado = "ERRO";
        } else if (visivel(sucesso)) {
            estado = "ADICIONADO";
        }

        if (estado && estado !== ultimoEstado) {
            ultimoEstado = estado;

            if (estado === "ADICIONADO") {
                console.log(
                    "A interface indicou que a oferta foi adicionada."
                );
                console.log(
                    "Confira agora vendedor, quantidade e",
                    "valor no carrinho."
                );
            } else {
                console.error(
                    "A interface indicou falha ao adicionar."
                );
            }
        }
    });

    observador.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"]
    });

    setTimeout(() => {
        observador.disconnect();
    }, 120000);

    console.log(
        "\nClique MANUALMENTE no botão Adicionar ao Carrinho",
        "da oferta destacada em verde."
    );

    console.log(
        "O script não clica no botão e não finaliza compras."
    );
})();
