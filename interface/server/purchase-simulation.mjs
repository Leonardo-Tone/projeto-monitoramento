import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomInt } from 'node:crypto';
import { runAmazonPurchase } from './amazon-purchase.mjs';
import { runPurchase } from './purchase-runner.mjs';
import { createProfilePool, launchDedicatedProfile } from './profiles.mjs';
import { defaults } from './availability.mjs';
import { crc16 } from './purchase-html.mjs';
import { amazonOrigin } from './amazon-checkout.mjs';
import { checkoutSelectionInPage } from './purchase-clicks.mjs';

export const PURCHASE_SIMULATION_SCENARIOS = {
  'purchase-amazon-pix': {
    id: 'purchase-amazon-pix',
    store: 'amazon',
    storeLabel: 'Amazon',
    payment: 'pix',
    paymentLabel: 'Pix',
    name: 'Simulação de compra · Amazon (Pix)',
  },
  'purchase-amazon-card': {
    id: 'purchase-amazon-card',
    store: 'amazon',
    storeLabel: 'Amazon',
    payment: 'credit_card',
    paymentLabel: 'Cartão de crédito',
    name: 'Simulação de compra · Amazon (Cartão)',
  },
  'purchase-ml-pix': {
    id: 'purchase-ml-pix',
    store: 'ml',
    storeLabel: 'Mercado Livre',
    payment: 'pix',
    paymentLabel: 'Pix',
    name: 'Simulação de compra · Mercado Livre (Pix)',
  },
  'purchase-ml-card': {
    id: 'purchase-ml-card',
    store: 'ml',
    storeLabel: 'Mercado Livre',
    payment: 'credit_card',
    paymentLabel: 'Cartão de crédito',
    name: 'Simulação de compra · Mercado Livre (Cartão)',
  },
};

