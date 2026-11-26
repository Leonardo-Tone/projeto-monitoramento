import { createRequire } from 'node:module';
import { join } from 'node:path';

export const amazonOrigin = 'https://www.amazon.com.br';
export const placeOrder = '#submitOrderButtonId input[data-testid="SPC_selectPlaceOrder"]';
export const placePix = placeOrder;
export const copyPix = '[data-testid="Upx-Prepare-PrimaryButton"] button';
export const cartLine = '.sc-list-item[data-asin][data-itemid]';

export function cents(text) {
  const amounts = [...String(text ?? '').matchAll(/(-\s*)?R\$\s*(\d[\d.]*),(\d{2})/g)];
  if (amounts.length !== 1) return null;
  const [, negative, reais, fraction] = amounts[0];
  const value = Number(reais.replaceAll('.', '')) * 100 + Number(fraction);
  return Number.isSafeInteger(value) ? (negative ? -value : value) : null;
}

export function sellerMatches(actual, expected) {
  if (expected.sellerId === 'AMAZON_DIRECT') {
    return /^amazon\.com\.br$/i.test(actual.seller ?? '');
  }
  return Boolean(expected.sellerId && actual.sellerId === expected.sellerId);
}

export function createAmazonCheckoutParser(projectRoot) {
  const { load } = createRequire(join(projectRoot, 'Amazon', 'amazon-monitor-core', 'package.json'))('cheerio');
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const seller = (root, selector) => {
    const links = root.find(selector).toArray().map(link => {
      try {
        const url = new URL(link.attribs.href, amazonOrigin);
        return url.origin === amazonOrigin ? url.searchParams.get('seller') : null;
      } catch { return null; }
    }).filter(Boolean);
    const ids = new Set(links);
    return { sellerId: ids.size === 1 ? links[0] : null, sellerConflict: ids.size > 1 };
  };

  return {
    cart(html) {
      const $ = load(html);
      return {
        ready: $('#sc-active-cart, #sc-buy-box, #sc-your-amazon-cart-is-empty').length > 0,
        lines: $(cartLine).toArray().map(element => {
          const row = $(element);
          const price = row.attr('data-displayprice') ?? '';
          return {
            asin: row.attr('data-asin'), itemId: row.attr('data-itemid'), oid: row.attr('data-encoded-offering'),
            selection: row.attr('data-isselected'), quantity: Number(row.attr('data-quantity')),
            inStock: row.attr('data-outofstock') === '0',
            unitCents: /^\d+\.\d{2}$/.test(price) ? Number(price.replace('.', '')) : null,
            ...seller(row, 'a[href*="/seller/at-a-glance"][href*="seller="]'),
          };
        }),
      };
    },

    review(html) {
      const $ = load(html);
      const visible = nodes => nodes.filter((_, el) => !$(el).closest('[hidden], .aok-hidden, .a-hidden').length);
      const deliveryBlocker = visible($('[data-messageid="NoDeliveryOptionAvailableForLineItemMessage"]')).length
        ? 'A Amazon informou que o item não está disponível para entrega no endereço selecionado.' : null;
      const rows = visible($('.lineitem-container'));
      const item = rows.first();
      const asinFields = $('[data-testid^="Item_asin_"]');
      const quantities = item.find('.a-stepper-value-live').toArray().map(el => clean($(el).text()));
      item.find('[name="checkout-quantity-stepper"][data-steppervalue]').each((_, el) => quantities.push($(el).attr('data-steppervalue')));
      const provedQuantity = [...new Set(quantities.filter(value => /^\d+$/.test(value)).map(Number))];
      const sellerLine = item.find('.lineitem-seller-section');
      const sellerText = clean(sellerLine.text()).replace(/^Vendido por\s*/i, '');
      const payment = visible($('#selected-payment-methods-list-container [id^="payment-option-text-"]'));
      const paymentText = clean(payment.text());
      const cardMatch = payment.length === 1 ? paymentText.match(/^Pagando com .+\b(\d{4})$/i) : null;
      const cardLastFour = cardMatch ? cardMatch[1] : null;
      const visibleText = nodes => clean(nodes.toArray().map(el => {
        const clone = $(el).clone();
        clone.find('[hidden], .aok-hidden, .a-hidden').remove();
        return clone.text();
      }).join(' '));
      const subtotalsText = visibleText(visible($('#subtotals, #subtotals-marketplace-tango-bottom')));
      const hasInterest = /\bcom juros\b/i.test(subtotalsText);
      const hasMultiInstallments = /\b(?:Em\s+)?(?!1x\b)\d+x\b/i.test(subtotalsText);
      const hasSingleInstallment = /\bEm\s+1x\b/i.test(subtotalsText) && /\bsem juros\b/i.test(subtotalsText);
      const hasCashPrice = /\bPre[çc]o\s+[àa]\s+vista\b/i.test(subtotalsText);
      const hasAnyInstallmentText = /\b\d+x\b|parcela|juros/i.test(subtotalsText);
      const installmentsOk = !hasInterest && !hasMultiInstallments && (hasSingleInstallment || hasCashPrice || !hasAnyInstallmentText);
      const address = clean(visible($('#deliver-to-address-text')).text());
      const selectedDelivery = visible($('.rcx-checkout-delivery-option-a-control-row[data-isselected="true"] input[type="radio"][checked]'));
      const amounts = [];
      visible($('.order-summary-grid')).each((_, el) => {
        const row = $(el);
        const label = clean(row.find('.order-summary-line-term').text());
        const type = row.find('input[name="subtotalLineType"]').val();
        const value = cents(row.find('.order-summary-line-definition').text());
        if (label) amounts.push({ label, type, value });
      });
      visible($('.a-row.a-color-success')).each((_, el) => {
        const row = $(el);
        const price = row.children('.a-column').find('[data-shimmer-target="ordertotals-amount"]');
        if (price.length !== 1 || row.closest('.order-summary-grid').length) return;
        const label = clean(row.children('.a-column').first().text());
        if (label) amounts.push({ label, value: cents(price.text()) });
      });
      const amount = match => {
        const values = amounts.filter(match).map(row => row.value);
        return values.length === 1 ? values[0] : null;
      };
      const known = row => /^(ITEMS|SHIPPING|TOTAL_BEFORE_SPECIAL_PAYMENTS)_TAX_INCLUSIVE$/.test(row.type ?? '') ||
        /^(?:Desc\. forma pgto|Frete GR[ÁA]TIS\.?|Total do pedido:?)$/i.test(row.label);
      const optionalDiscount = regex => {
        const values = amounts.filter(row => regex.test(row.label)).map(row => row.value);
        return !values.length ? 0 : values.length === 1 && Number.isSafeInteger(values[0]) && values[0] <= 0 ? -values[0] : null;
      };
      return {
        deliveryBlocker,
        isPrimeInterstitial: visible($('a#prime-decline-button')).length > 0,
        lineCount: rows.length, asin: asinFields.length === 1 ? clean(asinFields.text()) : null,
        quantity: provedQuantity.length === 1 ? provedQuantity[0] : null,
        seller: sellerText, ...seller(sellerLine, 'a[href*="seller="]'),
        paymentText,
        pix: payment.length === 1 && /^(?:Pagando com )?Pix$/i.test(paymentText),
        cardLastFour,
        installmentsOk,
        address, delivery: selectedDelivery.length === 1 ? selectedDelivery.val() : null,
        subtotalCents: amount(row => row.type === 'ITEMS_TAX_INCLUSIVE'),
        grossShipping: amount(row => row.type === 'SHIPPING_TAX_INCLUSIVE'),
        beforeDiscountCents: amount(row => row.type === 'TOTAL_BEFORE_SPECIAL_PAYMENTS_TAX_INCLUSIVE'),
        shippingDiscount: optionalDiscount(/^Frete GR[ÁA]TIS\.?$/i),
        pixDiscountCents: optionalDiscount(/^Desc\. forma pgto$/i),
        totalCents: amount(row => /^Total do pedido:?$/i.test(row.label)),
        unknownAdjustments: amounts.some(row => !known(row)),
      };
    },

    pix(html) {
      const $ = load(html);
      const qr = $('[data-testid="qr-code"]');
      const total = $('[data-testid="heading"]').toArray().map(el => clean($(el).text()))
        .filter(value => /^Total a pagar:/i.test(value));
      return { ready: qr.length === 1 && $(copyPix).length === 1, totalCents: total.length === 1 ? cents(total[0]) : null };
    },

    thankYou(html, url) {
      let isThankYouUrl = false;
      try {
        const parsed = new URL(url);
        isThankYouUrl = parsed.origin === amazonOrigin &&
          /^\/(?:checkout(?:\/p\/[^/]+)?\/thankyou|gp\/buy\/thankyou)(?:\/|$)/i.test(parsed.pathname);
      } catch {
        isThankYouUrl = false;
      }
      const $ = load(html);
      const visible = nodes => nodes.filter((_, el) => !$(el).closest('[hidden], .aok-hidden, .a-hidden').length);
      const root = $('body').length ? $('body').clone() : $.root().clone();
      root.find('script, style, template, [hidden], .aok-hidden, .a-hidden').remove();
      const bodyText = clean(root.text());
      const errorAlerts = visible($('.a-alert-error, .pmts-error-message'));
      const hasErrorAlert = errorAlerts.toArray().some(el => clean($(el).text()).length > 0);
      const hasErrorText = /(?:pagamento recusado|cart[ãa]o recusado|n[ãa]o foi poss[íi]vel processar (?:o|seu) pagamento|problema com (?:o|seu) pagamento|revise seu m[ée]todo de pagamento|precisa de a[çc][ãa]o)/i.test(bodyText);
      const error = hasErrorAlert || hasErrorText;
      const confirmed = visible($('#widget-purchaseSummary, .a-alert-success')).length > 0 ||
        /\b(?:Pedido realizado|Obrigado)\b/i.test(bodyText);
      const orderIds = [...new Set(String(html ?? '').match(/\b70\d-\d{7}-\d{7}\b/g) ?? [])];
      return { ready: isThankYouUrl && confirmed && !error, confirmed, error, orderIds };
    },
  };
}

