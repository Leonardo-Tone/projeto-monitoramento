import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkMonitorAccount, checkoutOrderReferences, matchPurchaseHistory } from '../server/account-verification.mjs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

test('session preflight accepts the signed-in account pages and rejects login redirects', async () => {
  for (const { store, requested, authenticated, login, html } of [
    {
      store: 'ml',
      requested: 'https://www.mercadolivre.com.br/accounts/profile#menu-user',
      authenticated: 'https://www.mercadolivre.com.br/pampa/profile',
      login: 'https://www.mercadolivre.com.br/auth/login',
      html: '<title>(4) Meu Perfil</title>',
    },
    {
      store: 'amazon',
      requested: 'https://www.amazon.com.br/gp/css/homepage.html',
      authenticated: 'https://www.amazon.com.br/gp/css/homepage.html',
      login: 'https://www.amazon.com.br/ap/signin',
      html: '<title>Sua conta</title><li class="ya-card-cell">Seus pedidos</li>',
    },
  ]) {
    let closed = 0;
    const check = url => checkMonitorAccount({
      store, purpose: 'monitor', projectRoot, signal: new AbortController().signal,
      browser: { newPage: async () => ({
        goto: async target => { assert.equal(target, requested); return { status: () => 200 }; },
        url: () => url, content: async () => html, close: async () => { closed++; },
      }) },
    });
    await check(authenticated);
    await assert.rejects(check(login), /perfil Monitoramento/);
    assert.equal(closed, 2);
  }
});

test('Amazon history matches the order ID from checkout, even if another order has the same product', () => {
  const store = 'amazon';
  const url = 'https://www.amazon.com.br/your-orders/orders';
  const references = checkoutOrderReferences({ store, urls: ['https://www.amazon.com.br/checkout/p/p-701-0000001-0000002/spc'] });
  const check = (id, reference = references) => matchPurchaseHistory({
    store, url, references: reference, projectRoot,
    html: `<title>Seus pedidos</title><div class="order-card"><a href="/your-orders/order-details?orderID=${id}">Mesmo produto</a></div>`,
  });
  assert.equal(check('701-0000001-0000002'), 'VERIFIED');
  assert.equal(check('701-0000001-0000003'), 'NOT_FOUND');
  assert.equal(check('701-0000001-0000002', []), 'NO_REFERENCE');
});

test('Mercado Livre history requires the same checkout references in the purchase list', () => {
  const store = 'ml';
  const url = 'https://myaccount.mercadolivre.com.br/my_purchases/list#nav-header';
  const references = checkoutOrderReferences({
    store, urls: ['https://www.mercadolivre.com.br/gz/checkout/congrats?pack_id=2000000001&order_id=2000000002'],
  });
  const check = (href, destination = url) => matchPurchaseHistory({
    store, url: destination, references, projectRoot,
    html: `<title>(6) Minhas compras</title><div id="purchase-content-wrapper"><a href="${href}">Mesmo produto</a></div>`,
  });
  assert.equal(check('/post-purchase/my-purchases/2000000003/status?packId=2000000001&amp;orderId=2000000002'), 'VERIFIED');
  assert.equal(check('/post-purchase/my-purchases/2000000003/status?packId=2000000001&amp;orderId=2000000004'), 'NOT_FOUND');
  assert.equal(check('https://example.com/post-purchase/my-purchases/2000000003/status?orderId=2000000002'), 'NOT_FOUND');
  assert.equal(check('/post-purchase/my-purchases/2000000003/status?orderId=2000000002', 'https://www.mercadolivre.com.br/auth/login'), 'UNAVAILABLE');
});
