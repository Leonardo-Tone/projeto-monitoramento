import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPurchaseHtml } from './purchase-dom.mjs';
import { amazonOrigin } from './amazon-checkout.mjs';

const escape = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const visibleLabels = /^(?:Pix|Pagando com Pix|Cartão de crédito|Método de pagamento|Alterar forma de pagamento|Selecionar endereço de entrega|Carregando (?:suas informações de pagamento|informações de entrega)(?:\.{3}|…)?|Continuar|Fechar pedido|Confirmar pedido com Pix|Não, obrigado\(a\)\. Fechar pedido|Faça seu pedido sem os benefícios Prime|Total do pedido:?|Frete:?|Itens:?|Total a pagar:?|Copiar código|Lamentamos, esse item não está disponível no seu endereço nesse momento\. Você pode remover ou substituir este item, ou alterar o endereço para continuar\.)$/i;
const retainedAttributes = ['id', 'class', 'role', 'type', 'name', 'data-testid', 'data-messageid', 'aria-disabled', 'aria-expanded', 'aria-hidden'];
const structuralToken = /^[a-zA-Z][a-zA-Z_-]{0,85}$/;
const price = /^-?R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}$/;

export function observeAmazonPaymentButtons() {
  if (location.origin !== 'https://www.amazon.com.br' || globalThis.__vigiaAmazonPaymentEvents) return;
  const buttons = [
    ['principal', 'checkout-primary-continue-button-id', 'bottom-continue-button'],
    ['lateral', 'checkout-secondary-continue-button-id', 'secondary-continue-button'],
  ];
  const events = [];
  globalThis.__vigiaAmazonPaymentEvents = events;
  const record = message => {
    if (events.length < 100) events.push({ at: Date.now(), message });
  };
  const previous = new Map();
  const snapshot = () => {
    for (const [label, id, testId] of buttons) {
      const wrapper = document.getElementById(id);
      const input = wrapper?.querySelector(`input[data-testid="${testId}"]`);
      const state = input
        ? `disabled=${input.matches(':disabled')}, classe desabilitada=${Boolean(input.closest('.a-button-disabled'))}, aria-disabled=${Boolean(input.closest('[aria-disabled="true"]'))}`
        : 'ausente';
      if (previous.get(label) !== state) {
        previous.set(label, state);
        record(label + ': ' + state);
      }
    }
  };
  new MutationObserver(records => {
    for (const [index, change] of records.entries()) {
      if (change.type !== 'attributes') continue;
      const { target, attributeName, oldValue } = change;
      const button = buttons.find(([, id, testId]) => target.id === id || target.getAttribute('data-testid') === testId);
      if (!button) continue;
      // The next record's old value preserves transitions within the same observer batch.
      const next = records.slice(index + 1).find(entry => entry.target === target && entry.attributeName === attributeName);
      const value = next ? next.oldValue : target.getAttribute(attributeName);
      const active = attributeName === 'class' ? text => /(?:^|\s)a-button-disabled(?:\s|$)/.test(text ?? '')
        : attributeName === 'aria-disabled' ? text => text === 'true' : text => text !== null;
      if (active(oldValue) !== active(value)) record(`${button[0]}: ${attributeName} ${active(oldValue)} → ${active(value)}`);
    }
    snapshot();
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true,
    attributeFilter: ['disabled', 'aria-disabled', 'class'] });
  snapshot();
}

