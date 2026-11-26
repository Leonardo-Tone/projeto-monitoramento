import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MonitoringService } from '../server/service.mjs';
import { startML } from '../server/adapters.mjs';
import { createMonitorRecovery } from '../server/monitor-recovery.mjs';
import { launchDedicatedProfile } from '../server/profiles.mjs';
import { openProductCaptcha } from '../server/captcha-resolver.mjs';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PRODUCT_URL = 'https://produto.mercadolivre.com.br/MLB-1234567890-produto-teste-_JM';
const CAPTCHA_MESSAGE = 'CAPTCHA no Mercado Livre. Resolva a verificação no perfil de monitoramento.';
const AVAILABLE_ML_HTML = `<!doctype html><html><head><title>Produto Teste</title></head><body><script id="__NORDIC_RENDERING_CTX__">_n.ctx.r = ${JSON.stringify({
  appProps: {
    pageProps: {
      initialState: {
        id: 'MLB1234567890',
        layout: 'vip',
        no_active_item: false,
        track: {
          melidata_event: {
            event_data: {
              item_id: 'MLB1234567890',
              seller_id: 768826009,
              price: 199.9,
              item_status: 'active',
              has_stock: true,
              quantity: 5,
              shipping_mode: 'me2',
              logistic_type: 'fulfillment',
              reputation_level: '5_green',
              power_seller_status: 'platinum',
            },
          },
        },
        components: {
          seller_summary: { seller: { id: 768826009, name: 'Loja Teste', reputation_level: '5_green', power_seller_status: 'platinum' } },
        },
      },
    },
  },
})};</script></body></html>`;

function fakePage() {
  const page = new EventEmitter();
  let closed = false;
  page.isClosed = () => closed;
  page.close = async () => { closed = true; };
  return page;
}

function makeRegistry() {
  return {
    products: [{
      id: 'ml-captcha-1',
      store: 'ml',
      type: 'produto',
      code: 'MLB1234567890',
      catalog: null,
      url: PRODUCT_URL,
      name: 'Produto Teste ML',
      target: 250,
      quantity: 1,
      alert: true,
      auto: false,
      expectedSellerId: null,
    }],
    events: [],
  };
}

function waitUntil(predicate, timeoutMs = 4000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolvePromise();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        rejectPromise(new Error('Timeout aguardando condição no teste de CAPTCHA.'));
      }
    }, 15);
  });
}

