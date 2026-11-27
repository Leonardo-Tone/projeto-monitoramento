import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchProfile } from './profiles.mjs';
import { inspectPurchasePage } from './purchase-dom.mjs';
import { isMlBrowserWall, waitForMlBrowserWall } from './ml-verification.mjs';
import { gotoAmazonPage } from './amazon-navigation.mjs';

const pages = {
  ml: {
    profile: 'https://www.mercadolivre.com.br/accounts/profile#menu-user',
    history: 'https://myaccount.mercadolivre.com.br/my_purchases/list#nav-header',
  },
  amazon: {
    profile: 'https://www.amazon.com.br/gp/css/homepage.html',
    history: 'https://www.amazon.com.br/gp/your-account/order-history',
  },
};

const loader = projectRoot => createRequire(join(projectRoot, 'Amazon', 'amazon-monitor-core', 'package.json'))('cheerio').load;
const parseUrl = (value, base) => {
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password ? url : null;
  } catch { return null; }
};
const pageTitle = $ => $('title').text().trim().replace(/^\(\d+\)\s*/, '');
const amazonId = /^\d{3}-\d{7}-\d{7}$/;

function profileIsAuthenticated(store, url, html, load) {
  if (url?.origin !== new URL(pages[store].profile).origin) return false;
  const $ = load(html);
  if (store === 'ml') {
    return /^\/(?:accounts|pampa)\/profile\/?$/.test(url.pathname) && /^Meu Perfil$/i.test(pageTitle($));
  }
  return url.pathname === '/gp/css/homepage.html' && /^Sua conta$/i.test(pageTitle($)) && $('.ya-card-cell').length > 0;
}

