import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { amazonCandidates, runAmazonPurchase, validateAmazonCart } from '../server/amazon-purchase.mjs';
import { createAmazonCheckoutParser, validateAmazonReview } from '../server/amazon-checkout.mjs';
import { crc16 } from '../server/purchase-html.mjs';
import { PurchaseManager } from '../server/purchase-manager.mjs';
import { defaults, validateSettings } from '../server/availability.mjs';
import { installAmazonPixCopy, validateAmazonPix } from '../server/amazon-pix-copy.mjs';
import { runInNewContext } from 'node:vm';
import { observeAmazonPaymentButtons, redactAmazonHtml } from '../server/amazon-diagnostics.mjs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const parser = createAmazonCheckoutParser(projectRoot);
const item = { productId: 'amz1', itemId: 'B0H3QKR97T', name: 'Produto de teste', sellerId: 'A1Z0XCS08FSLUJ', unitCents: 27090, quantity: 1, limitCents: 27090 };
const summary = (label, type, amount) => '<div class="order-summary-grid"><div class="order-summary-line-term">' + label +
  '</div><div class="order-summary-line-definition"><input name="subtotalLineType" value="' + type + '">' + amount + '</div></div>';
const reviewHtml = '<div id="selected-payment-methods-list-container"><span id="payment-option-text-default">Pagando com Pix</span></div>' +
  '<span id="deliver-to-address-text">Endereço de teste</span><div class="rcx-checkout-delivery-option-a-control-row" data-isselected="true"><input type="radio" value="padrão" checked></div>' +
  '<div class="lineitem-container"><p class="lineitem-seller-section">Vendido por <a href="/gp/help/seller/at-a-glance.html?seller=A1Z0XCS08FSLUJ">Midgard Toys</a></p>' +
  '<fieldset name="checkout-quantity-stepper" data-steppervalue="1"><span class="a-stepper-value-live">1</span></fieldset></div>' +
  '<span data-testid="Item_asin_0_0_0" class="aok-hidden">B0H3QKR97T</span>' +
  summary('Itens:', 'ITEMS_TAX_INCLUSIVE', 'R$ 270,90') + summary('Frete:', 'SHIPPING_TAX_INCLUSIVE', 'R$ 0,00') +
  summary('Total:', 'TOTAL_BEFORE_SPECIAL_PAYMENTS_TAX_INCLUSIVE', 'R$ 270,90') +
  '<div class="a-row a-color-success"><div class="a-column">Desc. forma pgto</div><div class="a-column"><span data-shimmer-target="ordertotals-amount">-R$ 13,55</span></div></div>' +
  summary('Total do pedido:', '', 'R$ 257,35');
const cartHtml = '<div id="sc-buy-box"><div class="sc-list-item" data-asin="B0H3QKR97T" data-itemid="cart-1" data-isselected="1" data-quantity="1" data-outofstock="0" data-displayprice="270.90" data-encoded-offering="offer%2F1">' +
  '<a href="/gp/help/seller/at-a-glance.html?seller=A1Z0XCS08FSLUJ">Midgard Toys</a></div></div>';
const pixHtml = '<h2 data-testid="heading">Total a pagar: R$ 257,35</h2><svg data-testid="qr-code"></svg><div data-testid="Upx-Prepare-PrimaryButton"><button>Copiar código</button></div>';
const settings = defaults();
settings.amazon.purchase.enabled = true;
const field = (tag, value) => tag + String(Buffer.byteLength(value)).padStart(2, '0') + value;
const seal = value => value + '6304' + crc16(value + '6304');
const code = seal('000201010212' + field('26', '0014br.gov.bcb.pix' + field('25', 'pix.example.test/charge')) + '53039865802BR');