function routeOf(value) {
  try {
    const url = new URL(value);
    if (url.origin !== amazonOrigin) return url.protocol === 'about:' ? 'Aba em branco' : 'Origem diferente da Amazon';
    const path = url.pathname;
    if (/^\/(?:cart|gp\/cart)(?:\/|$)/.test(path)) return '/cart';
    if (/^\/(?:dp|gp\/product)\//.test(path)) return '/dp/:asin';
    const checkout = path.match(/^\/checkout(?:\/p\/[^/]+)?(?:\/(entry|pip|spc|pay|shipaddressselect|itemselect|review|thankyou))?(?:\/|$)/);
    if (checkout) return '/checkout' + (checkout[1] ? '/' + checkout[1] : '');
    if (/^\/(?:payments-portal|cpe)(?:\/|$)/.test(path)) return 'Portal de pagamento Amazon';
    if (/^\/ap(?:\/|$)/.test(path)) return 'Login Amazon';
    return 'Outra rota da Amazon';
  } catch { return 'Rota indisponível'; }
}

export function redactAmazonHtml(html, projectRoot) {
  const { load } = createRequire(join(projectRoot, 'Amazon', 'amazon-monitor-core', 'package.json'))('cheerio');
  const $ = load(html);
  $('head, script, style, template, svg, img, iframe, object, embed, link, meta, textarea, [contenteditable], input[type="hidden"], #deliver-to-address-text, #deliver-to-customer-text, [data-testid="qr-code"], [data-testid^="Upx-Prepare-"]').remove();
  $('*').contents().filter((_, node) => node.type === 'comment').remove();
  $('*').each((_, element) => {
    for (const [name, value] of Object.entries(element.attribs)) {
      if (['checked', 'disabled', 'hidden'].includes(name)) { $(element).attr(name, ''); continue; }
      if (name === 'aria-label' || name === 'value') {
        if (!visibleLabels.test(value.trim())) $(element).removeAttr(name);
        continue;
      }
      if (!retainedAttributes.includes(name) || !value.split(/\s+/).every(token => structuralToken.test(token))) {
        $(element).removeAttr(name);
      }
    }
    $(element).contents().each((_, node) => {
      if (node.type !== 'text') return;
      const value = node.data.replace(/\s+/g, ' ').trim();
      if (value && !visibleLabels.test(value) && !price.test(value)) node.data = '[ocultado]';
    });
  });
  return ($('body').html() ?? '').slice(0, 1_000_000);
}

async function currentHtml(page) {
  const timer = AbortSignal.timeout(2000);
  const expired = new Promise(resolve => timer.addEventListener('abort', () => resolve(null), { once: true }));
  return Promise.race([readPurchaseHtml(page).catch(() => null), expired]);
}

export async function saveAmazonFailureHtml({ dataDirectory, projectRoot, page, popup, snapshots, checkpoint, paymentState, paymentTrace }) {
  if (!dataDirectory || !page || process.env.VIGIA_AMAZON_DIAGNOSTICS === '0') return null;
  const captures = await Promise.all([page, popup].filter(Boolean).map(async tab => {
    const live = await currentHtml(tab);
    const snapshot = live ? { html: live, url: tab.url() } : snapshots.get(tab);
    const source = live ? (paymentTrace?.reviewValidated ? 'Página da revisão validada' : 'Página no momento da falha') : 'Última leitura bem-sucedida';
    return { route: routeOf(snapshot?.url ?? tab.url()), source, html: snapshot?.html };
  }));
  const views = captures.map(({ route, source, html }) =>
    '<section><h2>' + escape(route) + '</h2><p>' + (html ? source : 'HTML indisponível') + '</p>' +
    (html ? '<pre>' + escape(redactAmazonHtml(html, projectRoot)) + '</pre>' : '') + '</section>');
  const file = (paymentTrace?.timeline ? 'amazon-headless-' : 'amazon-falha-') + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID() + '.html';
  const directory = join(dataDirectory, 'diagnostics');
  const flag = value => value ? 'sim' : 'não';
  const liveState = paymentState ? '<p>Última leitura dos controles: Pix marcado: ' + flag(paymentState.pixChecked) +
    '; botão de avanço clicável: ' + flag(paymentState.continueEnabled) +
    '; nova ativação pelo teclado: ' + flag(paymentState.keyboardRetried) + '.</p>' : '';
  const trace = paymentTrace ? '<p>Acionamentos do Pix: ' + escape(paymentTrace.inputs.join(', ') || 'nenhum') +
    '.</p><p>POST /checkout/p/:id/pay/continue: ' + escape(paymentTrace.requests.map(({ phase, status, failed }) =>
      phase + ' (' + (failed ? 'requisição falhou' : status === null ? 'sem resposta observada' : 'HTTP ' + status) + ')').join('; ') || 'nenhum observado') + '.</p>' : '';
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timeline = paymentTrace?.timeline ? '<h2>Diagnóstico headless</h2><ul>' +
    paymentTrace.timeline.map(({ at, message }) => '<li>' + escape(new Date(at).toISOString() + ' ' + message) + '</li>').join('') + '</ul>' : '';
  await writeFile(join(directory, file), '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Diagnóstico da compra Amazon</title><h1>' +
    escape(checkpoint) + '</h1>' + liveState + trace + timeline + views.join('') + '</html>', { flag: 'wx', mode: 0o600 });
  return 'diagnostics/' + file;
}
