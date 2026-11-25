
import { load } from "cheerio";

const asin = "B0HC8JZC1D";
const dominio = "https://www.amazon.com.br";

function limpar(texto = "") {
    return texto.replace(/\s+/g, " ").trim();
}

function extrairOfertas(html, incluirDestaque = false) {
    const $ = load(html);
    const ofertas = [];

    function adicionar(bloco, tipo) {
        const offerId = bloco.find(
            'input[name="items[0.base][offerListingId]"]'
        ).first().attr("value");

        if (!offerId) return;

        const vendidoPor = bloco.find(
            '[id="aod-offer-soldBy"]'
        ).first();

        const link = vendidoPor.find(
            'a[href*="seller="]'
        ).first();

        const vendedor = limpar(link.text()) ||
            limpar(
                vendidoPor.find(".a-col-right > span")
                    .first().text()
            ) || "Desconhecido";

        const sellerId = link.attr("href")
            ? new URL(link.attr("href"), dominio)
                .searchParams.get("seller")
            : null;

        const inteiro = bloco.find(".a-price-whole")
            .first().text().replace(/\D/g, "");

        const centavos = bloco.find(".a-price-fraction")
            .first().text().replace(/\D/g, "");

        const preco = inteiro
            ? Number(`${inteiro}.${centavos || "00"}`)
            : null;

        ofertas.push({
            offerId,
            vendedor,
            sellerId,
            preco,
            tipo
        });
    }

    if (incluirDestaque) {
        const destaque = $("#aod-pinned-offer");

        if (destaque.length) {
            adicionar(destaque, "DESTAQUE");
        }
    }

    let lista = $('[id="aod-offer"]');

    // Estrutura alternativa de algumas páginas AOD.
    if (!lista.length) {
        lista = $(".aod-other-offer-block");
    }

    lista.each((i, elemento) => {
        adicionar($(elemento), "LISTA");
    });

    return {
        ofertas,
        totalInformado: $("#aod-total-offer-count").val()
    };
}

async function requisitar(url) {
    const inicio = Date.now();

    const resposta = await fetch(url, {
        headers: {
            "Accept": "text/html, */*",
            "Accept-Language": "pt-BR,pt;q=0.9"
        },
        signal: AbortSignal.timeout(15000)
    });

    const html = await resposta.text();

    console.log("HTTP:", resposta.status);
    console.log("Tempo:", Date.now() - inicio, "ms");
    console.log("Bytes:", Buffer.byteLength(html));

    if (!resposta.ok) {
        throw new Error(`HTTP ${resposta.status}`);
    }

    return html;
}

try {
    console.log("\n=== PÁGINA 1 ===");

    const url1 = new URL(
        "/gp/product/ajax/aodAjaxMain/",
        dominio
    );

    url1.searchParams.set("asin", asin);

    const html1 = await requisitar(url1);
    const pagina1 = extrairOfertas(html1, true);

    const idsPagina1 = new Set(
        pagina1.ofertas.map(o => o.offerId)
    );

    console.log("Total informado:", pagina1.totalInformado);
    console.log("Ofertas únicas:", idsPagina1.size);

    console.table(
        pagina1.ofertas.map(o => ({
            vendedor: o.vendedor,
            preco: o.preco,
            tipo: o.tipo
        }))
    );

    console.log("\n=== PÁGINA 2 ===");

    const url2 = new URL(
        "/gp/product/ajax/ref=aod_page_2",
        dominio
    );

    const parametros = {
        asin,
        m: "",
        qid: "",
        smid: "",
        sourcecustomerorglistid: "",
        sourcecustomerorglistitemid: "",
        sr: "8-1",
        pc: "dp",
        isonlyrenderofferlist: "true",
        pageno: "2",
        experienceId: "aodAjaxMain"
    };

    for (const [chave, valor] of Object.entries(parametros)) {
        url2.searchParams.set(chave, valor);
    }

    console.log("URL:", url2.toString());

    const html2 = await requisitar(url2);
    const pagina2 = extrairOfertas(html2);

    console.log("Ofertas recebidas:", pagina2.ofertas.length);

    const novas = [];
    const repetidas = [];

    for (const oferta of pagina2.ofertas) {
        if (idsPagina1.has(oferta.offerId)) {
            repetidas.push(oferta);
        } else {
            novas.push(oferta);
        }
    }

    console.log("\n=== NOVAS OFERTAS ===");
    console.table(
        novas.map(o => ({
            vendedor: o.vendedor,
            sellerId: o.sellerId,
            preco: o.preco
        }))
    );

    console.log("\n=== RESULTADO FINAL ===");

    const todosIds = new Set([
        ...idsPagina1,
        ...pagina2.ofertas.map(o => o.offerId)
    ]);

    const total = Number(pagina1.totalInformado);

    console.log("Página 1:", idsPagina1.size);
    console.log("Página 2:", pagina2.ofertas.length);
    console.log("Novas:", novas.length);
    console.log("Repetidas:", repetidas.length);
    console.log("Total de IDs únicos:", todosIds.size);
    console.log("Total informado pela Amazon:", total);

    if (Number.isFinite(total) &&
        todosIds.size === total) {
        console.log(
            "\nSUCESSO: quantidade de ofertas confere."
        );
    } else {
        console.log(
            "\nINCONCLUSIVO: ainda faltam ofertas ou " +
            "a resposta da página 2 não foi interpretada."
        );

        console.log(
            "Início da resposta da página 2:",
            limpar(html2.slice(0, 350))
        );
    }

} catch (erro) {
    console.error("\nERRO:", erro.message);
}