test('Amazon checks the seller, ASIN, exact quantity and real Pix discount on review', () => {
  const review = parser.review(reviewHtml);
  const rules = settings.amazon.purchase;
  assert.deepEqual(validateAmazonReview(review, item, rules), {
    subtotalCents: 27090, shippingCents: 0, grossShippingCents: 0, shippingDiscountCents: 0,
    beforeDiscountCents: 27090, pixDiscountCents: 1355, totalCents: 25735,
  });
  assert.throws(() => validateAmazonReview({ ...review, beforeDiscountCents: 27091 }, item, rules), /conciliados/);
  const freeShipping = reviewHtml.replaceAll('270,90', '249,90').replace('R$ 0,00', 'R$ 8,90')
    .replace('TOTAL_BEFORE_SPECIAL_PAYMENTS_TAX_INCLUSIVE">R$ 249,90', 'TOTAL_BEFORE_SPECIAL_PAYMENTS_TAX_INCLUSIVE">R$ 258,80')
    .replace('Desc. forma pgto', 'Frete GRÁTIS.').replace('-R$ 13,55', '-R$ 8,90').replace('R$ 257,35', 'R$ 249,90');
  assert.deepEqual(validateAmazonReview(parser.review(freeShipping), { ...item, unitCents: 24990 }, { ...rules, freeShippingOnly: true }), {
    subtotalCents: 24990, shippingCents: 0, grossShippingCents: 890, shippingDiscountCents: 890,
    beforeDiscountCents: 25880, pixDiscountCents: 0, totalCents: 24990,
  });
  for (const invalid of [
    { ...review, sellerId: 'ANOTHER' }, { ...review, asin: 'B000000000' }, { ...review, quantity: 2 },
    { ...review, delivery: null }, { ...review, totalCents: 25736 }, { ...review, pix: false },
  ]) assert.throws(() => validateAmazonReview(invalid, item, rules));
  assert.throws(() => validateAmazonReview(review, { ...item, limitCents: 25735 }, rules), /limite/);
  assert.equal(parser.pix(pixHtml).totalCents, 25735);
});

test('Amazon cart rejects a different offer token or another selected item', () => {
  const cart = parser.cart(cartHtml);
  assert.equal(validateAmazonCart(cart, item, 'offer/1', 1).itemId, 'cart-1');
  assert.throws(() => validateAmazonCart(cart, item, 'other', 1));
  assert.throws(() => validateAmazonCart({ ...cart, lines: [...cart.lines, { ...cart.lines[0], asin: 'B000000000' }] }, item, 'offer/1', 1));
});

test('Amazon dynamic Pix requires a valid reference and the matching portal total', () => {
  assert.deepEqual(validateAmazonPix(code, 25735, 25735), { code, totalCents: 25735 });
  assert.throws(() => validateAmazonPix(code, 25735, 24990), /diverge/);
  assert.throws(() => validateAmazonPix(code.slice(0, -4) + 'zzzz', 25735, 25735), /inválido/);
  const withoutLocation = seal('000201010212' + field('26', '0014br.gov.bcb.pix') + '53039865802BR');
  assert.throws(() => validateAmazonPix(withoutLocation, 25735, 25735), /Referência/);
});

const product = () => ({
  id: item.productId, store: 'amazon', code: item.itemId, auto: true, available: true, name: item.name, target: 270.90, quantity: 1,
  lastCheckedAt: new Date().toISOString(), amazonOffers: [{
    sellerId: item.sellerId, vendedor: 'Midgard Toys', enviadoPor: 'Midgard Toys', categoria: 'TERCEIRO_ENVIO_PROPRIO',
    precoNormalCentavos: 27090, minQty: 1, maxQty: 1,
  }],
});

