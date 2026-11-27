import test from 'node:test';
import assert from 'node:assert/strict';
import { gotoAmazonPage } from '../server/amazon-navigation.mjs';
import { profileFetch } from '../server/profiles.mjs';
import { isCaptchaPage } from '../server/captcha-resolver.mjs';

const origin = 'https://www.amazon.com.br';
const product = origin + '/dp/B000000001';
const wall = `
  <h4>Clique no botão abaixo para continuar comprando</h4>
  <form method="get" action="/errors_page/validate">
    <input type="hidden" name="amzn-r" value="/">
    <button type="submit" alt="Continuar comprando">Continuar comprando</button>
  </form>`;

function simulateNavigation({ repeated = false, initialUrl = product, initialHtml = wall } = {}) {
  const visits = [];
  let current, html, navigationFinished, clicks = 0;
  const page = {
    url: () => current,
    content: async () => html,
    async goto(url) {
      visits.push(url);
      current = visits.length === 1 ? initialUrl : url;
      html = repeated || visits.length === 1 ? initialHtml : '<title>Produto</title>';
      return { status: () => visits.length === 1 ? 503 : 200 };
    },
    waitForNavigation() {
      return new Promise(resolve => { navigationFinished = resolve; });
    },
    async click(selector) {
      assert.match(selector, /\/errors_page\/validate.*Continuar comprando/);
      clicks++;
      current = origin + '/';
      html = '<title>Amazon</title>';
      navigationFinished({ status: () => 200 });
    },
  };
  return { page, visits, clicks: () => clicks };
}

test('Amazon clicks the continuation form and returns to the requested product', async () => {
  const { page, visits, clicks } = simulateNavigation();
  const response = await gotoAmazonPage(page, product, { timeout: 1000 });
  assert.equal(response.status(), 200);
  assert.equal(page.url(), product);
  assert.deepEqual(visits, [product, product]);
  assert.equal(clicks(), 1);
});

test('Amazon stops if the page repeats and ignores CAPTCHAs and external copies', async () => {
  const repeated = simulateNavigation({ repeated: true });
  await assert.rejects(gotoAmazonPage(repeated.page, product), { code: 'CAPTCHA' });
  assert.equal(repeated.clicks(), 1);
  assert.equal(isCaptchaPage(product, wall), true);

  for (const example of [
    { initialHtml: '<form action="/errors/validateCaptcha"><input id="captchacharacters"></form>' },
    { initialUrl: 'https://example.test/' },
  ]) {
    const { page, visits, clicks } = simulateNavigation(example);
    const response = await gotoAmazonPage(page, product);
    assert.equal(response.status(), 503);
    assert.deepEqual(visits, [product]);
    assert.equal(clicks(), 0);
  }
});

test('parallel Amazon offer reads share one recovery and retry their own URLs', async () => {
  const visits = [], recoveries = [], parsed = [];
  const offers = [1, 2, 3].map(id => origin + '/gp/product/ajax/aodAjaxMain/?asin=B00000000' + id);
  const request = profileFetch({
    async evaluate(_fn, { url }) {
      visits.push(url);
      return recoveries.length ? { status: 200, url, html: 'Oferta' } : { status: 503, url, html: wall };
    },
  }, {
    async recoverShoppingWall(url) { recoveries.push(url); },
    onHtml(html, url) { parsed.push([html, url.href]); },
  });
  const responses = await Promise.all(offers.map(request));
  assert.deepEqual(await Promise.all(responses.map(response => response.text())), ['Oferta', 'Oferta', 'Oferta']);
  assert.deepEqual(recoveries, [offers[0]]);
  assert.deepEqual(visits, [...offers, ...offers]);
  assert.deepEqual(parsed, offers.map(url => ['Oferta', url]));
});

test('Amazon offer reads stop after one retry if the response still contains the form', async () => {
  let reads = 0, recoveries = 0;
  const request = profileFetch({
    async evaluate(_fn, { url }) {
      reads++;
      return { status: 200, url, html: wall };
    },
  }, {
    async recoverShoppingWall() { recoveries++; },
    onHtml() { assert.fail('O formulário não deve ser tratado como uma oferta.'); },
  });
  await assert.rejects(request(product), /exige verificação manual/);
  assert.equal(reads, 2);
  assert.equal(recoveries, 1);
});
