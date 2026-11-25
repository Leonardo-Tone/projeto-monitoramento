import test from "node:test";
import assert from "node:assert/strict";
import { construirSnapshot, gerarMudancas } from "../src/domain.mjs";
import { validarConfig } from "../src/config.mjs";

const produto = {
    asin: "B000GAYQJ0", name: "Casio", enabled: true,
    categories: ["AMAZON_DIRETA", "TERCEIRO_ENVIO_AMAZON"],
    target: { maxPriceCents: 15000, priceBasis: "NORMAL", includeShipping: false, minQuantity: 1 }
};
function oferta(vendedor, categoria, preco, id = "random-id") {
    return {
        offerHash: id, sellerId: vendedor, vendedor,
        enviadoPor: "Amazon", categoria,
        precoNormalCentavos: preco, precoExibidoCentavos: null,
        freteCentavos: 0, minQty: 1, maxQty: 30
    };
}
function observacao(total, ofertas) {
    return { totalInformado: total, totalLista: ofertas.length,
        totalVisivel: ofertas.length, destaquePresente: false,
        destaqueExclusivo: false, ofertas };
}

test("hash instável não gera evento de preço", () => {
    const anterior = construirSnapshot(observacao(1, [oferta("S1", "TERCEIRO_ENVIO_AMAZON", 16000, "hash-a")]), produto);
    const atual = construirSnapshot(observacao(1, [oferta("S1", "TERCEIRO_ENVIO_AMAZON", 16000, "hash-b")]), produto);
    assert.deepEqual(gerarMudancas(anterior, atual), []);
});

test("detecta variação real do contador AOD", () => {
    const anterior = construirSnapshot(observacao(36, [oferta("S1", "TERCEIRO_ENVIO_AMAZON", 16000)]), produto);
    const atual = construirSnapshot(observacao(37, [oferta("S1", "TERCEIRO_ENVIO_AMAZON", 16000)]), produto);
    assert.deepEqual(gerarMudancas(anterior, atual).map(e => e.tipo), ["TOTAL_OFERTAS_AOD_ALTERADO"]);
});

test("meta já atingida no primeiro snapshot gera evento único", () => {
    const atual = construirSnapshot(observacao(1, [oferta("AMAZON_DIRECT", "AMAZON_DIRETA", 13999)]), produto);
    assert.equal(atual.alvo.atingido, true);
    assert.deepEqual(gerarMudancas(null, atual).map(e => e.tipo), ["ALVO_ATINGIDO"]);
    assert.deepEqual(gerarMudancas(atual, atual), []);
});

test("não classifica ausência da Amazon na página como esgotamento", () => {
    const anterior = construirSnapshot(observacao(1, [oferta("AMAZON_DIRECT", "AMAZON_DIRETA", 20000)]), produto);
    const atual = construirSnapshot(observacao(1, [oferta("S1", "TERCEIRO_ENVIO_AMAZON", 16000)]), produto);
    assert(gerarMudancas(anterior, atual).some(e => e.tipo === "AMAZON_DIRETA_NAO_OBSERVADA"));
    assert(!gerarMudancas(anterior, atual).some(e => /ESGOTAD|INDISPONIVEL/.test(e.tipo)));
});

test("frete desconhecido impede sinal de alvo com frete obrigatório", () => {
    const p = { ...produto, target: { maxPriceCents: 15000, priceBasis: "NORMAL", includeShipping: true } };
    const x = oferta("S1", "TERCEIRO_ENVIO_AMAZON", 14000);
    x.freteCentavos = null;
    assert.equal(construirSnapshot(observacao(1, [x]), p).alvo.atingido, false);
});

test("rejeita ASIN duplicado e categorias desconhecidas", () => {
    const config = {schemaVersion:1, intervalSeconds:10, maxConcurrency:10,
        timeoutMs:12000, maxConsecutiveFailures:3, products:[produto,produto]};
    assert.throws(() => validarConfig(config), /duplicado/);
});
