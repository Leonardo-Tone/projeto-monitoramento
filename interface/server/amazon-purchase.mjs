import { setTimeout as delay } from 'node:timers/promises';
import { launchProfile } from './profiles.mjs';
import { readAcrossNavigation } from './purchase-navigation.mjs';
import { readPurchaseHtml } from './purchase-dom.mjs';
import { amazonOrigin, cartLine, copyPix, createAmazonCheckoutParser, placePix, validateAmazonReview } from './amazon-checkout.mjs';
import { captureAmazonPix, installAmazonPixCopy, validateAmazonPix } from './amazon-pix-copy.mjs';
import { observeAmazonPaymentButtons, saveAmazonFailureHtml } from './amazon-diagnostics.mjs';
import { checkoutOrderReferences } from './account-verification.mjs';

const categories = new Set(['AMAZON_DIRETA', 'TERCEIRO_ENVIO_AMAZON', 'TERCEIRO_ENVIO_PROPRIO']);
const cartUrl = amazonOrigin + '/cart';
const proceed = '#sc-buy-box-ptc-button input[name="proceedToRetailCheckout"]';
const pixRadio = '#checkout-payment-option-panel input[type="radio"][name="ppw-instrumentRowSelection"]';
const changePayment = 'a[data-csa-c-slot-id="checkout-change-payselect"][aria-label="Alterar forma de pagamento"]';
const continuePayment = '#checkout-primary-continue-button-id input[data-testid="bottom-continue-button"][data-csa-c-slot-id="checkout-primary-continue-payselect"]';
const continuePaymentSidebar = '#checkout-secondary-continue-button-id input[data-testid="secondary-continue-button"][data-csa-c-slot-id="checkout-secondary-continue-payselect"]';
const paymentStableMs = 400;
const pixRetryDelayMs = 5000;
const declinePrime = '#prime-decline-button a, a[href*="action=decline"]';
const sameText = (left, right) => String(left ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === String(right ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function amazonCandidates(products, orders, freshIds, settings, now = Date.now()) {
  const blockedOrders = orders.filter(order => !['CANCELLED', 'CLOSED'].includes(order.status));
  const blocked = new Set(blockedOrders.flatMap(order => order.items.map(item => item.productId)));
  const blockedAsins = new Set(blockedOrders.filter(order => order.store === 'amazon')
    .flatMap(order => order.items.map(item => item.itemId)));
  const items = [];
  for (const product of products) {
    const age = now - Date.parse(product.lastCheckedAt);
    const limitCents = Math.round(product.target * 100);
    const quantity = product.quantity ?? 1;
    if (product.store !== 'amazon' || !product.auto || product.available !== true || product.eligible === false ||
        (product.availabilityNotification && product.availabilityNotification.confirmed !== true) ||
        product.error || !freshIds.has(product.id) || blocked.has(product.id) || blockedAsins.has(product.code) || !(age >= 0 && age < 90000) ||
        !Number.isSafeInteger(limitCents) || limitCents <= 0) continue;
    const offers = (product.amazonOffers ?? []).filter(offer => categories.has(offer.categoria) &&
      (!settings.onlyAmazon || offer.categoria === 'AMAZON_DIRETA') && /^[A-Z0-9_]+$/.test(offer.sellerId ?? '') &&
      Number.isSafeInteger(offer.precoNormalCentavos) && offer.precoNormalCentavos > 0 && offer.precoNormalCentavos <= limitCents &&
      (offer.minQty == null || quantity >= offer.minQty) && (offer.maxQty == null || quantity <= offer.maxQty));
    offers.sort((left, right) => left.precoNormalCentavos - right.precoNormalCentavos);
    const offer = offers[0];
    if (offer) items.push({
      productId: product.id, itemId: product.code, name: product.title || product.name || product.code,
      sellerId: offer.sellerId, seller: offer.vendedor, shippedBy: offer.enviadoPor,
      quantity, requestedQuantity: quantity, limitCents, unitCents: offer.precoNormalCentavos,
    });
  }
  return items;
}

function assertAmazonPage(page, paths) {
  const url = new URL(page.url());
  if (url.origin !== amazonOrigin || url.username || url.password || /\/ap\/|captcha|challenge|account-verification/i.test(url.pathname)) {
    throw new Error('A Amazon exige login ou verificação no perfil Compra.');
  }
  if (paths && !paths.test(url.pathname)) throw new Error('A Amazon abriu uma etapa de compra desconhecida.');
}

async function enabledControl(page, selector, { label, radio, checked } = {}) {
  const handle = await page.evaluateHandle(({ selector, label, radio, checked }) => {
    const elements = [...document.querySelectorAll(selector)].flatMap(el => {
      const displayed = radio ? (el.closest('label') ?? el.labels?.[0]) : el;
      if (!displayed?.getClientRects().length || getComputedStyle(displayed).visibility !== 'visible' ||
          el.closest('.a-button-disabled, [aria-disabled="true"], [hidden]') || el.matches(':disabled')) return [];
      if (radio) {
        const text = displayed.textContent.replace(/\s+/g, ' ').trim();
        const method = new URLSearchParams(el.value).get('paymentMethod');
        const pix = method !== null ? /^Pix$/i.test(method) : /^Pix$/i.test(text) ||
          Boolean(el.closest('.pmts-instrument-box')?.querySelector('.pmts-pix-text-content, .pmts-pix-icon-img'));
        return pix && (!checked || el.checked) ? [el] : [];
      }
      return !label || (el.value || el.textContent).replace(/\s+/g, ' ').trim() === label ? [displayed] : [];
    });
    return elements.length === 1 ? elements[0] : null;
  }, { selector, label, radio, checked });
  const element = handle.asElement();
  if (!element) await handle.dispose();
  return element;
}

async function findOffer(page, item) {
  const handle = await page.evaluateHandle(({ sellerId, seller, shippedBy, itemId, quantity, unitCents }) => {
    const normalized = text => (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const found = [];
    for (const action of document.querySelectorAll('[data-action="aod-atc-action"][data-aod-atc-action]')) {
      const row = action.closest('[id="aod-offer"], #aod-pinned-offer');
      const input = action.querySelector('input[name="submit.addToCart"]');
      if (!row || !input?.getClientRects().length || input.disabled || input.closest('.a-button-disabled')) continue;
      const sold = row.querySelector('[id="aod-offer-soldBy"] .a-col-right');
      const link = sold?.querySelector('a[href*="seller="]');
      const merchant = link ? new URL(link.href).searchParams.get('seller') : null;
      const directSeller = sold?.querySelector(':scope > span')?.textContent ?? sold?.textContent;
      if (sellerId === 'AMAZON_DIRECT' ? normalized(directSeller) !== 'amazon.com.br' :
          link?.origin !== location.origin || merchant !== sellerId || normalized(link.textContent) !== normalized(seller)) continue;
      const shipping = row.querySelector('[id="aod-offer-shipsFrom"] .a-col-right');
      if (normalized(shipping?.textContent) !== normalized(shippedBy)) continue;
      let data;
      try { data = JSON.parse(action.getAttribute('data-aod-atc-action')); } catch { continue; }
      const amount = input.getAttribute('aria-label')?.match(/R\$\s*([\d.]+),(\d{2})/);
      const price = amount ? Number(amount[1].replaceAll('.', '')) * 100 + Number(amount[2]) : null;
      if (data.asin !== itemId || !data.oid || !Number.isInteger(data.minQty) || data.minQty < 1 || quantity < data.minQty ||
          !Number.isInteger(data.maxQty) || quantity > data.maxQty || price !== unitCents) continue;
      found.push(input);
    }
    return found.length === 1 ? found[0] : null;
  }, item);
  const element = handle.asElement();
  if (!element) await handle.dispose();
  return element;
}

const normalizeOid = value => {
  try { return value ? decodeURIComponent(value) : null; } catch { return null; }
};

export function validateAmazonCart(cart, item, oid, quantity) {
  if (!cart.ready || cart.lines.some(row => !['0', '1'].includes(row.selection))) throw new Error('Seleção do carrinho da Amazon não verificável.');
  const selected = cart.lines.filter(row => row.selection === '1');
  const row = selected[0];
  if (selected.length !== 1 || !row.itemId || row.asin !== item.itemId || row.sellerConflict ||
      (item.sellerId !== 'AMAZON_DIRECT' && row.sellerId !== item.sellerId) ||
      !normalizeOid(row.oid) || normalizeOid(row.oid) !== normalizeOid(oid) || !row.inStock ||
      !Number.isInteger(quantity) || quantity < 1 || row.quantity !== quantity || row.unitCents !== item.unitCents) {
    throw new Error('Oferta, seleção, quantidade ou preço divergente no carrinho da Amazon.');
  }
  return row;
}

export async function runAmazonPurchase({
  order, settings, projectRoot, dataDirectory, signal, stage, launcher = launchProfile, reviewOnly = false,
  headlessMode = process.env.VIGIA_AMAZON_TESTE_HEADLESS,
}) {
  const headless = headlessMode !== '0';
  const stopAtReview = headlessMode === '1';
  const parser = createAmazonCheckoutParser(projectRoot);
  const item = order.items[0];
  const rules = settings.amazon.purchase;
  if (order.items.length !== 1 || !/^[A-Z0-9]{10}$/.test(item?.itemId ?? '') ||
      !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100 || order.payment !== 'pix') {
    throw new Error('Tentativa de compra Amazon inválida.');
  }
  const { browser } = await launcher({ projectRoot, dataDirectory, store: 'amazon', purpose: 'purchase', headless });
  let checkpoint = 'Abrindo perfil Compra da Amazon.';
  let result, failure, diagnosticPage, popup, paymentState;
  const snapshots = new Map();
  const paymentTrace = { inputs: [], requests: [] };
  if (headless) paymentTrace.timeline = [];
  const recordPayment = message => paymentTrace.timeline?.push({ at: Date.now(), message });
  const paymentEventsByDocument = new Map();
  const capturePaymentEvents = async page => {
    const snapshot = await page.evaluate(() => ({
      documentStartedAt: performance.timeOrigin,
      events: globalThis.__vigiaAmazonPaymentEvents ?? [],
    })).catch(() => null);
    if (snapshot) paymentEventsByDocument.set(snapshot.documentStartedAt, snapshot.events);
  };
  const paymentRequests = new WeakMap();
  let paymentPhase = 'antes da seleção';
  const setStage = async (status, message, details) => {
    checkpoint = message;
    await stage(status, message, details);
  };
  const read = (page, paths) => readAcrossNavigation(page, async () => {
    assertAmazonPage(page, paths);
    const html = await readPurchaseHtml(page);
    snapshots.set(page, { html, url: page.url() });
    if (/<title[^>]*>\s*robot check|id=["']captchacharacters["']/i.test(html)) {
      throw new Error('A Amazon exige verificação no perfil Compra.');
    }
    return html;
  }, { signal });
  const go = async (page, url, paths) => {
    signal?.throwIfAborted();
    diagnosticPage = page;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    assertAmazonPage(page, paths);
    if (response?.status() !== 200) throw new Error('A Amazon retornou HTTP ' + response?.status() + '.');
  };
  const wait = async (probe, message, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const result = await probe();
      if (result) return result;
      await delay(200, undefined, { signal });
    }
    throw new Error(typeof message === 'function' ? message() : message);
  };
  const click = async element => {
    try { signal?.throwIfAborted(); await element.click(); }
    finally { await element.dispose().catch(() => {}); }
  };
  const clickPix = async (page, radio, { keyboard = false } = {}) => {
    try {
      signal?.throwIfAborted();
      const point = keyboard ? null : await radio.evaluate(input => {
        const label = input.closest('label') ?? input.labels?.[0];
        if (!label || !input.isConnected || input.disabled) return null;
        label.scrollIntoView({ block: 'center', inline: 'nearest' });
        const indicator = label.querySelector('.a-icon-radio');
        for (const [target, kind] of [[indicator, 'círculo Pix'], [input, 'campo Pix'], [label, 'rótulo Pix']]) {
          if (!target) continue;
          for (const rect of target.getClientRects()) {
            const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
            const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
            if (right <= left || bottom <= top) continue;
            const x = (left + right) / 2, y = (top + bottom) / 2;
            const hit = document.elementFromPoint(x, y);
            if (hit === input || (hit && label.contains(hit))) return { x, y, kind };
          }
        }
        return null;
      });
      signal?.throwIfAborted();
      if (point) {
        paymentTrace.inputs.push(point.kind);
        recordPayment('Puppeteer: clique no ' + point.kind);
        await page.mouse.click(point.x, point.y);
      } else {
        await radio.focus();
        if (!await radio.evaluate(input => input === document.activeElement && !input.disabled)) {
          throw new Error('O controle Pix da Amazon não aceitou foco para seleção.');
        }
        signal?.throwIfAborted();
        paymentTrace.inputs.push('Espaço no campo Pix');
        recordPayment('Puppeteer: Espaço no campo Pix');
        await radio.press('Space');
      }
    } finally { await radio.dispose().catch(() => {}); }
  };
  const control = (page, selector, options) => readAcrossNavigation(page, () => enabledControl(page, selector, options), { signal });
  const cartPath = /^\/(?:cart|gp\/cart)(?:\/|$)/;
  const checkoutPath = /^\/checkout(?:\/|$)/;

  try {
    const productPage = await browser.newPage();
    const page = await browser.newPage();
    page.on?.('popup', tab => { popup = tab; });
    page.on?.('request', request => {
      if (request.method() !== 'POST' || paymentTrace.requests.length >= 12) return;
      const url = new URL(request.url());
      if (url.origin !== amazonOrigin || !/^\/checkout\/p\/[^/]+\/pay\/continue\/?$/.test(url.pathname)) return;
      const observed = { phase: paymentPhase, status: null };
      paymentTrace.requests.push(observed);
      paymentRequests.set(request, observed);
    });
    page.on?.('response', response => {
      const observed = paymentRequests.get(response.request());
      if (observed) observed.status = response.status();
    });
    page.on?.('requestfailed', request => {
      const observed = paymentRequests.get(request);
      if (observed) observed.failed = true;
    });
    await page.evaluateOnNewDocument(installAmazonPixCopy, amazonOrigin);
    if (headless) await page.evaluateOnNewDocument(observeAmazonPaymentButtons);
    await setStage('REVALIDATING', 'Abrindo o carrinho da Amazon no perfil Compra.');
    await page.bringToFront();
    await go(page, cartUrl, cartPath);
    await setStage('REVALIDATING', 'Lendo o carrinho inicial da Amazon.');
    const before = parser.cart(await read(page, cartPath));
    if (!before.ready || before.lines.some(line => !['0', '1'].includes(line.selection))) {
      throw new Error('Seleção do carrinho inicial da Amazon não verificável.');
    }
    if (before.lines.some(line => line.asin === item.itemId)) {
      throw new Error('Retire a oferta deste produto do carrinho antes de rearmar, para evitar duplicidade.');
    }
    const selectedOthers = before.lines.filter(line => line.selection === '1');
    if (selectedOthers.length) {
      const ids = new Set(before.lines.map(line => line.itemId));
      if (ids.size !== before.lines.length || [...ids].some(id => !/^[A-Za-z0-9-]+$/.test(id ?? ''))) {
        throw new Error('Identificadores do carrinho inicial da Amazon não verificáveis.');
      }
      await setStage('CART', 'Desmarcando os outros itens do carrinho da Amazon.');
      for (const line of selectedOthers) {
        const selector = cartLine + '[data-itemid="' + line.itemId + '"][data-isselected="1"] .sc-item-checkbox label:has(input[type="checkbox"]:checked:enabled)';
        const checkbox = await control(page, selector);
        if (!checkbox) throw new Error('Controle para desmarcar o item do carrinho da Amazon indisponível.');
        await click(checkbox);
        await wait(async () => {
          const cart = parser.cart(await read(page, cartPath));
          if (!cart.ready || cart.lines.length !== ids.size || new Set(cart.lines.map(row => row.itemId)).size !== ids.size ||
              cart.lines.some(row => !ids.has(row.itemId) || !['0', '1'].includes(row.selection))) {
            throw new Error('A composição do carrinho mudou durante a atualização da seleção.');
          }
          return cart.lines.find(row => row.itemId === line.itemId)?.selection === '0';
        }, 'A Amazon não confirmou que o item foi desmarcado.');
      }
      const updated = parser.cart(await read(page, cartPath));
      if (!updated.ready || updated.lines.some(line => line.selection !== '0' || line.asin === item.itemId)) {
        throw new Error('O carrinho da Amazon ainda contém itens selecionados ou o produto da tentativa.');
      }
    }
    await setStage('REVALIDATING', 'Abrindo a página do produto na Amazon.');
    // The cart was opened last. Puppeteer's physical clicks can stall on a background tab.
    await productPage.bringToFront();
    await go(productPage, amazonOrigin + '/dp/' + item.itemId, new RegExp('/dp/' + item.itemId + '(?:/|$)'));
    await setStage('REVALIDATING', 'Localizando o botão Outros vendedores da Amazon.');
    const aod = await wait(() => control(productPage, '#aod-ingress-link'), 'Outros vendedores indisponível para esta oferta.');
    await setStage('REVALIDATING', 'Abrindo o painel Outros vendedores da Amazon.');
    await click(aod);
    await setStage('REVALIDATING', 'Conferindo a oferta no painel Outros vendedores da Amazon.');
    const offer = await wait(() => readAcrossNavigation(productPage, () => {
      assertAmazonPage(productPage);
      return findOffer(productPage, item);
    }, { signal }), 'A oferta original da Amazon não foi confirmada ao vivo.');
    const { oid, minQty } = await offer.evaluate(element => JSON.parse(element.closest('[data-aod-atc-action]').getAttribute('data-aod-atc-action')));
    await setStage('CART', 'Adicionando a oferta da Amazon e conferindo o carrinho.');
    assertAmazonPage(productPage);
    await click(offer);
    await page.bringToFront();
    const added = await wait(async () => {
      await go(page, cartUrl, cartPath);
      const cart = parser.cart(await read(page, cartPath));
      const row = cart.lines.find(line => line.selection === '1' && line.asin === item.itemId);
      if (row && (row.quantity < minQty || row.quantity > item.quantity)) throw new Error('A quantidade inicial adicionada pela Amazon é incompatível.');
      if (cart.lines.some(line => line.selection === '1' || line.asin === item.itemId)) {
        return validateAmazonCart(cart, item, oid, row?.quantity);
      }
      await delay(600, undefined, { signal });
      return null;
    }, 'A Amazon não confirmou a inclusão no carrinho.');
    if (!/^[A-Za-z0-9-]+$/.test(added.itemId)) throw new Error('Identificador do item de carrinho inválido.');
    const quantityButton = cartLine + '[data-itemid="' + added.itemId + '"] button[data-a-selector="increment"]';
    for (let quantity = added.quantity + 1; quantity <= item.quantity; quantity++) {
      const button = await control(page, quantityButton);
      if (!button) throw new Error('A quantidade solicitada não está disponível na Amazon.');
      await click(button);
      await wait(async () => {
        const cart = parser.cart(await read(page, cartPath));
        const row = cart.lines.find(line => line.itemId === added.itemId);
        if (!row || row.quantity === quantity - 1) return null;
        return validateAmazonCart(cart, item, oid, quantity);
      }, 'A Amazon não confirmou a quantidade solicitada.');
    }
    validateAmazonCart(parser.cart(await read(page, cartPath)), item, oid, item.quantity);
    const checkout = await control(page, proceed);
    if (!checkout) throw new Error('Botão Fechar pedido da Amazon indisponível.');
    await setStage('CHECKOUT', 'Abrindo o checkout da Amazon pelo carrinho.');
    await click(checkout);
    let openedPayment = false, selectedPix = false, continued = false, declined = false, address;
    let pixRetryAt = null, pixChecked = false, retriedCheckedPix = false, stablePayment;
    let waitingForPaymentBaseline = false;
    const review = await wait(async () => {
      assertAmazonPage(page);
      if (!checkoutPath.test(new URL(page.url()).pathname)) {
        if (cartPath.test(new URL(page.url()).pathname)) return null;
        throw new Error('A Amazon abriu uma etapa desconhecida após o carrinho.');
      }
      const current = parser.review(await read(page, checkoutPath));
      if (current.deliveryBlocker) {
        await setStage('CHECKOUT', 'Verificando disponibilidade de entrega no endereço da Amazon.');
        throw new Error(current.deliveryBlocker);
      }
      if (current.address && address && current.address !== address) throw new Error('O endereço da Amazon mudou durante a compra.');
      if (current.address) address = current.address;
      const decline = !declined && (continued || current.pix)
        ? await control(page, declinePrime, { label: 'Faça seu pedido sem os benefícios Prime' }) : null;
      if (decline) {
        await setStage('CHECKOUT', 'Recusando a oferta Prime para continuar o checkout da Amazon.');
        recordPayment('Puppeteer: clique em Faça seu pedido sem os benefícios Prime.');
        declined = true; await click(decline); return null;
      }
      if (current.pix) {
        const final = await control(page, placePix, { label: 'Confirmar pedido com Pix' });
        if (final) {
          await final.dispose();
          await setStage('CHECKOUT', 'Conferindo a revisão final do pedido Pix da Amazon.');
          return current;
        }
      }
      if (!continued) {
        const selected = await control(page, pixRadio, { radio: true, checked: true });
        paymentState = { pixChecked: Boolean(selected), continueEnabled: false, keyboardRetried: retriedCheckedPix };
        const paymentPending = paymentTrace.requests.some(request => request.status === null && !request.failed);
        if (selected) {
          if (stopAtReview && !selectedPix) {
            await selected.dispose();
            throw new Error('Teste headless inconclusivo: o Pix já estava marcado antes do clique do Puppeteer.');
          }
          pixChecked = true;
          const primary = await control(page, continuePayment);
          const next = primary ?? await control(page, continuePaymentSidebar);
          paymentState.continueEnabled = Boolean(next);
          if (next) {
            await selected.dispose();
            const button = primary ? 'principal' : 'lateral';
            if (paymentPending) {
              stablePayment = null;
              await next.dispose();
              return null;
            }
            if (stablePayment?.button !== button) stablePayment = { button, since: Date.now() };
            if (Date.now() - stablePayment.since < paymentStableMs) {
              await next.dispose();
              return null;
            }
            if (headless) {
              recordPayment('Vigia detectou o botão ' + button + ' habilitado.');
              await capturePaymentEvents(page);
            }
            await setStage('CHECKOUT', 'Clicando em Use este método de pagamento após confirmar Pix.');
            continued = true;
            paymentPhase = 'clique em Use este método de pagamento';
            recordPayment('Puppeteer: clique em Use este método de pagamento.');
            await click(next);
            return null;
          }
          stablePayment = null;
          pixRetryAt ??= Date.now() + pixRetryDelayMs;
          if (!paymentPending && !retriedCheckedPix && Date.now() >= pixRetryAt) {
            retriedCheckedPix = true;
            await setStage('CHECKOUT', 'Reaplicando Pix pelo teclado do Puppeteer porque o botão continua desabilitado.');
            paymentState.keyboardRetried = true;
            paymentPhase = 'nova ativação do Pix';
            await clickPix(page, selected, { keyboard: true });
          } else {
            await selected.dispose();
          }
          return null;
        }
        stablePayment = null;
        const canSelect = !paymentPending && (!selectedPix || (!pixChecked && pixRetryAt !== null && Date.now() >= pixRetryAt));
        const pix = canSelect ? await control(page, pixRadio, { radio: true }) : null;
        if (pix) {
          if (headless && !selectedPix) {
            const ready = await readAcrossNavigation(page, () => page.evaluate(selectors => selectors.every(selector => {
              const button = document.querySelector(selector);
              return button?.matches(':disabled');
            }), [continuePayment, continuePaymentSidebar]), { signal }).catch(async error => {
              await pix.dispose().catch(() => {});
              throw error;
            });
            if (!ready) {
              await pix.dispose();
              if (!waitingForPaymentBaseline) {
                waitingForPaymentBaseline = true;
                const message = 'Aguardando os botões principal e lateral ficarem desabilitados antes de clicar no Pix.';
                recordPayment(message);
                await setStage('CHECKOUT', message);
              }
              return null;
            }
            recordPayment('Estado inicial confirmado: botões principal e lateral desabilitados.');
          }
          await setStage('CHECKOUT', 'Acionando o rádio Pix pelo Puppeteer.');
          pixRetryAt = selectedPix ? null : Date.now() + pixRetryDelayMs;
          paymentPhase = selectedPix ? 'nova ativação do Pix' : 'seleção do Pix';
          selectedPix = true;
          await clickPix(page, pix);
          return null;
        }
      }
      if (!current.pix && !openedPayment && !continued) {
        const change = await control(page, changePayment);
        if (change) {
          await setStage('CHECKOUT', 'Abrindo Alterar forma de pagamento na Amazon.');
          openedPayment = true; await click(change);
        }
      }
      return null;
    }, () => {
      if (waitingForPaymentBaseline && !selectedPix) return 'Os botões de avanço da Amazon não ficaram desabilitados antes da seleção do Pix.';
      if (selectedPix && !pixChecked) return 'A Amazon não confirmou que a opção Pix ficou marcada.';
      if (pixChecked && !continued) return 'Pix selecionado, mas a Amazon não habilitou Use este método de pagamento.';
      return 'A revisão Pix da Amazon não carregou. Confira endereço, pagamento e login no perfil Compra.';
    }, 25000);
    const economics = validateAmazonReview(review, item, rules);
    if (stopAtReview) {
      const message = 'Teste headless concluído: revisão do pedido Pix validada. Pedido não confirmado.';
      paymentTrace.reviewValidated = true;
      recordPayment(message);
      await setStage('CHECKOUT', message);
      throw new Error(message);
    }
    if (reviewOnly) return { ...economics, reviewOnly: true };
    const finalButton = await control(page, placePix, { label: 'Confirmar pedido com Pix' });
    if (!finalButton) throw new Error('Confirmação Pix indisponível na revisão da Amazon.');
    await setStage('FINALIZING', 'Confirmando o pedido Pix da Amazon uma única vez.', { ...economics, items: [item] });
    const lastReview = parser.review(await read(page, checkoutPath));
    validateAmazonReview(lastReview, item, rules);
    if (JSON.stringify(lastReview) !== JSON.stringify(review)) throw new Error('A revisão da Amazon mudou antes da confirmação.');
    const reviewUrl = page.url();
    recordPayment('Puppeteer: clique em Confirmar pedido com Pix.');
    await click(finalButton);
    const pix = await wait(async () => {
      const payment = parser.pix(await read(page));
      if (!payment.ready) return null;
      if (payment.totalCents !== economics.totalCents) throw new Error('O valor exibido no Pix diverge da revisão da Amazon.');
      const button = await control(page, copyPix);
      if (!button) return null;
      try {
        const code = await captureAmazonPix(page, button, { signal });
        return code ? validateAmazonPix(code, economics.totalCents, payment.totalCents) : null;
      } finally { await button.dispose().catch(() => {}); }
    }, 'A Amazon não entregou um Pix Copia e Cola verificável após confirmar o pedido.', 25000);
    result = { ...pix, ...economics, items: [item], payment: 'pix', paid: false };
    result.orderReferences = checkoutOrderReferences({ store: 'amazon', urls: [page.url(), popup?.url(), reviewUrl].filter(Boolean) });
    return result;
  } catch (error) {
    failure = error;
    error.purchaseStep = checkpoint;
    try {
      if (headless && diagnosticPage) {
        await capturePaymentEvents(diagnosticPage);
        for (const events of paymentEventsByDocument.values()) paymentTrace.timeline.push(...events);
        paymentTrace.timeline.sort((left, right) => left.at - right.at);
      }
      error.diagnosticFile = await saveAmazonFailureHtml({ dataDirectory, projectRoot, page: diagnosticPage, popup, snapshots, checkpoint, paymentState, paymentTrace });
    } catch { error.diagnosticWarning = 'Não foi possível salvar a captura HTML da Amazon.'; }
    throw error;
  } finally {
    await browser.close().catch(error => {
      if (result) result.cleanupWarning = String(error.message);
      else if (failure) failure.cleanupWarning = String(error.message);
    });
  }
}
