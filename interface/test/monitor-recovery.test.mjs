import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMonitorRecovery, monitorFailure, trackNetworkFailures } from '../server/monitor-recovery.mjs';
import { createProfilePool } from '../server/profiles.mjs';

const timeout = () => new Error('Runtime.callFunctionOn timed out. Increase the protocolTimeout setting.');
const failed = erro => [{ ok: false, erro }];

test('recovery discards an incomplete cycle and publishes only the read from fresh tabs', async () => {
  const events = [];
  let resets = 0, attempts = 0;
  const browser = {
    isCurrent: () => true, reportFailure: () => false, clearFailure() {},
    async resetPages() { resets++; },
  };
  const recovery = createMonitorRecovery({
    store: 'amazon', signal: new AbortController().signal, open: async () => browser,
    clearPages() {}, onStatus: status => events.push(status), onDiagnostic: event => events.push(event.action),
  });
  await recovery.start();
  const result = await recovery.run(async () => ++attempts === 1
    ? [{ ok: true, value: 'discard' }, ...failed(new Error('Failed to fetch'))]
    : [{ ok: true, value: 'fresh' }]);
  assert.deepEqual(result, [{ ok: true, value: 'fresh' }]);
  assert.equal(resets, 1);
  assert.deepEqual(events, ['READ_FAILED', 'reconnecting', 'REOPEN_TABS', 'RECOVERED', 'running']);
});

test('concurrent store failures restart the shared Chrome once and revalidate both leases', async () => {
  let launches = 0, closes = 0;
  const pool = createProfilePool(async () => {
    launches++;
    const browser = new EventEmitter();
    browser.close = async () => { closes++; browser.emit('disconnected'); };
    return { browser };
  });
  const validations = [];
  const make = store => createMonitorRecovery({
    store, signal: new AbortController().signal,
    async open(reconnecting) {
      if (reconnecting) validations.push(store);
      return (await pool.acquire({ store, purpose: 'monitor', projectRoot: '.', dataDirectory: '.', headless: true })).browser;
    },
    clearPages() {}, onStatus() {}, onDiagnostic() {},
  });
  const stores = [make('amazon'), make('ml')];
  await Promise.all(stores.map(recovery => recovery.start()));
  try {
    const results = await Promise.all(stores.map(recovery => {
      let attempts = 0;
      return recovery.run(async () => ++attempts === 1 ? failed(timeout()) : [{ ok: true }]);
    }));
    assert.deepEqual(results, [[{ ok: true }], [{ ok: true }]]);
    assert.deepEqual(validations.sort(), ['amazon', 'ml']);
    assert.equal(launches, 2);
    assert.equal(closes, 1);
  } finally { await Promise.all(stores.map(recovery => recovery.close())); }
});

test('explicit HTTP blocks do not trigger recovery and Chrome network reasons are retained', async () => {
  const events = [];
  const recovery = createMonitorRecovery({
    store: 'ml', signal: new AbortController().signal,
    open: async () => ({ isCurrent: () => true, clearFailure() {} }),
    clearPages: () => assert.fail('Access blocks must not replace tabs'), onStatus() {},
    onDiagnostic: event => events.push(event),
  });
  await recovery.start();
  const result = await recovery.run(async () => failed(new Error('Falha ML: HTTP 429')));
  assert.equal(result[0].ok, false);
  assert.deepEqual(events.map(({ action, kind, status }) => [action, kind, status]), [['READ_FAILED', 'ACCESS', 429]]);

  const page = new EventEmitter();
  const tracker = trackNetworkFailures(page);
  const url = 'https://example.test/offers';
  page.emit('requestfailed', { resourceType: () => 'fetch', failure: () => ({ errorText: 'net::ERR_INTERNET_DISCONNECTED' }), url: () => url });
  const failure = monitorFailure(tracker.attach(new TypeError('Failed to fetch'), url));
  assert.equal(failure.kind, 'NETWORK');
  assert.equal(failure.networkCode, 'ERR_INTERNET_DISCONNECTED');
});

test('repeated Chrome timeouts exhaust recovery after one tab reset and one browser restart', async () => {
  let tabs = 0, restarts = 0, attempts = 0;
  const browser = {
    isCurrent: () => true, reportFailure: () => false,
    async resetPages() { tabs++; },
    async restart() { restarts++; },
    async close() {},
  };
  const recovery = createMonitorRecovery({
    store: 'amazon', signal: new AbortController().signal, open: async () => browser,
    clearPages() {}, onStatus() {}, onDiagnostic() {},
  });
  const collect = async () => { attempts++; return failed(timeout()); };
  await recovery.start();
  assert.equal((await recovery.run(collect))[0].ok, false);
  assert.equal((await recovery.run(collect))[0].ok, false);
  assert.deepEqual({ tabs, restarts, attempts }, { tabs: 1, restarts: 1, attempts: 4 });
});