test('Amazon settings migrate disabled and reject card; candidate respects limits and existing orders', () => {
  assert.equal(validateSettings({ ...defaults(), amazon: { onlyAmazon: false } }).amazon.purchase.enabled, false);
  assert.throws(() => validateSettings({ ...settings, amazon: { onlyAmazon: false, purchase: { paymentMethod: 'credit_card', cardLastFour: '1234' } } }), /somente Pix/);
  const watched = product();
  const ids = new Set([watched.id]);
  assert.equal(amazonCandidates([watched], [], ids, settings.amazon).length, 1);
  assert.equal(amazonCandidates([{ ...watched, quantity: 2 }], [], ids, settings.amazon).length, 0);
  assert.equal(amazonCandidates([watched], [{ store: 'amazon', status: 'UNCERTAIN', items: [{ ...item, productId: 'old-id' }] }], ids, settings.amazon).length, 0);
});

test('Amazon persists a finalizing attempt and keeps it blocked after losing the Pix page', async () => {
  const watched = product();
  const registry = { purchaseOrders: [] };
  const saved = [];
  let attempts = 0;
  const manager = new PurchaseManager({
    registry, save: async state => saved.push(state.purchaseOrders.at(-1).status),
    getSettings: () => settings, getProducts: () => [watched], getExpectedStores: () => ['amazon', 'ml'],
    isPurchaseProfileOpen: () => false, notify: async () => {},
    amazonRunner: async ({ stage }) => {
      attempts++;
      await stage('FINALIZING', 'Confirmando');
      assert.equal(saved.at(-1), 'FINALIZING');
      throw new Error('Chrome fechou');
    },
  });
  manager.resetCycles();
  await manager.cycle('amazon', { ids: [watched.id] });
  await manager.task;
  assert.equal(registry.purchaseOrders[0].status, 'UNCERTAIN');
  assert.match(registry.purchaseOrders[0].message, /Meus Pedidos/);
  await manager.cycle('amazon', { ids: [watched.id] });
  assert.equal(attempts, 1);
});

test('Pix clipboard hook captures the widget write while preserving the system clipboard', async () => {
  let osClipboard = 'conteúdo anterior';
  class Clipboard { async writeText(value) { osClipboard = value; } }
  class Document { execCommand() { return false; } }
  const navigator = { clipboard: new Clipboard() };
  const context = { navigator, Document, location: { origin: 'https://www.amazon.com.br' } };
  runInNewContext('(' + installAmazonPixCopy.toString() + ')(location.origin)', context);
  assert.equal(context.__vigiaAmazonPixCopy('arm'), true);
  await navigator.clipboard.writeText(code);
  assert.equal(context.__vigiaAmazonPixCopy('read'), code);
  context.__vigiaAmazonPixCopy('clear');
  assert.equal(context.__vigiaAmazonPixCopy('read'), null);
  assert.equal(osClipboard, 'conteúdo anterior');
  await navigator.clipboard.writeText('cópia manual');
  assert.equal(osClipboard, 'cópia manual');
});