function formatBrl(centsValue) {
  const negative = centsValue < 0;
  const abs = Math.abs(centsValue);
  const reais = Math.floor(abs / 100).toLocaleString('pt-BR');
  const centavos = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}R$ ${reais},${centavos}`;
}

function buildAmazonPixCode() {
  const field = (tag, value) => tag + String(Buffer.byteLength(value)).padStart(2, '0') + value;
  const body = '000201010212' + field('26', '0014br.gov.bcb.pix' + field('25', 'pix.sim.amazon.invalid/charge/7011234567')) + '53039865802BR';
  return body + '6304' + crc16(body + '6304');
}

function buildMlPixCode(totalReais) {
  const tag = (id, value) => id + String(Buffer.byteLength(value)).padStart(2, '0') + value;
  const payload = tag('00', '01')
    + tag('26', tag('00', 'br.gov.bcb.pix') + tag('01', 'simulacao@mercadolivre.invalid'))
    + tag('52', '0000')
    + tag('53', '986')
    + tag('54', totalReais.toFixed(2))
    + tag('58', 'BR')
    + tag('59', 'VIGIA SIM')
    + tag('60', 'SAO PAULO')
    + tag('62', tag('05', '***'))
    + '6304';
  return payload + crc16(payload);
}

async function runAmazonSimulation({ projectRoot, payment, amazonFlow = 'random', onLog = () => {} }) {
  const isCard = payment === 'credit_card';
  const chosenFlow = amazonFlow === 'A' || amazonFlow === 'B'
    ? amazonFlow
    : (randomInt(0, 2) === 0 ? 'A' : 'B');
  const flowLabel = chosenFlow === 'A'
    ? 'Fluxo A (botões desabilitados → seleção direta)'
    : 'Fluxo B (outro método pré-selecionado → Alterar pagamento + recusa Prime)';

  onLog(`[Simulação Amazon] Pagamento: ${isCard ? 'Cartão de crédito' : 'Pix'} | Caminho sorteado: ${flowLabel}\n`);

  const tempDir = await mkdtemp(join(tmpdir(), 'vigia-sim-amz-'));
  const pool = createProfilePool(launchDedicatedProfile);
  const item = {
    productId: 'sim-amz-1',
    itemId: 'B0SIM00001',
    name: 'Produto Simulado Vigia Amazon',
    sellerId: 'AMAZON_DIRECT',
    seller: 'Amazon.com.br',
    shippedBy: 'Amazon.com.br',
    quantity: 1,
    requestedQuantity: 1,
    limitCents: 9000,
    unitCents: 7799,
  };
  const cardLastFour = '2454';
  const pixDiscountCents = isCard ? 0 : 390;
  const totalCents = item.unitCents - pixDiscountCents;
  const oid = 'simOffer/2026/01';
  const orderId = '701-1234567-8901234';
  const pixCode = buildAmazonPixCode();

  const events = [];
  const stages = [];
  const recoveredFaults = [];
  let otherSelected = true;
  let itemInCart = false;
  let checkoutPhase = chosenFlow === 'A' ? 'payselect' : 'review_wrong_method';
  let chosenMethod = chosenFlow === 'A' ? null : (isCard ? 'pix' : 'other_card');
  let finalClicks = 0;
  let launchAttempt = 0;
  let sessionFaultClosed = false;
  let shoppingWallPending = true;
  let shoppingWallRecovered = false;

  const summaryRow = (label, type, amountCents) =>
    `<div class="order-summary-grid"><div class="order-summary-line-term">${label}</div>` +
    `<div class="order-summary-line-definition"><input name="subtotalLineType" value="${type}">${formatBrl(amountCents)}</div></div>`;

  const actionJs = (type, extra = '') =>
    `fetch('/sim/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'${type}',trusted:event.isTrusted${extra}})})`;

  const cartHtml = () => `<!doctype html><html><head><title>Carrinho Amazon Simulado</title></head><body>
    <div id="sc-active-cart"><div id="sc-buy-box">
      <div class="sc-list-item" data-asin="B0OTHER999" data-itemid="cart-other" data-isselected="${otherSelected ? '1' : '0'}" data-quantity="1" data-outofstock="0" data-displayprice="49.90" data-encoded-offering="other-oid">
        <div class="sc-item-checkbox"><label><input type="checkbox" ${otherSelected ? 'checked' : ''} onclick="${actionJs('uncheck-other')}.then(()=>location.reload())"> Outro item</label></div>
      </div>
      ${itemInCart ? `
      <div class="sc-list-item" data-asin="${item.itemId}" data-itemid="cart-sim-1" data-isselected="1" data-quantity="1" data-outofstock="0" data-displayprice="${(item.unitCents / 100).toFixed(2)}" data-encoded-offering="${encodeURIComponent(oid)}">
        <span>Vendido por Amazon.com.br</span>
      </div>` : ''}
      <div id="sc-buy-box-ptc-button">
        <input type="button" name="proceedToRetailCheckout" value="Fechar pedido" onclick="${actionJs('proceed-checkout')}.then(()=>{location.href='/checkout/p/p-${orderId}/${chosenFlow === 'A' ? 'pay' : 'spc'}';})">
      </div>
    </div></div>
  </body></html>`;

  const shoppingWallHtml = () => `<!doctype html><html><head><title>Amazon.com.br</title></head><body>
    <p>Clique no botão abaixo para continuar comprando</p>
    <form action="/errors_page/validate" method="get">
      <button type="submit" alt="Continuar comprando">Continuar comprando</button>
    </form>
  </body></html>`;

  const productHtml = () => `<!doctype html><html><head><title>Produto Amazon Simulado</title></head><body>
    <h1>${item.name}</h1>
    <a href="#aod" id="aod-ingress-link" onclick="event.preventDefault();${actionJs('open-aod')}.then(()=>{document.getElementById('aod-panel').style.display='block';})">Outros vendedores</a>
    <div id="aod-panel" style="display:none">
      <div id="aod-offer">
        <div id="aod-offer-soldBy"><div class="a-col-right"><span>Amazon.com.br</span></div></div>
        <div id="aod-offer-shipsFrom"><div class="a-col-right">Amazon.com.br</div></div>
        <div data-action="aod-atc-action" data-aod-atc-action='${JSON.stringify({ asin: item.itemId, oid, minQty: 1, maxQty: 10 })}'>
          <input type="button" name="submit.addToCart" value="Adicionar ao carrinho" aria-label="Adicionar ao carrinho por ${formatBrl(item.unitCents)}" onclick="${actionJs('add-to-cart')}">
        </div>
      </div>
    </div>
  </body></html>`;

  const paymentPanelHtml = () => {
    const startDisabled = chosenFlow === 'A';
    const pixChecked = chosenFlow === 'B' && isCard;
    const otherCardChecked = chosenFlow === 'B' && !isCard;
    return `<!doctype html><html><head><title>Pagamento Amazon Simulado</title></head><body>
      <span id="deliver-to-address-text">Rua Simulação Vigia, 100 - São Paulo</span>
      <div id="checkout-payment-option-panel">
        <div class="pmts-instrument-box">
          <label>
            <input type="radio" name="ppw-instrumentRowSelection" value="paymentMethod=Pix" ${pixChecked ? 'checked' : ''} onchange="onSelect('pix', event)">
            <span class="pmts-pix-text-content">Pix</span>
          </label>
        </div>
        <div class="pmts-instrument-box">
          <label>
            <input type="radio" name="ppw-instrumentRowSelection" value="paymentMethod=CC&cardId=sim2454" onchange="onSelect('credit_card', event)">
            <span>Visa terminando em ${cardLastFour}</span>
          </label>
          <select name="ppw-installmentsSelection">
            <option value="2" selected>2x sem juros</option>
            <option value="">Preço à vista</option>
          </select>
        </div>
        <div class="pmts-instrument-box">
          <label>
            <input type="radio" name="ppw-instrumentRowSelection" value="paymentMethod=CC&cardId=other9999" ${otherCardChecked ? 'checked' : ''} onchange="onSelect('other_card', event)">
            <span>Mastercard terminando em 9999</span>
          </label>
        </div>
        <div id="checkout-primary-continue-button-id">
          <input type="button" data-testid="bottom-continue-button" data-csa-c-slot-id="checkout-primary-continue-payselect" value="Use este método de pagamento" ${startDisabled ? 'disabled' : ''} onclick="onContinue(event)">
        </div>
        <div id="checkout-secondary-continue-button-id">
          <input type="button" data-testid="secondary-continue-button" data-csa-c-slot-id="checkout-secondary-continue-payselect" value="Use este método de pagamento" ${startDisabled ? 'disabled' : ''} onclick="onContinue(event)">
        </div>
      </div>
      <script>
        let currentMethod = ${JSON.stringify(chosenMethod)};
        function onSelect(method, event) {
          currentMethod = method;
          fetch('/sim/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'select-payment',method,trusted:event.isTrusted})}).then(() => {
            document.querySelector('[data-testid="bottom-continue-button"]').disabled = false;
            document.querySelector('[data-testid="secondary-continue-button"]').disabled = false;
          });
        }
        function onContinue(event) {
          fetch('/checkout/p/p-${orderId}/pay/continue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:currentMethod,trusted:event.isTrusted})}).then(() => {
            location.href = '/checkout/p/p-${orderId}/${chosenFlow === 'B' ? 'prime' : 'spc'}';
          });
        }
      </script>
    </body></html>`;
  };

  const primeInterstitialHtml = () => `<!doctype html><html><head><title>Oferta Prime Simulada</title></head><body>
    <span id="deliver-to-address-text">Rua Simulação Vigia, 100 - São Paulo</span>
    <h1>Experimente Amazon Prime grátis</h1>
    <a id="prime-decline-button" href="/checkout/p/p-${orderId}/spc" onclick="event.preventDefault();${actionJs('decline-prime')}.then(()=>{location.href='/checkout/p/p-${orderId}/spc';})">Não, obrigado(a). Fechar pedido</a>
  </body></html>`;

  const reviewHtml = () => {
    const showingTarget = checkoutPhase === 'review_ready';
    const paymentLabelText = showingTarget
      ? (isCard ? `Pagando com Visa terminando em ${cardLastFour}` : 'Pagando com Pix')
      : (isCard ? 'Pagando com Pix' : 'Pagando com Mastercard terminando em 9999');
    const finalBtnLabel = isCard ? `Confirmar pedido com cartão ${cardLastFour}` : 'Confirmar pedido com Pix';
    return `<!doctype html><html><head><title>Revisão Amazon Simulada</title></head><body>
      <div id="selected-payment-methods-list-container">
        <span id="payment-option-text-default">${paymentLabelText}</span>
        ${!showingTarget ? `<a href="/checkout/p/p-${orderId}/pay" data-csa-c-slot-id="checkout-change-payselect" aria-label="Alterar forma de pagamento" onclick="event.preventDefault();${actionJs('change-payment')}.then(()=>{location.href='/checkout/p/p-${orderId}/pay';})">Alterar forma de pagamento</a>` : ''}
      </div>
      <span id="deliver-to-address-text">Rua Simulação Vigia, 100 - São Paulo</span>
      <div class="rcx-checkout-delivery-option-a-control-row" data-isselected="true"><input type="radio" value="padrão" checked></div>
      <div class="lineitem-container">
        <p class="lineitem-seller-section">Vendido por Amazon.com.br</p>
        <fieldset name="checkout-quantity-stepper" data-steppervalue="1"><span class="a-stepper-value-live">1</span></fieldset>
      </div>
      <span data-testid="Item_asin_0_0_0" class="aok-hidden">${item.itemId}</span>
      <div id="subtotals">
        ${isCard && showingTarget ? '<div>Em 1x sem juros · Preço à vista</div>' : ''}
        ${summaryRow('Itens:', 'ITEMS_TAX_INCLUSIVE', item.unitCents)}
        ${summaryRow('Frete:', 'SHIPPING_TAX_INCLUSIVE', 0)}
        ${summaryRow('Total:', 'TOTAL_BEFORE_SPECIAL_PAYMENTS_TAX_INCLUSIVE', item.unitCents)}
        ${!isCard && showingTarget ? `<div class="a-row a-color-success"><div class="a-column">Desc. forma pgto</div><div class="a-column"><span data-shimmer-target="ordertotals-amount">${formatBrl(-pixDiscountCents)}</span></div></div>` : ''}
        ${summaryRow('Total do pedido:', '', showingTarget ? totalCents : item.unitCents)}
      </div>
      ${showingTarget ? `
      <div id="submitOrderButtonId">
        <input type="button" data-testid="SPC_selectPlaceOrder" value="${finalBtnLabel}" onclick="${actionJs('place-order')}.then(()=>{location.href='/checkout/p/p-${orderId}/${isCard ? `thankyou?purchaseId=${orderId}` : 'pix'}';})">
      </div>` : ''}
    </body></html>`;
  };

  const pixPortalHtml = () => `<!doctype html><html><head><title>Pagamento Pix Amazon Simulado</title></head><body>
    <h2 data-testid="heading">Total a pagar: ${formatBrl(totalCents)}</h2>
    <svg data-testid="qr-code" width="120" height="120"></svg>
    <div data-testid="Upx-Prepare-PrimaryButton">
      <button type="button" id="copy-pix-btn">Copiar código</button>
    </div>
    <script>
      document.getElementById('copy-pix-btn').addEventListener('click', function(event) {
        ${actionJs('copy-pix')};
        navigator.clipboard.writeText(${JSON.stringify(pixCode)}).catch(function(){});
      });
    </script>
  </body></html>`;

  const thankYouHtml = () => `<!doctype html><html><head><title>Pedido confirmado Amazon Simulado</title></head><body>
    <div id="widget-purchaseSummary" class="a-alert-success">
      <h1>Pedido realizado! Obrigado.</h1>
      <p>Número do pedido: ${orderId}</p>
    </div>
  </body></html>`;

  const intercept = async request => {
    try {
      const url = new URL(request.url());
      if (url.origin !== amazonOrigin) return request.abort();
      if (url.pathname === '/sim/action') {
        const body = JSON.parse(request.postData() || '{}');
        events.push(body);
        assert.equal(body.trusted, true, `Clique não confiável (isTrusted=false) em ${body.type}`);
        if (body.type === 'uncheck-other') otherSelected = false;
        if (body.type === 'add-to-cart') itemInCart = true;
        if (body.type === 'change-payment') checkoutPhase = 'payselect';
        if (body.type === 'select-payment') chosenMethod = body.method;
        if (body.type === 'decline-prime') checkoutPhase = 'review_ready';
        if (body.type === 'place-order') finalClicks += 1;
        return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (url.pathname === `/checkout/p/p-${orderId}/pay/continue`) {
        const body = JSON.parse(request.postData() || '{}');
        events.push({ type: 'continue-payment', method: body.method, trusted: body.trusted });
        assert.equal(body.trusted, true, 'Clique não confiável em Use este método de pagamento');
        checkoutPhase = chosenFlow === 'B' ? 'prime' : 'review_ready';
        return request.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      }
      if (url.pathname === '/cart') {
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: cartHtml() });
      }
      if (url.pathname === '/errors_page/validate') {
        shoppingWallPending = false;
        shoppingWallRecovered = true;
        onLog('  [Falha injetada] Parede "Continuar comprando" da Amazon superada com sucesso.\n');
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Validado</title><p>OK</p>' });
      }
      if (url.pathname === `/dp/${item.itemId}`) {
        if (shoppingWallPending) {
          onLog('  [Falha injetada] Servindo tela "Continuar comprando" (shopping wall) na Amazon…\n');
          return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: shoppingWallHtml() });
        }
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: productHtml() });
      }
      if (url.pathname === `/checkout/p/p-${orderId}/pay`) {
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: paymentPanelHtml() });
      }
      if (url.pathname === `/checkout/p/p-${orderId}/prime`) {
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: primeInterstitialHtml() });
      }
      if (url.pathname === `/checkout/p/p-${orderId}/spc`) {
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: reviewHtml() });
      }
      if (url.pathname === `/checkout/p/p-${orderId}/pix`) {
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: pixPortalHtml() });
      }
      if (url.pathname === `/checkout/p/p-${orderId}/thankyou`) {
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: thankYouHtml() });
      }
      return request.abort();
    } catch (err) {
      await request.abort().catch(() => {});
      throw err;
    }
  };

  const configurePage = async page => {
    await page.setRequestInterception(true);
    page.on('request', intercept);
    return page;
  };

  const wrappedLauncher = async options => {
    launchAttempt += 1;
    if (launchAttempt === 1) {
      onLog('  [Falha injetada] Simulando Target.createTarget: Session with given id not found na 1ª abertura do perfil…\n');
      return {
        browser: {
          newPage: async () => {
            throw new Error('Protocol error (Target.createTarget): Session with given id not found.');
          },
          close: async () => { sessionFaultClosed = true; },
        },
        profile: { key: 'amazon/purchase' },
      };
    }
    if (launchAttempt === 2) {
      onLog('  [Falha injetada] Sessão CDP recuperada na 2ª tentativa de abertura do Chrome.\n');
    }
    const lease = await pool.acquire({ ...options, headless: true });
    const origNewPage = lease.browser.newPage;
    lease.browser.newPage = async () => configurePage(await origNewPage());
    return lease;
  };

  const settings = defaults();
  settings.amazon.onlyAmazon = true;
  settings.amazon.purchase.enabled = true;
  settings.amazon.purchase.freeShippingOnly = true;
  settings.amazon.purchase.paymentMethod = payment;
  settings.amazon.purchase.cardLastFour = isCard ? cardLastFour : null;

  try {
    const result = await runAmazonPurchase({
      order: { id: 'sim-order-amz', store: 'amazon', payment, items: [item] },
      settings,
      projectRoot,
      dataDirectory: tempDir,
      signal: new AbortController().signal,
      headlessMode: undefined,
      openAttempts: 4,
      openRetryDelayMs: 200,
      launcher: wrappedLauncher,
      stage: async (status, message) => {
        stages.push({ status, message });
        onLog(`  [${status}] ${message}\n`);
      },
    });

    assert.equal(result.payment, payment);
    assert.equal(result.paid, isCard);
    assert.equal(result.totalCents, totalCents);
    assert.equal(finalClicks, 1, 'O botão final de confirmação deve ser clicado exatamente 1 vez.');
    assert.equal(otherSelected, false, 'Outros itens do carrinho devem ter sido desmarcados.');
    if (isCard) {
      assert.ok(result.orderReferences.includes(orderId), 'Número do pedido Amazon não capturado na página de confirmação.');
    } else {
      assert.equal(result.code, pixCode, 'Código Pix capturado diverge do código gerado.');
    }
    if (chosenFlow === 'B') {
      assert.ok(events.some(e => e.type === 'change-payment'), 'Fluxo B deve acionar Alterar forma de pagamento.');
      assert.ok(events.some(e => e.type === 'decline-prime'), 'Fluxo B deve recusar a oferta Prime.');
    }
    assert.ok(launchAttempt >= 2 && sessionFaultClosed, 'Falha injetada de Target.createTarget deveria ter sido recuperada com fechamento do Chrome falho.');
    assert.equal(shoppingWallRecovered, true, 'Falha injetada da parede "Continuar comprando" deveria ter sido recuperada.');
    recoveredFaults.push('Target.createTarget (Session not found)', 'Parede "Continuar comprando"');

    onLog(`[Simulação Amazon] APROVADO · ${flowLabel} · Total ${formatBrl(result.totalCents)} · ${events.length} ações confiáveis · ${finalClicks} finalização · ${recoveredFaults.length} falhas recuperadas.\n`);
    return {
      status: 'passed',
      store: 'amazon',
      storeLabel: 'Amazon',
      payment,
      paymentLabel: isCard ? 'Cartão de crédito' : 'Pix',
      flow: chosenFlow,
      flowLabel,
      totalCents: result.totalCents,
      finalClicks,
      trustedClicks: events.length,
      stagesCount: stages.length,
      stages: stages.map(s => `[${s.status}] ${s.message}`),
      recoveredFaults,
      orderReferences: result.orderReferences ?? [],
      pixVerified: !isCard && result.code === pixCode,
      error: null,
    };
  } finally {
    await pool.release(projectRoot, tempDir, 'amazon', 'purchase').catch(() => {});
    const tempRoot = resolve(tmpdir()) + sep;
    if (resolve(tempDir).startsWith(tempRoot)) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function runMlSimulation({ projectRoot, payment, onLog = () => {} }) {
  const isCard = payment === 'credit_card';
  onLog(`[Simulação Mercado Livre] Pagamento: ${isCard ? 'Cartão de crédito' : 'Pix'}\n`);

  const tempDir = await mkdtemp(join(tmpdir(), 'vigia-sim-ml-'));
  const pool = createProfilePool(launchDedicatedProfile);
  const items = new Map([['MLB1999', { quantity: 1, checked: true, unit: 20 }]]);
  const events = [];
  const stages = [];
  const recoveredFaults = [];
  let finalClicks = 0;
  let chosenShipping = 'slow';
  let launchAttempt = 0;
  let sessionFaultClosed = false;
  let contextLossPending = false;
  let contextLossInjected = 0;

  const selected = () => [...items].filter(([, info]) => info.checked);
  const total = () => selected().reduce((sum, [, info]) => sum + info.unit * info.quantity, 0);
  const money = value => ({ value: { values: [{ key: 'price', type: 'price', price: { value, currency: 'BRL' } }] } });
  const htmlMoney = value => {
    const frac = Math.floor(value);
    const centsPart = Math.round(value * 100) % 100;
    return `<span class="andes-money-amount"><span class="andes-money-amount__fraction">${frac}</span><span class="andes-money-amount__cents">${String(centsPart).padStart(2, '0')}</span></span>`;
  };
  const cartApi = () => ({
    grouped_items: [{
      polycards: [...items].map(([id, info]) => ({
        unique_id: id,
        metadata: { id, quantity: String(info.quantity) },
        checkbox: { checked: info.checked, disabled: false, metadata: { items: [{ item_id: id }] } },
        add_to_cart_capability: { cart_status: { item_id: id, quantity: info.quantity, display_quantity: info.quantity, status: 'enabled' } },
      })),
    }],
    cart_properties: { active_and_selected_items_size: selected().reduce((sum, [, info]) => sum + info.quantity, 0) },
    summary: {
      ticket_rows: [{ id: 'item', ...money(total()) }, { id: 'shipping', ...money(0) }],
      total_row: money(total()),
      coupon_row: { id: 'coupon' },
    },
    tracking: {
      summary: { total: { amount: total() }, shipping_total: { amount: 0 }, discount_amount: 0, used_coupons: 0, coupons_type: { type: 'NO_COUPON' } },
      items: [...items].map(([id, info]) => ({
        item: { id }, quantity: info.quantity, unit_price: info.unit,
        price_decrement_campaigns: [{ id: 'not_apply', type: 'not_apply', amount: 0 }],
      })),
      grouping_items: [...items].map(([id, info]) => ({
        group_status: info.checked ? 'selected' : 'unselected',
        items_id: [id],
        total_active_quantity_items: info.checked ? info.quantity : 0,
        coupons: [{ type: 'no_coupon', reach_minimum: false, given_discount: 0 }],
      })),
    },
  });

  const actionJs = (type, extra = '') =>
    `fetch('/test/action',{method:'POST',body:JSON.stringify({type:'${type}',trusted:event.isTrusted${extra}})})`;

  const productHtml = id => `<!doctype html><title>Produto ML Simulado</title><h1 class="ui-pdp-title">${id}</h1>` +
    `<script id="__NORDIC_RENDERING_CTX__">_n.ctx.r = ${JSON.stringify({ appProps: { pageProps: { initialState: { id, no_active_item: false, track: { melidata_event: { event_data: { item_id: id, seller_id: 123, item_status: 'active', has_stock: true, price: 90 } } } } } } })};</script>` +
    `<button onclick="${actionJs('add', `,id:'${id}'`)}">Adicionar ao carrinho</button>`;

  const cartHtml = () => `<!doctype html><title>Carrinho ML Simulado</title>` +
    [...items].map(([id, info]) => `<div class="cl-item-card" data-item-id="${id}"><input type="checkbox" ${info.checked ? 'checked' : ''} onclick="${actionJs('selection', `,id:'${id}',checked:this.checked`)}.then(()=>location.reload())"></div>`).join('') +
    `<a class="cl-summary__button" href="https://www.mercadolivre.com.br/gz/checkout/cart/buy?items=${selected().map(([id, info]) => `${id}-Q${info.quantity}`).join(',')}">Continuar (${selected().reduce((s, [, info]) => s + info.quantity, 0)})</a>`;

  const slowWeekday = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'][(new Date().getDay() + 4) % 7];
  const shippingHtml = () => `<ul class="bf-shipping-options-list__radio-list">${[
    ['slow', `Chegará ${slowWeekday}`, 0, true],
    ['fast', 'Chegará amanhã', 0, false],
    ['paid', 'Chegará hoje', 5, false],
  ].map(([value, title, price]) => `<li><input type="radio" name="shipping-options-1" value="${value}" id="ship-${value}" ${value === chosenShipping ? 'checked' : ''} onclick="${actionJs('shipping', `,value:'${value}'`)}"><label for="ship-${value}" data-andes-radio-list-title>${title}</label><span data-andes-radio-list-right-content>${price === 0 ? 'Grátis' : htmlMoney(price)}</span></li>`).join('')}</ul>`;

  const proofHtml = () => selected().map(([id, info]) => `<div data-item-id="${id}" data-quantity="${info.quantity}" data-unit-price="${info.unit}" data-seller-id="123"></div>`).join('');

  const pixCheckoutHtml = () => `<!doctype html><title>Checkout ML Pix Simulado</title>${shippingHtml()}` +
    `<div data-testid="product_row">${htmlMoney(total())}</div><div data-testid="shipment_row">Grátis</div><div data-testid="total_row">${htmlMoney(total())}</div>${proofHtml()}` +
    `<div class="bf-payments__footer_action"><a href="#" id="more">Mostrar todos</a></div>` +
    `<input type="radio" name="payment-method-radio-list" id="card" value="credit" checked><label for="card">Cartão</label>` +
    `<div id="payments" role="dialog" style="display:none"></div><div id="review"></div><script>
      function showPayments(){
        const box = document.getElementById('payments');
        box.style.display='block';
        box.innerHTML='<input type="radio" name="transfers" id="pix-test" value="pix"><label for="pix-test">Pix</label><button data-testid="continue_button" id="pay-continue">Continuar</button>';
        document.getElementById('pix-test').onclick=function(event){${actionJs('pix')};};
        document.getElementById('pay-continue').onclick=function(event){
          if(!document.getElementById('pix-test').checked)throw Error('Pix não selecionado');
          ${actionJs('continue-payment')};
          box.innerHTML='';box.style.display='none';
          document.getElementById('review').innerHTML='<input type="radio" name="payment-method-radio-list" id="selected-pix" value="pix" checked><label for="selected-pix">Pix</label><button data-testid="confirm_purchase_button" id="final">Pagar e finalizar</button>';
          document.getElementById('final').onclick=async function(event){
            const r=await fetch('/test/finalize',{method:'POST',body:JSON.stringify({trusted:event.isTrusted})});
            const p=await r.json();
            document.body.innerHTML='<div data-testid="pix_copy_code_card">'+p.code+'</div>';
          };
        };
      }
      document.getElementById('more').onclick=function(event){${actionJs('more')};showPayments();return false;};
    </script>`;

  const cardCheckoutHtml = () => `<!doctype html><title>Checkout ML Cartão Simulado</title>${shippingHtml()}` +
    `<div data-testid="product_row">${htmlMoney(total())}</div><div data-testid="shipment_row">Grátis</div><div data-testid="total_row">${htmlMoney(total())}</div>${proofHtml()}` +
    `<input type="radio" name="payment-method-radio-list" id="wrong" checked><label for="wrong">Cartão de crédito terminado em 2345 · à vista</label>` +
    `<input type="radio" name="payment-method-radio-list" id="saved-card" value="master_123456" onclick="${actionJs('credit_card')}"><label for="saved-card">Mastercard terminado em 0123 · à vista · sem juros</label>` +
    `<button data-testid="confirm_purchase_button" onclick="if(document.getElementById('saved-card').checked)fetch('/test/finalize',{method:'POST',body:JSON.stringify({trusted:event.isTrusted})}).then(()=>location.href='/gz/checkout/congrats?purchase_id=200000999888')">Pagar e finalizar</button>`;

  const intercept = async request => {
    try {
      const url = new URL(request.url());
      if (url.hostname !== 'www.mercadolivre.com.br') return request.abort();
      if (url.pathname === '/test/action') {
        const body = JSON.parse(request.postData() || '{}');
        events.push(body);
        assert.equal(body.trusted, true, `Clique não confiável em ${body.type}`);
        if (body.type === 'add' && !items.has(body.id)) items.set(body.id, { quantity: 1, checked: true, unit: 90 });
        if (body.type === 'shipping') chosenShipping = body.value;
        if (body.type === 'selection') items.get(body.id).checked = body.checked;
        return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (url.pathname === '/test/finalize') {
        const body = JSON.parse(request.postData() || '{}');
        assert.equal(body.trusted, true, 'Clique não confiável em Pagar e finalizar');
        finalClicks += 1;
        events.push({ type: 'final', trusted: true });
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: buildMlPixCode(total()) }) });
      }
      if (url.pathname === '/gz/cart/v3/api/cart-list') {
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(cartApi()) });
      }
      if (url.pathname === '/gz/cart/v3/api/add-to-cart') {
        const body = JSON.parse(request.postData() || '{}');
        const capacity = body.item_id === 'MLB1001' ? 2 : 4;
        const entry = items.get(body.item_id);
        entry.quantity = Math.min(body.quantity, capacity);
        events.push({ type: 'quantity', id: body.item_id, quantity: entry.quantity });
        return request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            cart_status: { item_id: body.item_id, quantity: entry.quantity, status: 'enabled' },
            cart_config: { available_quantity: capacity, maximum_quantity: 10, minimum_quantity: 1 },
          }),
        });
      }
      if (url.pathname === '/gz/cart/v2') {
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: cartHtml() });
      }
      if (url.pathname === '/gz/checkout/cart/buy') {
        events.push({ type: 'continue-cart' });
        contextLossPending = true;
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: isCard ? cardCheckoutHtml() : pixCheckoutHtml() });
      }
      if (url.pathname === '/gz/checkout/congrats' && isCard) {
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><h1>Pagamento aprovado</h1>' });
      }
      const id = url.searchParams.get('pdp_filters')?.match(/item_id:(MLB\d+)/)?.[1];
      if (id && url.pathname.includes('/p/')) {
        return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: productHtml(id) });
      }
      return request.abort();
    } catch (err) {
      await request.abort().catch(() => {});
      throw err;
    }
  };

  const configurePage = async page => {
    await page.setRequestInterception(true);
    page.on('request', intercept);
    const origEvaluate = page.evaluate.bind(page);
    page.evaluate = async (fn, ...args) => {
      if (fn === checkoutSelectionInPage && contextLossPending) {
        contextLossPending = false;
        contextLossInjected += 1;
        onLog('  [Falha injetada] Simulando perda de contexto (Execution context was destroyed) no checkout ML…\n');
        throw new Error('Execution context was destroyed, most likely because of a navigation.');
      }
      return origEvaluate(fn, ...args);
    };
    return page;
  };

  const wrappedLauncher = async options => {
    assert.equal(options.headless, !isCard, 'Modo headless esperado para ML diverge da regra de pagamento.');
    launchAttempt += 1;
    if (launchAttempt === 1) {
      onLog('  [Falha injetada] Simulando Target.createTarget: Session with given id not found na 1ª abertura do perfil…\n');
      return {
        browser: {
          newPage: async () => {
            throw new Error('Protocol error (Target.createTarget): Session with given id not found.');
          },
          close: async () => { sessionFaultClosed = true; },
        },
        profile: { key: 'ml/purchase' },
      };
    }
    if (launchAttempt === 2) {
      onLog('  [Falha injetada] Sessão CDP recuperada na 2ª tentativa de abertura do Chrome.\n');
    }
    const lease = await pool.acquire({ ...options, headless: true });
    const origNewPage = lease.browser.newPage;
    lease.browser.newPage = async () => configurePage(await origNewPage());
    return lease;
  };

  const settings = defaults();
  settings.ml.purchase.enabled = true;
  settings.ml.purchase.freeShippingOnly = true;
  if (isCard) {
    Object.assign(settings.ml.purchase, { paymentMethod: 'credit_card', cardLastFour: '0123' });
  } else {
    settings.ml.purchase.paymentMethod = 'pix';
  }

  try {
    const result = await runPurchase({
      projectRoot,
      dataDirectory: tempDir,
      settings,
      signal: new AbortController().signal,
      notify: async () => {},
      launcher: wrappedLauncher,
      stage: async (status, message) => {
        stages.push({ status, message });
        onLog(`  [${status}] ${message}\n`);
      },
      order: {
        items: [1, 2].map(n => ({
          itemId: 'MLB100' + n,
          catalog: 'MLB900' + n,
          type: 'catalogo',
          sellerId: '123',
          url: `https://www.mercadolivre.com.br/product/p/MLB900${n}?pdp_filters=item_id:MLB100${n}`,
          name: 'MLB100' + n,
          quantity: n === 1 ? 3 : 1,
          requestedQuantity: n === 1 ? 3 : 1,
          limitCents: 10000,
        })),
      },
    });

    assert.equal(result.payment, payment);
    assert.equal(result.paid, isCard);
    assert.equal(result.totalCents, 27000);
    assert.equal(result.items[0].quantity, 2);
    assert.equal(result.items[1].quantity, 1);
    assert.equal(finalClicks, 1, 'O botão Pagar e finalizar deve ser clicado exatamente 1 vez.');
    assert.equal(items.get('MLB1999').checked, false, 'Outros itens do carrinho devem ter sido desmarcados.');
    assert.equal(chosenShipping, 'fast', 'O frete grátis mais rápido deveria ter sido escolhido.');
    assert.equal(stages.filter(s => s.status === 'FINALIZING').length, 1);
    if (!isCard) {
      assert.ok(typeof result.code === 'string' && result.code.startsWith('000201'), 'Código Pix ML inválido.');
    }
    assert.ok(launchAttempt >= 2 && sessionFaultClosed, 'Falha injetada de Target.createTarget deveria ter sido recuperada com fechamento do Chrome falho.');
    assert.equal(contextLossInjected, 1, 'Falha injetada de perda de contexto no checkout deveria ter sido recuperada.');
    recoveredFaults.push('Target.createTarget (Session not found)', 'Execution context destroyed (checkout)');

    onLog(`[Simulação Mercado Livre] APROVADO · Total ${formatBrl(result.totalCents)} · ${events.length} ações confiáveis · ${finalClicks} finalização · ${recoveredFaults.length} falhas recuperadas.\n`);
    return {
      status: 'passed',
      store: 'ml',
      storeLabel: 'Mercado Livre',
      payment,
      paymentLabel: isCard ? 'Cartão de crédito' : 'Pix',
      flow: null,
      flowLabel: isCard ? 'Checkout direto com cartão salvo' : 'Lista completa de pagamentos → Pix',
      totalCents: result.totalCents,
      finalClicks,
      trustedClicks: events.length,
      stagesCount: stages.length,
      stages: stages.map(s => `[${s.status}] ${s.message}`),
      recoveredFaults,
      orderReferences: result.orderReferences ?? [],
      pixVerified: !isCard && Boolean(result.code),
      error: null,
    };
  } finally {
    await pool.release(projectRoot, tempDir, 'ml', 'purchase').catch(() => {});
    const tempRoot = resolve(tmpdir()) + sep;
    if (resolve(tempDir).startsWith(tempRoot)) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function runPurchaseSimulation({ scenarioId, projectRoot, amazonFlow = 'random', onLog = () => {} }) {
  const scenario = PURCHASE_SIMULATION_SCENARIOS[scenarioId];
  if (!scenario) {
    throw new Error(`Cenário de simulação desconhecido: ${scenarioId}`);
  }
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  try {
    const outcome = scenario.store === 'amazon'
      ? await runAmazonSimulation({ projectRoot, payment: scenario.payment, amazonFlow, onLog })
      : await runMlSimulation({ projectRoot, payment: scenario.payment, onLog });
    return {
      scenarioId,
      name: scenario.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      ...outcome,
    };
  } catch (error) {
    onLog(`[Simulação] FALHOU: ${error.message}\n`);
    return {
      scenarioId,
      name: scenario.name,
      store: scenario.store,
      storeLabel: scenario.storeLabel,
      payment: scenario.payment,
      paymentLabel: scenario.paymentLabel,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      status: 'failed',
      error: error.message,
    };
  }
}