test('product-level 404 and divergent origin do not trigger recovery or mask transport timeouts', async () => {
  const events = [];
  let resets = 0, attempts = 0;
  const browser = {
    isCurrent: () => true, reportFailure: () => false, clearFailure() {},
    async resetPages() { resets++; },
  };
  const recovery = createMonitorRecovery({
    store: 'amazon', signal: new AbortController().signal, open: async () => browser,
    clearPages() {}, onStatus() {}, onDiagnostic: event => events.push(event.action),
    retryDelayMs: 0, restartDelayMs: 0,
  });
  await recovery.start();
  // Isolated 404 or divergent origin should pass cleanly without READ_FAILED/REOPEN_TABS.
  const onlyProductErrors = await recovery.run(async () => [
    { ok: true, value: 'ok' },
    { ok: false, erro: new Error('HTTP 404 no ASIN B0HGNQ3HJJ') },
    { ok: false, erro: new Error('Origem da resposta ML divergente. Use o link final do anúncio ou catálogo.') },
  ]);
  assert.equal(onlyProductErrors.length, 3);
  assert.equal(resets, 0);
  assert.deepEqual(events, []);

  // Combined with a CHROME_TIMEOUT, the transport error is still recovered.
  const mixed = await recovery.run(async () => ++attempts === 1
    ? [{ ok: false, erro: new Error('HTTP 404 no ASIN B0HGNQ3HJJ') }, ...failed(timeout())]
    : [{ ok: false, erro: new Error('HTTP 404 no ASIN B0HGNQ3HJJ') }, { ok: true, value: 'recovered' }]);
  assert.equal(mixed[1].ok, true);
  assert.equal(resets, 1);
  assert.deepEqual(events, ['READ_FAILED', 'REOPEN_TABS', 'RECOVERED']);
});

test('replaceBrowser retries transient session verification failures before giving up', async () => {
  const events = [];
  let opens = 0;
  let current = true;
  const makeBrowser = () => ({
    isCurrent: () => current,
    reportFailure: () => true,
    clearFailure() {},
    async resetPages() {},
    async restart() {},
    async close() {},
  });
  const recovery = createMonitorRecovery({
    store: 'ml', signal: new AbortController().signal,
    async open(reconnecting) {
      opens++;
      if (reconnecting && opens < 3) throw new Error('Mercado Livre: não foi possível confirmar a sessão do perfil Monitoramento.');
      current = true;
      return makeBrowser();
    },
    clearPages() {}, onStatus() {}, onDiagnostic: event => events.push(event.action),
    retryDelayMs: 0, restartDelayMs: 0, maxRecoveryAttempts: 3,
  });
  await recovery.start();
  current = false;
  const res = await recovery.run(async () => [{ ok: true, value: 'back' }]);
  assert.deepEqual(res, [{ ok: true, value: 'back' }]);
  assert.equal(opens, 3);
  assert.deepEqual(events, ['READ_FAILED', 'RESTART_BROWSER', 'RECOVERY_RETRY', 'RECOVERED']);
});

test('restart cooldown allows a new browser restart after cooldown expires and watchdog catches hung cycles', async () => {
  let restarts = 0, attempts = 0;
  const browser = {
    isCurrent: () => true, reportFailure: () => true, clearFailure() {},
    async resetPages() {},
    async restart() { restarts++; },
    async close() {},
  };
  const recovery = createMonitorRecovery({
    store: 'amazon', signal: new AbortController().signal, open: async () => browser,
    clearPages() {}, onStatus() {}, onDiagnostic() {},
    retryDelayMs: 0, restartDelayMs: 0, restartCooldownMs: 25, cycleTimeoutMs: 30,
  });
  await recovery.start();
  // First run hangs -> watchdog triggers CHROME_TIMEOUT -> restarts browser -> second attempt succeeds.
  const first = await recovery.run(async () => {
    attempts++;
    if (attempts === 1) return new Promise(() => {});
    return [{ ok: true, value: 'after-watchdog' }];
  });
  assert.deepEqual(first, [{ ok: true, value: 'after-watchdog' }]);
  assert.equal(restarts, 1);

  // Wait past cooldown and verify a subsequent failure can restart again.
  await new Promise(resolve => setTimeout(resolve, 35));
  let secondAttempts = 0;
  const second = await recovery.run(async () => ++secondAttempts === 1 ? failed(timeout()) : [{ ok: true }]);
  assert.deepEqual(second, [{ ok: true }]);
  assert.equal(restarts, 2);
});