function simulateBrowser({ loseAfterConfirm = false, cartReadError, directOffer = false, paymentFlow, deliveryBlocked = false, existingAsin, paymentBaseline } = {}) {
  const base = 'https://www.amazon.com.br';
  let cartAdded = false, finalClicks = 0;
  let activeTab;
  const stages = [];
  const paymentActions = [];
  const cartActions = [];
  let otherSelected = Boolean(existingAsin);
  const page = () => {
    const tab = Symbol('tab');
    const listeners = new Map();
    activeTab = tab;
    let url, copied = false, checkoutView = paymentFlow === 'prime' ? 'payment-list' : paymentFlow ? 'card' : 'pix-review';
    let keyboardUsed = false;
    let continueProbes = 0;
    const selectPix = (viaKeyboard = false) => {
      keyboardUsed ||= viaKeyboard;
      paymentActions.push(viaKeyboard && paymentFlow === 'stalled' ? 'retry-pix' : 'pix');
      checkoutView = paymentFlow === 'auto' ? 'pix-review' : 'pix-selected';
    };
    const element = action => ({
      asElement() { return this; }, async dispose() {}, async evaluate() { return { oid: 'offer%2F1', minQty: 1 }; },
      async click() { assert.equal(activeTab, tab, 'O clique precisa ocorrer na aba ativa.'); await action(); },
    });
    const html = () => {
      if (url.endsWith('/cart')) {
        if (cartReadError) throw cartReadError;
        const other = existingAsin
          ? '<div class="sc-list-item" data-asin="' + existingAsin + '" data-itemid="other-1" data-isselected="' + Number(otherSelected) + '"></div>'
          : '';
        return (cartAdded ? cartHtml : '<div id="sc-active-cart"></div>') + other;
      }
      if (url.includes('/checkout')) {
        if (deliveryBlocked || (paymentFlow === 'trace' && checkoutView === 'pix-review')) return '<div data-messageid="NoDeliveryOptionAvailableForLineItemMessage"><span>Lamentamos, esse item não está disponível no seu endereço nesse momento.</span></div>';
        const html = directOffer ? reviewHtml.replace('Midgard Toys', 'Amazon.com.br') : reviewHtml;
        return checkoutView === 'pix-review' ? html : html.replace('Pagando com Pix', 'Cartão de crédito');
      }
      if (url.includes('/payments-portal')) return pixHtml;
      return '';
    };
    return {
      url: () => url, async evaluateOnNewDocument() {},
      on(event, handler) { listeners.set(event, handler); },
      mouse: { async click(x, y) {
        assert.equal(activeTab, tab);
        assert.deepEqual([x, y], [18, 18]);
        if (paymentFlow === 'trace') {
          const request = { method: () => 'POST', url: () => base + '/checkout/p/p-private-id/pay/continue?token=private-query' };
          listeners.get('request')?.(request);
          listeners.get('response')?.({ request: () => request, status: () => 200 });
        }
        selectPix();
      } },
      async bringToFront() { activeTab = tab; },
      async goto(next) { url = next; return { status: () => 200 }; },
      target: () => ({ async createCDPSession() {
        return {
          async send(command) {
            if (command === 'DOM.getDocument') return { root: { nodeId: 1 } };
            assert.equal(command, 'DOM.getOuterHTML');
            return { outerHTML: html() };
          },
          async detach() {},
        };
      } }),
      async evaluateHandle(fn, args) {
        assert.equal(activeTab, tab, 'A busca do controle precisa ocorrer na aba ativa.');
        const selector = args.selector;
        if (!selector && directOffer) {
          const input = Object.assign(element(() => { cartAdded = true; }), {
            getClientRects: () => [{}], closest: () => null,
            getAttribute: () => 'Adicionar ao carrinho do vendedor Amazon.com.br e preço R$ 270,90',
          });
          const seller = {
            textContent: 'Amazon.com.br Política de devolução',
            querySelector: selector => selector === ':scope > span' ? { textContent: ' Amazon.com.br ' } : null,
          };
          const row = { querySelector: selector => selector.includes('soldBy') ? seller : { textContent: 'Amazon.com.br' } };
          const action = {
            closest: () => row, querySelector: () => input,
            getAttribute: () => JSON.stringify({ asin: args.itemId, oid: 'offer%2F1', minQty: 1, maxQty: 22 }),
          };
          const locate = runInNewContext('(' + fn.toString() + ')', { document: { querySelectorAll: () => [action] } });
          const result = locate(args);
          assert.equal(result, input);
          return result;
        }
        if (!selector) return element(() => { cartActions.push('add'); cartAdded = true; });
        if (selector.includes('aod-ingress')) return element(() => {});
        if (selector.includes('.sc-item-checkbox') && otherSelected) return element(() => {
          assert.match(selector, /data-itemid="other-1".*:checked:enabled/);
          cartActions.push('deselect'); otherSelected = false;
        });
        if (selector.includes('proceedToRetailCheckout')) return element(() => {
          assert.equal(otherSelected, false);
          url = base + '/checkout/spc';
        });
        if (selector.includes('checkout-change-payselect') && checkoutView === 'card') return element(() => {
          paymentActions.push('change'); checkoutView = 'payment-list';
        });
        if (selector.includes('ppw-instrumentRowSelection') && ['payment-list', 'pix-selected'].includes(checkoutView)) {
          const makeRadio = (textContent, pix, checked) => {
            const rect = { left: 10, right: 26, top: 10, bottom: 26 };
            const indicator = { getClientRects: () => [rect] };
            const label = {
              textContent, getClientRects: () => [{ left: 30, right: 70, top: 10, bottom: 26 }], querySelector: () => indicator,
              scrollIntoView() {}, contains: hit => hit === label || hit === indicator,
            };
            const input = Object.assign(element(() => assert.fail('A seleção deve usar o mouse do Puppeteer.')), {
              checked, value: pix ? 'instrumentId=fixture&paymentMethod=Pix' : 'paymentMethod=CreditCard',
              isConnected: true, matches: () => false, getClientRects: () => [{ left: 40, right: 50, top: 10, bottom: 26 }],
              closest: target => target === 'label' ? label : target === '.pmts-instrument-box' ? { querySelector: () => pix } : null,
              async focus() { this.focused = true; },
              async press(key) { assert.equal(key, 'Space'); assert.equal(this.focused, true); selectPix(true); },
              async evaluate(callback) {
                assert.equal(pix, true);
                const inspect = runInNewContext('(' + callback.toString() + ')', {
                  innerWidth: 100, innerHeight: 100,
                  document: { elementFromPoint: x => paymentFlow === 'keyboard' ? null : x === 18 ? indicator : label, activeElement: this.focused ? input : null },
                });
                return inspect(input);
              },
            });
            return input;
          };
          const radios = [
            makeRadio('Cartão de crédito', false, checkoutView === 'payment-list'),
            makeRadio('O código Pix gerado para o pagamento é válido por 30 minutos após a finalização do pedido.', true, checkoutView === 'pix-selected'),
          ];
          const locate = runInNewContext('(' + fn.toString() + ')', {
            document: { querySelectorAll: () => radios },
            getComputedStyle: () => ({ visibility: 'visible' }),
            URLSearchParams,
          });
          return locate(args) ?? { asElement: () => null, async dispose() {} };
        }
        if (selector.includes(paymentFlow === 'stalled' ? 'secondary-continue-button' : 'bottom-continue-button') &&
            checkoutView === 'pix-selected' && (paymentFlow !== 'stalled' || keyboardUsed)) {
          continueProbes++;
          if (paymentFlow === 'stabilize' && continueProbes === 2) return { asElement: () => null, async dispose() {} };
          return element(() => {
            assert.match(selector, /checkout-(?:primary|secondary)-continue-payselect/);
            if (paymentFlow === 'stabilize') assert.ok(continueProbes >= 5, 'O botão deve permanecer habilitado após voltar a aparecer.');
            paymentActions.push('continue');
            checkoutView = paymentFlow === 'prime' ? 'prime' : 'pix-review';
          });
        }
        if (selector.includes('action=decline') && checkoutView === 'prime') return element(() => {
          paymentActions.push('decline-prime');
          checkoutView = 'pix-review';
          url = base + '/checkout/p/order-test/spc';
        });
        if (selector.includes('SPC_selectPlaceOrder') && checkoutView === 'pix-review') return element(() => {
          assert.equal(stages.at(-1), 'FINALIZING');
          finalClicks++;
          if (loseAfterConfirm) throw new Error('O Chrome fechou após o clique');
          url = base + '/payments-portal/pix';
        });
        if (selector.includes('Upx-Prepare-PrimaryButton')) return element(() => { copied = true; });
        return { asElement: () => null, async dispose() {} };
      },
      async evaluate(fn, action) {
        if (Array.isArray(action) && paymentBaseline) {
          assert.deepEqual(paymentActions, []);
          const [principalDisabled, lateralDisabled] = paymentBaseline.shift();
          const document = { querySelector: selector => ({
            matches: state => {
              assert.equal(state, ':disabled');
              return selector.includes('primary') ? principalDisabled : lateralDisabled;
            },
          }) };
          return runInNewContext(`(${fn})(selectors)`, { document, selectors: action });
        }
        if (action === 'arm') return true;
        if (action === 'read') return copied ? code : null;
        return null;
      },
    };
  };
  return {
    headlessMode: '0',
    launcher: async () => ({ browser: { newPage: async () => page(), close: async () => {} } }),
    stage: async status => { stages.push(status); },
    finalClicks: () => finalClicks,
    paymentActions,
    cartActions,
  };
}

