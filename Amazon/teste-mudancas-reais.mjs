
import { load } from "cheerio";
import assert from "node:assert/strict";

const asin = "B0HC8JZC1D";
const dominio = "https://www.amazon.com.br";

// ========================================
// FUNÇÕES AUXILIARES
// ========================================

function limpar(texto = "") {
    return texto.replace(/\s+/g, " ").trim();
}

function copiar(valor) {
    return structuredClone(valor);
}

// ========================================
// REQUISIÇÕES HTTP
// ========================================

async function requisitar(url, descricao) {
    const inicio = Date.now();

    const resposta = await fetch(url, {
        headers: {
            "Accept": "text/html, */*",
            "Accept-Language": "pt-BR,pt;q=0.9"
        },
        signal: AbortSignal.timeout(15000)
    });

    console.log(
        `${descricao}: HTTP ${resposta.status} - ` +
        `${Date.now() - inicio} ms`
    );

    if (!resposta.ok) {
        throw new Error(
            `${descricao}: HTTP ${resposta.status}`
        );
    }

    return await resposta.text();
}

// ========================================
// EXTRAÇÃO DE PREÇO
// ========================================

function extrairPrecoCentavos(bloco) {
    const area = bloco.find(
        '[id="aod-offer-price"]'
    ).first();

    if (!area.length) {
        return null;
    }

    // Método 1: atributo numérico.
    const atributo = area.find(
        "[data-csa-c-price-to-pay]"
    ).first().attr("data-csa-c-price-to-pay");

    if (atributo && /^\d+(\.\d{1,2})?$/.test(atributo)) {
        const [reais, centavos = ""] = atributo.split(".");

        return Number(reais) * 100 +
            Number(centavos.padEnd(2, "0"));
    }

    // Método 2: preço principal exibido.
    const preco = area.find(
        ".apex-pricetopay-value"
    ).first();

    const reais = preco.find(
        ".a-price-whole"
    ).first().text().replace(/\D/g, "");

    const centavos = preco.find(
        ".a-price-fraction"
    ).first().text().replace(/\D/g, "");

    if (reais && /^\d{2}$/.test(centavos)) {
        return Number(reais) * 100 +
            Number(centavos);
    }

    // Método 3: texto de acessibilidade.
    const texto = area.find(
        ".apex-pricetopay-accessibility-label"
    ).first().text();

    const resultado = texto.match(
        /R\$\s*([\d.]+),(\d{2})/
    );

    if (resultado) {
        const reais = resultado[1].replace(/\./g, "");

        return Number(reais) * 100 +
            Number(resultado[2]);
    }

    return null;
}

// ========================================
// EXTRAÇÃO DAS OFERTAS
// ========================================

