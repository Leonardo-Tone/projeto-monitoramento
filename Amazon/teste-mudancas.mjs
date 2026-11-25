
import assert from "node:assert/strict";

const asin = "B0HC8JZC1D";

const inicial = {
    asin,
    totalInformado: 2,
    ofertas: [
        {
            asin,
            sellerId: "AP69BBO8E1IX5",
            vendedor: "Cube Cards",
            condicao: "Novo",
            enviadoPor: "Amazon",
            offerId: "id-cube-1",
            precoCentavos: 71060,
            maxQty: 2,
            destaque: false
        },
        {
            asin,
            sellerId: "A387FH5Z0WJZFP",
            vendedor: "voltxstore",
            condicao: "Novo",
            enviadoPor: "Amazon",
            offerId: "id-voltx-1",
            precoCentavos: 71155,
            maxQty: 25,
            destaque: false
        }
    ]
};

function copiar(valor) {
    return structuredClone(valor);
}

function chave(oferta) {
    return [
        oferta.asin,
        oferta.sellerId,
        oferta.condicao,
        oferta.enviadoPor
    ].join("|");
}

function preparar(snapshot) {
    if (
        !snapshot ||
        !Number.isInteger(snapshot.totalInformado) ||
        !Array.isArray(snapshot.ofertas)
    ) {
        return null;
    }

    // Remove duplicações do mesmo identificador.
    const porId = new Map();

    for (const oferta of snapshot.ofertas) {
        if (!oferta.offerId || !oferta.sellerId) {
            return null;
        }

        if (!porId.has(oferta.offerId)) {
            porId.set(oferta.offerId, oferta);
        }
    }

    const unicas = [...porId.values()];

    // Snapshot incompleto: não gerar alertas.
    if (unicas.length !== snapshot.totalInformado) {
        return null;
    }

    const porVendedor = new Map();

    for (const oferta of unicas) {
        const id = chave(oferta);

        // Duas ofertas com a mesma chave exigem
        // identificação mais específica.
        if (porVendedor.has(id)) {
            return null;
        }

        porVendedor.set(id, oferta);
    }

    return porVendedor;
}

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

    for (const [id, oferta] of depois) {
        const antiga = antes.get(id);

        if (!antiga) {
            eventos.push({
                tipo: "NOVA_OFERTA",
                vendedor: oferta.vendedor
            });

            continue;
        }

        if (oferta.precoCentavos !== antiga.precoCentavos) {
            eventos.push({
                tipo: "PRECO_ALTERADO",
                vendedor: oferta.vendedor,
                antes: antiga.precoCentavos / 100,
                depois: oferta.precoCentavos / 100
            });
        }

        if (oferta.maxQty !== antiga.maxQty) {
            eventos.push({
                tipo: "LIMITE_ALTERADO",
                vendedor: oferta.vendedor,
                antes: antiga.maxQty,
                depois: oferta.maxQty
            });
        }
    }

    for (const [id, oferta] of antes) {
        if (!depois.has(id)) {
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

function testar(nome, modificar, esperado, confiavel = true) {
    const atual = copiar(inicial);

    modificar(atual);

    const resultado = comparar(inicial, atual);

    assert.equal(resultado.confiavel, confiavel);

    assert.deepEqual(
        resultado.eventos.map(e => e.tipo),
        esperado
    );

    console.log(`OK - ${nome}`);

    if (resultado.eventos.length > 0) {
        console.table(resultado.eventos);
    }
}

console.log("\n=== TESTES DE DETECCAO ===\n");

testar("Preco diminuiu", s => {
    s.ofertas[0].precoCentavos = 69990;
}, ["PRECO_ALTERADO"]);

testar("Preco aumentou", s => {
    s.ofertas[1].precoCentavos = 80000;
}, ["PRECO_ALTERADO"]);

testar("Novo vendedor", s => {
    s.ofertas.push({
        asin,
        sellerId: "VENDEDOR_NOVO",
        vendedor: "Loja Teste",
        condicao: "Novo",
        enviadoPor: "Amazon",
        offerId: "id-novo",
        precoCentavos: 65000,
        maxQty: 3,
        destaque: false
    });

    s.totalInformado = 3;
}, ["NOVA_OFERTA"]);

testar("Vendedor desapareceu", s => {
    s.ofertas.pop();
    s.totalInformado = 1;
}, ["OFERTA_DESAPARECEU"]);

testar("Limite de compra mudou", s => {
    s.ofertas[0].maxQty = 10;
}, ["LIMITE_ALTERADO"]);

testar("Ordem alterada", s => {
    s.ofertas.reverse();
}, []);

testar("Mudou para destaque", s => {
    s.ofertas[0].destaque = true;
}, []);

testar("OfferListingId mudou", s => {
    s.ofertas[0].offerId = "novo-id-cube";
}, []);

testar("Snapshot incompleto", s => {
    s.totalInformado = 12;
}, [], false);

testar("Ofertas ambiguas", s => {
    const duplicada = copiar(s.ofertas[0]);
    duplicada.offerId = "outra-oferta-cube";

    s.ofertas.push(duplicada);
    s.totalInformado = 3;
}, [], false);

console.log("\nTODOS OS TESTES PASSARAM!");
 