export function validateAmazonReview(review, item, rules) {
  if (review.deliveryBlocker) throw new Error(review.deliveryBlocker);
  if (review.lineCount !== 1 || review.asin !== item.itemId || review.quantity !== item.quantity ||
      review.sellerConflict || !sellerMatches(review, item)) {
    throw new Error('ASIN, vendedor ou quantidade divergente na revisão da Amazon.');
  }
  const paymentMethod = rules?.paymentMethod ?? 'pix';
  if (!['pix', 'credit_card'].includes(paymentMethod)) {
    throw new Error('Forma de pagamento não suportada na revisão da Amazon.');
  }
  if (paymentMethod === 'credit_card') {
    if (!rules?.cardLastFour || review.cardLastFour !== rules.cardLastFour) {
      throw new Error('Cartão de crédito divergente ou não confirmado na revisão da Amazon.');
    }
    if (review.installmentsOk !== true) {
      throw new Error('Parcelamento não permitido na revisão da Amazon: somente pagamento à vista (1x sem juros) é aceito.');
    }
    if (!review.address || !review.delivery) {
      throw new Error('Endereço ou entrega não confirmados na revisão da Amazon.');
    }
  } else if (!review.pix || !review.address || !review.delivery) {
    throw new Error('Pix, endereço ou entrega não confirmados na revisão da Amazon.');
  }
  const { subtotalCents, grossShipping, beforeDiscountCents, shippingDiscount, pixDiscountCents, totalCents } = review;
  if (review.unknownAdjustments || ![subtotalCents, grossShipping, beforeDiscountCents, shippingDiscount, pixDiscountCents, totalCents].every(Number.isSafeInteger) ||
      subtotalCents !== item.unitCents * item.quantity || shippingDiscount > grossShipping ||
      grossShipping < 0 || totalCents <= 0 || subtotalCents + grossShipping !== beforeDiscountCents ||
      beforeDiscountCents - shippingDiscount - pixDiscountCents !== totalCents) {
    throw new Error('Os valores da revisão da Amazon não foram conciliados.');
  }
  const shippingCents = grossShipping - shippingDiscount;
  if ((rules.freeShippingOnly && shippingCents !== 0) ||
      (rules.maxShippingCents !== null && shippingCents > rules.maxShippingCents) ||
      subtotalCents + (rules.includeShipping ? shippingCents : 0) > item.limitCents * item.quantity) {
    throw new Error('Preço ou frete da Amazon acima do limite configurado.');
  }
  return { subtotalCents, shippingCents, grossShippingCents: grossShipping, shippingDiscountCents: shippingDiscount, beforeDiscountCents, pixDiscountCents, totalCents };
}