test('Amazon runner has a no-submit review mode and sends one final click before reading Pix', async () => {
  const run = (browser, reviewOnly) => runAmazonPurchase({
    ...browser, reviewOnly, order: { items: [item], payment: 'pix' }, settings, projectRoot,
  });
  const review = simulateBrowser();
  assert.equal((await run(review, true)).totalCents, 25735);
  assert.equal(review.finalClicks(), 0);
  const live = simulateBrowser();
  const result = await run(live, false);
  assert.equal(result.code, code);
  assert.equal(result.paid, false);
  assert.equal(live.finalClicks(), 1);
  const interrupted = simulateBrowser({ loseAfterConfirm: true });
  await assert.rejects(run(interrupted, false), /Chrome fechou/);
  assert.equal(interrupted.finalClicks(), 1);
});

test('Amazon runner reports a cart DOM timeout at the initial cart read, before any confirmation', async () => {
  const browser = simulateBrowser({ cartReadError: new Error('DOM.getOuterHTML timed out') });
  await assert.rejects(runAmazonPurchase({
    ...browser, order: { items: [item], payment: 'pix' }, settings, projectRoot,
  }), { message: 'DOM.getOuterHTML timed out', purchaseStep: 'Lendo o carrinho inicial da Amazon.' });
  assert.equal(browser.finalClicks(), 0);
});