function extrairOfertas(html) {
    const $ = load(html);

    // Aceita tanto a página inicial quanto
    // os fragmentos HTML da paginação.
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

        if (!offerId) {
            continue;
        }

        // Vendedor
        const vendidoPor = bloco.find(
            '[id="aod-offer-soldBy"]'
        ).first();

        const link = vendidoPor.find(
            'a[href*="seller="]'
        ).first();

        const vendedor = limpar(link.text()) ||
            limpar(
                vendidoPor.find(
                    ".a-col-right > span"
                ).first().text()
            ) ||
            "Não identificado";

        let sellerId = null;

        if (link.attr("href")) {
            const urlVendedor = new URL(
                link.attr("href"),
                dominio
            );

            sellerId = urlVendedor.searchParams.get(
                "seller"
            );
        } else if (vendedor === "Amazon.com.br") {
            sellerId = "AMAZON_DIRECT";
        }

        // Enviado por
        const enviadoPor = limpar(
            bloco.find(
                '[id="aod-offer-shipsFrom"] .a-col-right'
            ).first().text()
        );

        // Condição
        const condicao = limpar(
            bloco.find(
                '[id="aod-offer-heading"]'
            ).first().text()
        );

        // Preço
        const precoCentavos = extrairPrecoCentavos(
            bloco
        );

        // Quantidade máxima selecionável
        const acao = bloco.find(
            "[data-aod-atc-action]"
        ).first().attr("data-aod-atc-action");

        let minQty = null;
        let maxQty = null;

        if (acao) {
            try {
                const dados = JSON.parse(acao);

                minQty = Number.isInteger(dados.minQty)
                    ? dados.minQty
                    : null;

                maxQty = Number.isInteger(dados.maxQty)
                    ? dados.maxQty
                    : null;

            } catch {
                // Quantidade desconhecida.
            }
        }

        const botaoCarrinho = bloco.find(
            'input[name="submit.addToCart"]'
        ).first();

        ofertas.push({
            asin,
            offerId,
            vendedor,
            sellerId,
            condicao,
            enviadoPor,
            precoCentavos,
            minQty,
            maxQty,
            possuiBotaoCompra: botaoCarrinho.length > 0,
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

// ========================================
// VALIDAÇÃO DO SNAPSHOT
// ========================================

function preparar(snapshot, diagnosticar = false) {
    const log = (...args) => {
        if (diagnosticar) {
            console.log(...args);
        }
    };

    if (
        !snapshot ||
        !Number.isInteger(snapshot.totalInformado) ||
        !Array.isArray(snapshot.ofertas)
    ) {
        log("[ERRO] Estrutura do snapshot inválida.");
        return null;
    }

    const porId = new Map();

    for (const [indice, oferta] of snapshot.ofertas.entries()) {
        if (!oferta.offerId) {
            log(
                `[ERRO] Oferta ${indice + 1}: sem offerId`
            );

            return null;
        }

        if (porId.has(oferta.offerId)) {
            const anterior = porId.get(oferta.offerId);

            // Mesmo ID com dados divergentes:
            // não é seguro escolher uma das versões.
            if (
                anterior.sellerId !== oferta.sellerId ||
                anterior.precoCentavos !== oferta.precoCentavos
            ) {
                log(
                    "[ERRO] Identificador repetido " +
                    "com informações divergentes."
                );

                return null;
            }
        } else {
            porId.set(oferta.offerId, oferta);
        }
    }

    const unicas = [...porId.values()];

    log("\n=== DIAGNOSTICO DO SNAPSHOT ===");
    log("Total informado:", snapshot.totalInformado);
    log("Ofertas recebidas:", snapshot.ofertas.length);
    log("IDs únicos:", unicas.length);

    if (unicas.length !== snapshot.totalInformado) {
        log(
            "[ERRO] Quantidade de ofertas únicas " +
            "diferente do total informado."
        );

        return null;
    }

    const mapa = new Map();

    for (const [indice, oferta] of unicas.entries()) {
        const problemas = [];

        if (!oferta.sellerId) {
            problemas.push("Seller ID ausente");
        }

        if (!Number.isInteger(oferta.precoCentavos)) {
            problemas.push("Preço ausente ou inválido");
        }

        if (problemas.length > 0) {
            log(
                `[ERRO] Oferta ${indice + 1}: ` +
                oferta.vendedor
            );

            log("Problemas:", problemas);
            log("Preço:", oferta.precoCentavos);
            log("Seller ID:", oferta.sellerId);

            return null;
        }

        // Identidade estável para comparação.
        // Não usamos posição nem offerListingId.
        const chave = [
            oferta.asin,
            oferta.sellerId,
            oferta.condicao,
            oferta.enviadoPor
        ].join("|");

        if (mapa.has(chave)) {
            const anterior = mapa.get(chave);

            log("\n[ERRO] Ofertas ambíguas!");
            log("Vendedor:", oferta.vendedor);
            log("Seller ID:", oferta.sellerId);

            log("Primeira oferta:", {
                preco: anterior.precoCentavos / 100,
                condicao: anterior.condicao,
                enviadoPor: anterior.enviadoPor
            });

            log("Segunda oferta:", {
                preco: oferta.precoCentavos / 100,
                condicao: oferta.condicao,
                enviadoPor: oferta.enviadoPor
            });

            return null;
        }

        mapa.set(chave, oferta);
    }

    log("Validação: APROVADA");

    return mapa;
}

// ========================================
// COMPARAÇÃO DE SNAPSHOTS
// ========================================

function comparar(anterior, atual) {
    const antes = preparar(anterior);
    const depois = preparar(atual);

    if (!antes || !depois) {
        return {
            confiavel: false,
            eventos: []
        };
    }

    const eventos = [];

    // Ofertas atuais
    for (const [chave, oferta] of depois) {
        const antiga = antes.get(chave);

        if (!antiga) {
            eventos.push({
                tipo: "NOVA_OFERTA",
                vendedor: oferta.vendedor
            });

            continue;
        }

        if (
            antiga.precoCentavos !==
            oferta.precoCentavos
        ) {
            eventos.push({
                tipo: "PRECO_ALTERADO",
                vendedor: oferta.vendedor,
                antes: antiga.precoCentavos / 100,
                depois: oferta.precoCentavos / 100
            });
        }

        if (antiga.maxQty !== oferta.maxQty) {
            eventos.push({
                tipo: "LIMITE_ALTERADO",
                vendedor: oferta.vendedor,
                antes: antiga.maxQty,
                depois: oferta.maxQty
            });
        }
    }

    // Ofertas que deixaram de aparecer
    for (const [chave, oferta] of antes) {
        if (!depois.has(chave)) {
            eventos.push({
                tipo: "OFERTA_DESAPARECEU",
                vendedor: oferta.vendedor
            });
        }
    }

    return {
        confiavel: true,
        eventos
    };
}

// ========================================
// TESTES AUTOMATIZADOS
// ========================================

function testar(
    nome,
    inicial,
    modificar,
    esperado,
    confiavel = true
) {
    const alterado = copiar(inicial);

    modificar(alterado);

    const resultado = comparar(inicial, alterado);

    assert.equal(
        resultado.confiavel,
        confiavel,
        `Falha na confiabilidade: ${nome}`
    );

    assert.deepEqual(
        resultado.eventos.map(e => e.tipo),
        esperado,
        `Eventos incorretos: ${nome}`
    );

    console.log(`OK - ${nome}`);

    if (resultado.eventos.length > 0) {
        console.table(resultado.eventos);
    }
}

// ========================================
// EXECUÇÃO PRINCIPAL
// ========================================

try {
    const url1 = new URL(
        "/gp/product/ajax/aodAjaxMain/",
        dominio
    );

    url1.searchParams.set("asin", asin);

    const url2 = new URL(
        "/gp/product/ajax/aodAjaxMain/ref=aod_page_2",
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
        pageno: "2"
    };

    for (const [chave, valor] of Object.entries(parametros)) {
        url2.searchParams.set(chave, valor);
    }

    console.log("\n=== COLETA REAL ===\n");

    const html1 = await requisitar(
        url1,
        "Página 1"
    );

    const html2 = await requisitar(
        url2,
        "Página 2"
    );

    const pagina1 = extrairOfertas(html1);
    const pagina2 = extrairOfertas(html2);

    const snapshot = {
        asin,
        totalInformado: pagina1.totalInformado,
        ofertas: [
            ...pagina1.ofertas,
            ...pagina2.ofertas
        ]
    };

    console.log("\n=== SNAPSHOT REAL ===");

    console.log(
        "Página 1:", pagina1.ofertas.length
    );

    console.log(
        "Página 2:", pagina2.ofertas.length
    );

    console.log(
        "Total recebido:", snapshot.ofertas.length
    );

    console.log(
        "Total informado:", snapshot.totalInformado
    );

    console.table(
        snapshot.ofertas.map((oferta, i) => ({
            numero: i + 1,
            vendedor: oferta.vendedor,
            preco: oferta.precoCentavos === null
                ? null
                : oferta.precoCentavos / 100,
            maxQty: oferta.maxQty,
            destaque: oferta.destaque
        }))
    );

    // Valida o snapshot antes de executar testes.
    const mapa = preparar(snapshot, true);

    if (!mapa) {
        console.log(
            "\nSnapshot incompleto ou ambíguo. " +
            "Não é seguro emitir alertas."
        );

        process.exitCode = 1;

    } else {
        console.log("\n=== TESTES COM DADOS REAIS ===\n");

        testar(
            "Sem alterações",
            snapshot,
            s => {},
            []
        );

        testar(
            "Ordem diferente",
            snapshot,
            s => s.ofertas.reverse(),
            []
        );

        testar(
            "Mudança para destaque",
            snapshot,
            s => {
                s.ofertas[0].destaque = true;
            },
            []
        );

        testar(
            "OfferListingId diferente",
            snapshot,
            s => {
                s.ofertas[0].offerId = "id-simulado";
            },
            []
        );

        testar(
            "Preço reduzido",
            snapshot,
            s => {
                s.ofertas[0].precoCentavos -= 1000;
            },
            ["PRECO_ALTERADO"]
        );

        testar(
            "Preço aumentado",
            snapshot,
            s => {
                s.ofertas[0].precoCentavos += 1000;
            },
            ["PRECO_ALTERADO"]
        );

        testar(
            "Limite alterado",
            snapshot,
            s => {
                s.ofertas[0].maxQty =
                    (s.ofertas[0].maxQty ?? 0) + 5;
            },
            ["LIMITE_ALTERADO"]
        );

        testar(
            "Novo vendedor",
            snapshot,
            s => {
                const nova = copiar(s.ofertas[0]);

                nova.offerId = "nova-oferta-teste";
                nova.sellerId = "VENDEDOR_TESTE";
                nova.vendedor = "Loja Teste";

                s.ofertas.push(nova);
                s.totalInformado += 1;
            },
            ["NOVA_OFERTA"]
        );

        testar(
            "Oferta desapareceu",
            snapshot,
            s => {
                s.ofertas.pop();
                s.totalInformado -= 1;
            },
            ["OFERTA_DESAPARECEU"]
        );

        testar(
            "Resposta incompleta",
            snapshot,
            s => {
                s.ofertas.pop();
            },
            [],
            false
        );

        testar(
            "Preço ausente",
            snapshot,
            s => {
                s.ofertas[0].precoCentavos = null;
            },
            [],
            false
        );

        testar(
            "Ofertas ambíguas",
            snapshot,
            s => {
                const duplicada = copiar(
                    s.ofertas[0]
                );

                duplicada.offerId =
                    "oferta-ambigua-teste";

                s.ofertas.push(duplicada);
                s.totalInformado += 1;
            },
            [],
            false
        );

        console.log(
            "\nTODOS OS 12 TESTES PASSARAM!"
        );

        console.log(
            "INTEGRACAO COM HTML REAL APROVADA!"
        );
    }

} catch (erro) {
    console.error(
        "\nERRO:", erro.message
    );

    process.exitCode = 1;
}
