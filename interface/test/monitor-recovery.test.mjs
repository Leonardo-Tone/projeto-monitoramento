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