test('Amazon identifies its own live offer when the seller row includes a return-policy link', async () => {
  const browser = simulateBrowser({ directOffer: true });
  const direct = { ...item, sellerId: 'AMAZON_DIRECT', seller: 'Amazon.com.br', shippedBy: 'Amazon.com.br' };
  const result = await runAmazonPurchase({
    ...browser, reviewOnly: true, order: { items: [direct], payment: 'pix' }, settings, projectRoot,
  });
  assert.equal(result.totalCents, 25735);
  assert.equal(browser.finalClicks(), 0);
});

test('Amazon opens the payment editor and reaches Pix review with or without a Continue button', async () => {
  for (const paymentFlow of ['auto', 'continue', 'keyboard', 'stabilize']) {
    const browser = simulateBrowser({ paymentFlow });
    const result = await runAmazonPurchase({
      ...browser, reviewOnly: true, order: { items: [item], payment: 'pix' }, settings, projectRoot,
    });
    assert.equal(result.totalCents, 25735);
    assert.deepEqual(browser.paymentActions, paymentFlow === 'auto' ? ['change', 'pix'] : ['change', 'pix', 'continue']);
    assert.equal(browser.finalClicks(), 0);
  }
});

test('Amazon selects Pix, uses that payment method, declines Prime and only then reviews the order', async () => {
  const browser = simulateBrowser({ paymentFlow: 'prime' });
  const result = await runAmazonPurchase({
    ...browser, reviewOnly: true, order: { items: [item], payment: 'pix' }, settings, projectRoot,
  });
  assert.deepEqual(browser.paymentActions, ['pix', 'continue', 'decline-prime']);
  assert.equal(result.totalCents, 25735);
  assert.equal(browser.finalClicks(), 0);
});