test('CAPTCHA during ensureMLPages resolves outside MonitoringGate without deadlock, notifies OS, and resumes monitoring', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'vigia-captcha-ensure-'));
  const notifications = [];
  const captchaCalls = [];
  let prepareAttempts = 0;
  let consultCalls = 0;
  let browserOpens = 0;
  let invalidateActiveBrowser = () => {};

  const service = new MonitoringService({
    registry: makeRegistry(),
    save: async () => {},
    projectRoot,
    dataDirectory,
    notifier: async notice => {
      notifications.push(notice);
      return { ok: true };
    },
    captchaOpener: async ({ product, notify, signal }) => {
      captchaCalls.push({ url: product.url, store: product.store, aborted: signal.aborted });
      // Simula releaseProfile encerrando/invalidando o Chrome headless anterior.
      invalidateActiveBrowser();
      await notify({ id: 'captcha-ensure-detected', title: 'Vigia · CAPTCHA detectado', message: product.url });
      await new Promise(r => setTimeout(r, 20));
    },
    adapters: {
      amazon: async () => {},
      ml: opts => {
        const transport = createMonitorRecovery({
          store: 'ml',
          signal: opts.signal,
          open: async () => {
            browserOpens++;
            let valid = true;
            invalidateActiveBrowser = () => { valid = false; };
            return { isCurrent: () => valid, clearFailure() {}, close: async () => { valid = false; } };
          },
          clearPages() {},
          onStatus: opts.onStatus,
          onDiagnostic: opts.onDiagnostic,
          runningMessage: 'Monitoramento ativo',
          retryDelayMs: 0,
          restartDelayMs: 0,
        });
        return startML({
          ...opts,
          transport,
          prepareTab: async () => {
            prepareAttempts++;
            if (prepareAttempts === 1) {
              return { pronto: false, motivo: 'captcha', erro: CAPTCHA_MESSAGE };
            }
            return { pronto: true, page: fakePage() };
          },
          consultProduct: async () => {
            consultCalls++;
            return { http: 200, urlFinal: PRODUCT_URL, html: AVAILABLE_ML_HTML, timeout: false, erro: null };
          },
        });
      },
    },
  });

  try {
    const startedAt = Date.now();
    service.start();
    await waitUntil(() => consultCalls >= 1 && service.registry.products[0].price === 199.9);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(captchaCalls.length, 1);
    assert.equal(captchaCalls[0].url, PRODUCT_URL);
    assert.equal(notifications.some(n => n.title.includes('CAPTCHA')), true);
    assert.equal(browserOpens, 2, 'deve reabrir um novo Chrome headless após releaseProfile do CAPTCHA');
    assert.equal(prepareAttempts, 2);
    assert.equal(consultCalls >= 1, true);
    assert.equal(service.registry.products[0].price, 199.9);
    assert.equal(elapsedMs < 5000, true, `esperava retomada imediata sem espera de 15 s (levou ${elapsedMs} ms)`);
  } finally {
    await service.stop();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('CAPTCHA during consult resolves outside MonitoringGate without deadlock, notifies OS, and resumes immediately', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'vigia-captcha-consult-'));
  const notifications = [];
  const captchaCalls = [];
  let prepareAttempts = 0;
  let consultAttempts = 0;
  let browserOpens = 0;
  let invalidateActiveBrowser = () => {};

  const service = new MonitoringService({
    registry: makeRegistry(),
    save: async () => {},
    projectRoot,
    dataDirectory,
    notifier: async notice => {
      notifications.push(notice);
      return { ok: true };
    },
    captchaOpener: async ({ product, notify }) => {
      captchaCalls.push({ url: product.url, store: product.store });
      invalidateActiveBrowser();
      await notify({ id: 'captcha-consult-detected', title: 'Vigia · CAPTCHA detectado', message: product.url });
      await new Promise(r => setTimeout(r, 20));
    },
    adapters: {
      amazon: async () => {},
      ml: opts => {
        const transport = createMonitorRecovery({
          store: 'ml',
          signal: opts.signal,
          open: async () => {
            browserOpens++;
            let valid = true;
            invalidateActiveBrowser = () => { valid = false; };
            return { isCurrent: () => valid, clearFailure() {}, close: async () => { valid = false; } };
          },
          clearPages() {},
          onStatus: opts.onStatus,
          onDiagnostic: opts.onDiagnostic,
          runningMessage: 'Monitoramento ativo',
          retryDelayMs: 0,
          restartDelayMs: 0,
        });
        return startML({
          ...opts,
          transport,
          prepareTab: async () => {
            prepareAttempts++;
            return { pronto: true, page: fakePage() };
          },
          consultProduct: async () => {
            consultAttempts++;
            if (consultAttempts === 1) throw new Error(CAPTCHA_MESSAGE);
            return { http: 200, urlFinal: PRODUCT_URL, html: AVAILABLE_ML_HTML, timeout: false, erro: null };
          },
        });
      },
    },
  });

  try {
    const startedAt = Date.now();
    service.start();
    await waitUntil(() => consultAttempts >= 2 && service.registry.products[0].price === 199.9);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(captchaCalls.length, 1);
    assert.equal(captchaCalls[0].url, PRODUCT_URL);
    assert.equal(notifications.some(n => n.title.includes('CAPTCHA')), true);
    assert.equal(browserOpens, 2, 'deve reabrir um novo Chrome headless após releaseProfile do CAPTCHA');
    assert.equal(prepareAttempts, 2, 'deve preparar aba nova após o CAPTCHA em vez de reutilizar a aba antiga');
    assert.equal(service.registry.products[0].price, 199.9);
    assert.equal(elapsedMs < 5000, true, `esperava retomada imediata sem espera de 15 s (levou ${elapsedMs} ms)`);
  } finally {
    await service.stop();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('service.stop() aborts active headful CAPTCHA resolution cleanly', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'vigia-captcha-stop-'));
  let captchaStarted = false;
  let captchaAborted = false;

  const service = new MonitoringService({
    registry: makeRegistry(),
    save: async () => {},
    projectRoot,
    dataDirectory,
    notifier: async () => ({ ok: true }),
    captchaOpener: async ({ signal }) => {
      captchaStarted = true;
      await new Promise(resolvePromise => {
        if (signal.aborted) {
          captchaAborted = true;
          return resolvePromise();
        }
        signal.addEventListener('abort', () => {
          captchaAborted = true;
          resolvePromise();
        }, { once: true });
      });
    },
    adapters: {
      amazon: async () => {},
      ml: opts => {
        const transport = createMonitorRecovery({
          store: 'ml',
          signal: opts.signal,
          open: async () => ({ isCurrent: () => true, clearFailure() {}, close: async () => {} }),
          clearPages() {},
          onStatus: opts.onStatus,
          onDiagnostic: opts.onDiagnostic,
          runningMessage: 'Monitoramento ativo',
        });
        return startML({
          ...opts,
          transport,
          prepareTab: async () => ({ pronto: false, motivo: 'captcha', erro: CAPTCHA_MESSAGE }),
        });
      },
    },
  });

  try {
    service.start();
    await waitUntil(() => captchaStarted);
    assert.ok(service.activeCaptcha);
    await service.stop();
    assert.equal(captchaAborted, true);
    assert.equal(service.activeCaptcha, null);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('launchDedicatedProfile launches headful Chrome directly via puppeteer without iniciarIntegracao or nativeIdentity', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'vigia-headful-launch-'));
  const integracaoCalls = [];
  const puppeteerCalls = [];
  const fakeHeadfulBrowser = { id: 'headful' };
  const fakeHeadlessBrowser = { id: 'headless' };

  const integracaoLoader = async () => ({
    localizarChrome: () => '/usr/bin/google-chrome',
    iniciarIntegracao: async opts => {
      integracaoCalls.push(opts);
      return { browser: fakeHeadlessBrowser };
    },
  });
  const puppeteerLoader = async () => ({
    default: {
      launch: async opts => {
        puppeteerCalls.push(opts);
        return fakeHeadfulBrowser;
      },
    },
  });

  try {
    const headful = await launchDedicatedProfile({
      projectRoot: dataDirectory,
      dataDirectory,
      store: 'ml',
      purpose: 'monitor',
      headless: false,
      integracaoLoader,
      puppeteerLoader,
    });
    assert.equal(headful.browser, fakeHeadfulBrowser);
    assert.equal(integracaoCalls.length, 0);
    assert.equal(puppeteerCalls.length, 1);
    assert.equal(puppeteerCalls[0].headless, false);
    assert.equal(puppeteerCalls[0].defaultViewport, null);
    assert.equal(puppeteerCalls[0].protocolTimeout, 15000);
    assert.equal(puppeteerCalls[0].userDataDir, headful.profile.userDataDir);
    assert.deepEqual(puppeteerCalls[0].args, ['--profile-directory=Default', '--start-maximized']);
    assert.equal('nativeIdentity' in puppeteerCalls[0], false);

    const headless = await launchDedicatedProfile({
      projectRoot: dataDirectory,
      dataDirectory,
      store: 'ml',
      purpose: 'monitor',
      headless: true,
      integracaoLoader,
      puppeteerLoader,
    });
    assert.equal(headless.browser, fakeHeadlessBrowser);
    assert.equal(integracaoCalls.length, 1);
    assert.equal(puppeteerCalls.length, 1);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('openProductCaptcha reuses the first open tab, navigates to product.url, reveals window, and notifies OS', async () => {
  const navigated = [];
  const notifications = [];
  let newPageCalls = 0;
  let revealed = false;
  let closed = false;
  let polls = 0;
  let currentUrl = 'about:blank';

  const firstTab = {
    isClosed: () => false,
    url: () => currentUrl,
    goto: async url => {
      navigated.push(url);
      currentUrl = url;
    },
    content: async () => {
      polls++;
      return polls >= 2 ? '<html><title>Produto ML</title></html>' : '<html><title>Verificação</title></html>';
    },
  };

  const browser = {
    pages: async () => [firstTab],
    newPage: async () => {
      newPageCalls++;
      return firstTab;
    },
    close: async () => {
      closed = true;
    },
  };

  await openProductCaptcha({
    projectRoot: '.',
    dataDirectory: '.',
    product: { store: 'ml', code: 'MLB1234567890', name: 'Produto Teste', url: PRODUCT_URL },
    signal: new AbortController().signal,
    releaser: async () => {},
    launcher: async opts => {
      assert.equal(opts.headless, false);
      return { browser };
    },
    bringToFront: async page => {
      assert.equal(page, firstTab);
      revealed = true;
    },
    notify: async notice => {
      notifications.push(notice);
    },
    pollIntervalMs: 10,
    maxWaitMs: 3000,
  });

  assert.equal(newPageCalls, 0, 'deve reaproveitar a primeira aba aberta em vez de chamar newPage()');
  assert.deepEqual(navigated, [PRODUCT_URL]);
  assert.equal(revealed, true);
  assert.equal(notifications.some(n => n.title === 'Vigia · CAPTCHA detectado'), true);
  assert.equal(notifications.some(n => n.title === 'Vigia · CAPTCHA resolvido'), true);
  assert.equal(closed, true);
});

