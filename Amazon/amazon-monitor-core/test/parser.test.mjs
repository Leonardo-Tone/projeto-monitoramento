import test from "node:test";
import assert from "node:assert/strict";

test("parser separa oferta destacada da primeira página (requer npm install)", async t => {
    let parser;
    try {
        parser = await import("../src/parser.mjs");
    } catch (erro) {
        if (erro.code === "ERR_MODULE_NOT_FOUND") {
            t.skip("Dependência Cheerio não está instalada neste ambiente offline");
            return;
        }
        throw erro;
    }
    const html = `
      <input id="aod-total-offer-count" value="1">
      <div id="aod-offer">
        <input name="items[0.base][offerListingId]" value="LIST-1">
        <div id="aod-offer-soldBy"><div class="a-col-right">
          <a href="/sp?seller=ABC123">Loja Exemplo</a>
        </div></div>
        <div id="aod-offer-shipsFrom"><span class="a-col-right">Amazon</span></div>
        <input name="submit.addToCart" aria-label="Adicionar R$ 160,00">
        <div id="aod-offer-price"><span class="apex-pricetopay-accessibility-label">R$ 152,00</span></div>
        <span data-csa-c-delivery-price="Grátis"></span>
      </div>
      <div id="aod-pinned-offer">
        <input name="items[0.base][offerListingId]" value="PIN-1">
        <div id="aod-offer-soldBy"><div class="a-col-right"><span>Amazon.com.br</span></div></div>
        <div id="aod-offer-shipsFrom"><span class="a-col-right">Amazon.com.br</span></div>
        <input name="submit.addToCart" aria-label="Comprar R$ 139,99">
        <span data-csa-c-delivery-price="Grátis"></span>
      </div>`;
    const resultado = parser.parseAodPrimeiraPagina(html);
    assert.equal(resultado.totalLista, 1);
    assert.equal(resultado.destaqueExclusivo, true);
    assert.equal(resultado.totalVisivel, 2);
    assert.equal(resultado.ofertas.find(o=>o.sellerId==="AMAZON_DIRECT").categoria,"AMAZON_DIRETA");
});