test('Amazon retries a checked Pix using Puppeteer keyboard when neither payment Continue control is initially enabled', async () => {
  const browser = simulateBrowser({ paymentFlow: 'stalled' });
  const result = await runAmazonPurchase({
    ...browser, reviewOnly: true, order: { items: [item], payment: 'pix' }, settings, projectRoot,
  });
  assert.deepEqual(browser.paymentActions, ['change', 'pix', 'retry-pix', 'continue']);
  assert.equal(result.totalCents, 25735);
  assert.equal(browser.finalClicks(), 0);
});

test('Amazon stops before payment if checkout rejects delivery to the selected address', async () => {
  const browser = simulateBrowser({ deliveryBlocked: true });
  await assert.rejects(runAmazonPurchase({
    ...browser, order: { items: [item], payment: 'pix' }, settings, projectRoot,
  }), { message: /não está disponível para entrega no endereço selecionado/, purchaseStep: 'Verificando disponibilidade de entrega no endereço da Amazon.' });
  assert.deepEqual(browser.paymentActions, []);
  assert.equal(browser.finalClicks(), 0);
});

test('Amazon writes a local checkout snapshot on failure without exposing account data', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'vigia-amazon-html-'));
  try {
    const browser = simulateBrowser({ deliveryBlocked: true });
    await assert.rejects(runAmazonPurchase({
      ...browser, order: { items: [item], payment: 'pix' }, settings, projectRoot, dataDirectory,
    }), error => {
      assert.match(error.diagnosticFile, /^diagnostics\/amazon-falha-.*\.html$/);
      return true;
    });
    assert.equal(browser.finalClicks(), 0);
    const [file] = await readdir(join(dataDirectory, 'diagnostics'));
    const html = await readFile(join(dataDirectory, 'diagnostics', file), 'utf8');
    assert.match(html, /NoDeliveryOptionAvailableForLineItemMessage/);
    assert.match(html, /\/checkout\/spc/);
    assert.match(html, /&lt;div/);
    const redacted = redactAmazonHtml('<script>segredo-script</script><div id="deliver-to-address-text">Rua Privada</div><a href="/pay?token=segredo-url">Continuar</a><input type="text" value="4111111111111111"><p>Nome Pessoal</p>', projectRoot);
    assert.match(redacted, /Continuar/);
    assert.doesNotMatch(redacted, /segredo|Rua Privada|4111111111111111|Nome Pessoal/);
  } finally { await rm(dataDirectory, { recursive: true, force: true }); }
});

test('Amazon payment observation captures a brief unlock within a mutation batch', () => {
  let changes;
  const input = {
    id: '',
    matches: () => true,
    closest: () => null,
    getAttribute: name => name === 'data-testid' ? 'bottom-continue-button' : '',
  };
  const context = {
    location: { origin: 'https://www.amazon.com.br' },
    document: { getElementById: id => id.includes('primary') ? { querySelector: () => input } : null },
    MutationObserver: class {
      constructor(callback) { changes = callback; }
      observe() {}
    },
  };
  runInNewContext(`(${observeAmazonPaymentButtons})()`, context);
  const mutation = { type: 'attributes', target: input, attributeName: 'disabled' };
  changes([{ ...mutation, oldValue: '' }, { ...mutation, oldValue: null }]);
  const messages = Array.from(context.__vigiaAmazonPaymentEvents, event => event.message);
  assert.deepEqual(messages.slice(-2), ['principal: disabled true → false', 'principal: disabled false → true']);
});

