import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createProfilePool, isTransientBrowserSessionError } from '../server/profiles.mjs';
import { PurchaseSession } from '../server/purchase-session.mjs';
import { runAmazonPurchase } from '../server/amazon-purchase.mjs';
import { defaults } from '../server/availability.mjs';
import { runPurchaseSimulation } from '../server/purchase-simulation.mjs';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('profile pool marks entry disconnected when newPage throws Target.createTarget Session not found', async () => {
  let launches = 0;
  let closedCount = 0;
  const pool = createProfilePool(async () => {
    const id = ++launches;
    const browser = new EventEmitter();
    browser.newPage = async () => {
      if (id === 1) throw new Error('Protocol error (Target.createTarget): Session with given id not found.');
      return Object.assign(new EventEmitter(), { close: async () => {} });
    };
    browser.close = async () => { closedCount++; };
    return { browser, profile: { key: 'amazon/purchase' } };
  });

  const lease1 = await pool.acquire({ projectRoot, dataDirectory: 'sim-data-pool', store: 'amazon', purpose: 'purchase', headless: true });
  await assert.rejects(() => lease1.browser.newPage(), /Session with given id not found/);
  await lease1.browser.close();

  const lease2 = await pool.acquire({ projectRoot, dataDirectory: 'sim-data-pool', store: 'amazon', purpose: 'purchase', headless: true });
  const page = await lease2.browser.newPage();
  assert.ok(page);
  await lease2.browser.close();

  assert.equal(launches, 2);
  assert.equal(closedCount, 2);
  assert.equal(isTransientBrowserSessionError(new Error('Protocol error (Target.createTarget): Session with given id not found.')), true);
  assert.equal(isTransientBrowserSessionError(new Error('Cartão recusado')), false);
});

test('PurchaseSession.start retries and recovers when Target.createTarget fails on first attempt (Mercado Livre)', async () => {
  const events = [];
  let launches = 0;
  const session = new PurchaseSession({
    projectRoot,
    dataDirectory: 'sim-data-ml',
    retryDelayMs: 0,
    launcher: async () => {
      const id = ++launches;
      events.push(`launch-${id}`);
      return {
        browser: {
          newPage: async () => {
            if (id === 1) throw new Error('Protocol error (Target.createTarget): Session with given id not found.');
            return { id, url: () => 'about:blank' };
          },
          close: async () => { events.push(`close-${id}`); },
        },
      };
    },
  });

  await session.start(true);
  assert.equal(launches, 2);
  assert.ok(session.cartPage);
  assert.ok(session.productPage);
  assert.deepEqual(events, ['launch-1', 'close-1', 'launch-2']);
  await session.close();
  assert.deepEqual(events, ['launch-1', 'close-1', 'launch-2', 'close-2']);
});

test('runAmazonPurchase retries and closes broken Chrome when Target.createTarget fails on initial tab creation', async () => {
  const events = [];
  let launches = 0;
  const settings = defaults();
  settings.amazon.purchase.enabled = true;
  settings.amazon.purchase.paymentMethod = 'pix';

  await assert.rejects(() => runAmazonPurchase({
    order: {
      id: 'retry-test',
      store: 'amazon',
      payment: 'pix',
      items: [{ productId: 'p1', itemId: 'B0SIM00001', name: 'Teste', sellerId: 'AMAZON_DIRECT', quantity: 1, limitCents: 9000, unitCents: 7799 }],
    },
    settings,
    projectRoot,
    dataDirectory: 'sim-data-amz',
    signal: new AbortController().signal,
    stage: async () => {},
    openAttempts: 3,
    openRetryDelayMs: 0,
    launcher: async () => {
      const id = ++launches;
      events.push(`launch-${id}`);
      return {
        browser: {
          newPage: async () => {
            if (id < 3) throw new Error('Protocol error (Target.createTarget): Session with given id not found.');
            throw new Error('Erro não-transitório após recuperar sessão');
          },
          close: async () => { events.push(`close-${id}`); },
        },
      };
    },
  }), /Erro não-transitório após recuperar sessão/);

  assert.equal(launches, 3);
  assert.deepEqual(events, ['launch-1', 'close-1', 'launch-2', 'close-2', 'launch-3', 'close-3']);
});

for (const scenarioId of [
  'purchase-amazon-pix',
  'purchase-amazon-card',
  'purchase-ml-pix',
  'purchase-ml-card',
]) {
  test(`end-to-end purchase simulation: ${scenarioId}`, { timeout: 120_000 }, async () => {
    const result = await runPurchaseSimulation({
      scenarioId,
      projectRoot,
      amazonFlow: 'random',
    });
    assert.equal(result.status, 'passed', result.error || `Falha em ${scenarioId}`);
    assert.equal(result.finalClicks, 1);
    assert.ok(result.trustedClicks > 0);
    assert.ok(Array.isArray(result.recoveredFaults) && result.recoveredFaults.length >= 2, 'Todas as falhas injetadas devem ser recuperadas');
    if (scenarioId.startsWith('purchase-amazon-')) {
      assert.ok(['A', 'B'].includes(result.flow), 'Amazon deve sortear Fluxo A ou Fluxo B');
    }
  });
}