export async function checkMonitorAccount({ store, purpose, browser, projectRoot, signal }) {
  signal.throwIfAborted();
  const page = await browser.newPage();
  const profile = purpose === 'monitor' ? 'Monitoramento' : 'Compra';
  const marketplace = store === 'amazon' ? 'Amazon' : 'Mercado Livre';
  const load = loader(projectRoot);
  try {
    const response = store === 'amazon'
      ? await gotoAmazonPage(page, pages[store].profile, { timeout: 15000, signal })
      : await page.goto(pages[store].profile, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (store === 'ml' && (isMlBrowserWall(response?.url?.()) || isMlBrowserWall(page.url()))) {
      const state = await waitForMlBrowserWall(async () => {
        if (isMlBrowserWall(page.url())) {
          return { kind: (await inspectPurchasePage(page)).challengeVisible ? 'CAPTCHA' : 'WALL' };
        }
        const url = parseUrl(page.url());
        if (!url || /\/(?:auth|login|identification)(?:\/|$)/i.test(url.pathname)) return { kind: 'LOGIN' };
        return { kind: profileIsAuthenticated(store, url, await page.content(), load) ? 'READY' : 'LOADING' };
      }, { signal });
      if (state.kind === 'READY') return;
    } else if (response?.status() === 200 && profileIsAuthenticated(store, parseUrl(page.url()), await page.content(), load)) {
      signal.throwIfAborted();
      return;
    }
    throw new Error('Sessão não confirmada.');
  } catch {
    signal.throwIfAborted();
    throw new Error(`${marketplace}: não foi possível confirmar a sessão do perfil ${profile}. Abra esse perfil nas Configurações e confira o login ou a verificação de acesso.`);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function checkMonitoringAccounts({ store, browser, projectRoot, dataDirectory, signal, purchaseEnabled, onStatus }) {
  onStatus('starting', 'Verificando a sessão do perfil Monitoramento.');
  await checkMonitorAccount({ store, purpose: 'monitor', browser, projectRoot, signal });
  if (!purchaseEnabled) return;
  onStatus('starting', 'Verificando a sessão do perfil Compra.');
  const { browser: purchaseBrowser } = await launchProfile({ store, purpose: 'purchase', projectRoot, dataDirectory, headless: true });
  try {
    await checkMonitorAccount({ store, purpose: 'purchase', browser: purchaseBrowser, projectRoot, signal });
  } finally {
    await purchaseBrowser.close();
  }
}

function mlReferences(url) {
  if (!url || !['www.mercadolivre.com.br', 'myaccount.mercadolivre.com.br'].includes(url.hostname)) return [];
  const detail = /^\/post-purchase\/my-purchases\/(\d{8,20})\/status\/?$/.exec(url.pathname);
  if (!detail && (url.hostname !== 'www.mercadolivre.com.br' || !/^\/(?:gz\/checkout|checkout|congrats)(?:\/|$)/.test(url.pathname))) return [];
  const ids = detail ? ['purchase:' + detail[1]] : [];
  for (const [key, value] of url.searchParams) {
    const type = /^(order|pack|purchase)_?id$/i.exec(key)?.[1].toLowerCase();
    if (type && /^\d{8,20}$/.test(value)) ids.push(type + ':' + value);
  }
  return ids;
}

export function checkoutOrderReferences({ store, urls, html, projectRoot }) {
  if (store === 'amazon') {
    const ids = new Set();
    for (const value of urls) {
      const url = parseUrl(value);
      if (url?.origin !== 'https://www.amazon.com.br') continue;
      const checkout = /^\/checkout\/p\/p-(\d{3}-\d{7}-\d{7})(?:\/|$)/.exec(url.pathname)?.[1];
      const purchase = url.searchParams.get('purchaseId');
      if (checkout) ids.add(checkout);
      if (amazonId.test(purchase)) ids.add(purchase);
    }
    return [...ids];
  }
  const explicit = urls.flatMap(value => mlReferences(parseUrl(value)));
  if (explicit.length || !html) return [...new Set(explicit)];
  const $ = loader(projectRoot)(html);
  const links = new Map();
  for (const link of $('main a[href], [role="main"] a[href]').toArray()) {
    const url = parseUrl($(link).attr('href'), urls[0]);
    if (!url?.pathname.startsWith('/post-purchase/my-purchases/')) continue;
    const ids = mlReferences(url);
    if (ids.length) links.set(url.pathname, [...(links.get(url.pathname) ?? []), ...ids]);
  }
  return links.size === 1 ? [...new Set(links.values().next().value)] : [];
}

export function matchPurchaseHistory({ store, url, html, references, projectRoot }) {
  const target = parseUrl(url);
  const expected = new URL(pages[store].history);
  if (!target || target.origin !== expected.origin) return 'UNAVAILABLE';
  const $ = loader(projectRoot)(html);
  if (store === 'amazon') {
    if (!['/gp/your-account/order-history', '/your-orders/orders'].includes(target.pathname) || !/^Seus pedidos$/i.test(pageTitle($))) return 'UNAVAILABLE';
    const ids = $('.order-card a[href]').toArray().map(link => parseUrl($(link).attr('href'), target));
    return ids.some(link => link?.origin === target.origin && link.pathname === '/your-orders/order-details' &&
      references.includes(link.searchParams.get('orderID'))) ? 'VERIFIED' : references.length ? 'NOT_FOUND' : 'NO_REFERENCE';
  }
  if (!['/my_purchases/list', '/purchases/list'].includes(target.pathname) || !/^Minhas compras$/i.test(pageTitle($))) return 'UNAVAILABLE';
  const ids = new Set($('#purchase-content-wrapper a[href]').toArray().flatMap(link => {
    const detail = parseUrl($(link).attr('href'), target);
    return detail?.origin === target.origin ? mlReferences(detail) : [];
  }));
  const groups = ['order:', 'pack:', 'purchase:'].map(type => references.filter(id => id.startsWith(type)));
  const expectedIds = groups.find(group => group.length) ?? [];
  const matched = expectedIds.length > 0 && expectedIds.every(id => ids.has(id));
  return matched ? 'VERIFIED' : references.length ? 'NOT_FOUND' : 'NO_REFERENCE';
}

export async function verifyPurchaseHistory({ store, references, projectRoot, dataDirectory, signal }) {
  const at = () => new Date().toISOString();
  let browser;
  try {
    signal.throwIfAborted();
    ({ browser } = await launchProfile({ store, purpose: 'purchase', projectRoot, dataDirectory, headless: true }));
    const page = await browser.newPage();
    let status;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const response = store === 'amazon'
        ? await gotoAmazonPage(page, pages[store].history, { timeout: 10000, signal })
        : await page.goto(pages[store].history, { waitUntil: 'domcontentloaded', timeout: 10000 });
      status = response?.status() === 200
        ? matchPurchaseHistory({ store, references, url: page.url(), html: await page.content(), projectRoot })
        : 'UNAVAILABLE';
      if (status !== 'NOT_FOUND' || attempt === 1) break;
      await delay(1500, undefined, { signal });
    }
    return { status, at: at() };
  } catch {
    return { status: 'UNAVAILABLE', at: at() };
  } finally {
    await browser?.close().catch(() => {});
  }
}