test('Amazon headless diagnostic validates the review and stops before order confirmation', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'vigia-amazon-headless-'));
  try {
    const paymentBaseline = [[false, false], [true, false], [true, true]];
    const browser = simulateBrowser({ paymentFlow: 'prime', paymentBaseline });
    await assert.rejects(runAmazonPurchase({
      ...browser, headlessMode: '1', order: { items: [item], payment: 'pix' }, settings, projectRoot, dataDirectory,
      launcher: options => {
        assert.equal(options.headless, true);
        return browser.launcher(options);
      },
    }), error => {
      assert.match(error.message, /revisão do pedido Pix validada/);
      assert.match(error.diagnosticFile, /^diagnostics\/amazon-headless-.*\.html$/);
      return true;
    });
    const [file] = await readdir(join(dataDirectory, 'diagnostics'));
    const html = await readFile(join(dataDirectory, 'diagnostics', file), 'utf8');
    assert.deepEqual(paymentBaseline, []);
    assert.match(html, /Aguardando os botões principal e lateral/);
    assert.match(html, /Estado inicial confirmado:[\s\S]*Puppeteer: clique/);
    assert.match(html, /Vigia detectou o botão principal habilitado/);
    assert.match(html, /Página da revisão validada/);
    assert.deepEqual(browser.paymentActions, ['pix', 'continue', 'decline-prime']);
    assert.equal(browser.finalClicks(), 0);
  } finally { await rm(dataDirectory, { recursive: true, force: true }); }
});

test('Amazon defaults to headless, confirms once and returns a validated unpaid Pix', async () => {
  const run = browser => runAmazonPurchase({
    ...browser, headlessMode: undefined, order: { items: [item], payment: 'pix' }, settings, projectRoot,
    launcher: options => {
      assert.equal(options.headless, true);
      return browser.launcher(options);
    },
  });
  const browser = simulateBrowser({ paymentFlow: 'prime', paymentBaseline: [[true, false], [true, true]] });
  const result = await run(browser);
  assert.deepEqual(browser.paymentActions, ['pix', 'continue', 'decline-prime']);
  assert.equal(browser.finalClicks(), 1);
  assert.equal(result.code, code);
  assert.equal(result.totalCents, 25735);
  assert.equal(result.paid, false);

  const interrupted = simulateBrowser({ paymentFlow: 'prime', paymentBaseline: [[true, true]], loseAfterConfirm: true });
  await assert.rejects(run(interrupted), /Chrome fechou/);
  assert.equal(interrupted.finalClicks(), 1);
});

test('Amazon records the Pix selection POST and HTTP status without persisting the checkout identifier or query', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'vigia-amazon-post-'));
  try {
    const browser = simulateBrowser({ paymentFlow: 'trace' });
    await assert.rejects(runAmazonPurchase({
      ...browser, order: { items: [item], payment: 'pix' }, settings, projectRoot, dataDirectory,
    }), /não está disponível para entrega/);
    const [file] = await readdir(join(dataDirectory, 'diagnostics'));
    const html = await readFile(join(dataDirectory, 'diagnostics', file), 'utf8');
    assert.match(html, /Acionamentos do Pix: círculo Pix/);
    assert.match(html, /POST \/checkout\/p\/:id\/pay\/continue: seleção do Pix \(HTTP 200\)/);
    assert.doesNotMatch(html, /private-id|private-query/);
    assert.equal(browser.finalClicks(), 0);
  } finally { await rm(dataDirectory, { recursive: true, force: true }); }
});

test('Amazon deselects unrelated cart items and refuses to duplicate an existing target', async () => {
  const run = browser => runAmazonPurchase({
    ...browser, reviewOnly: true, order: { items: [item], payment: 'pix' }, settings, projectRoot,
  });
  const unrelated = simulateBrowser({ existingAsin: 'B0H7XF3LJL' });
  assert.equal((await run(unrelated)).totalCents, 25735);
  assert.deepEqual(unrelated.cartActions, ['deselect', 'add']);
  assert.equal(unrelated.finalClicks(), 0);
  const same = simulateBrowser({ existingAsin: item.itemId });
  await assert.rejects(run(same), /evitar duplicidade/);
  assert.deepEqual(same.cartActions, []);
});
