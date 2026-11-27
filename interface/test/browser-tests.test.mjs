import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';
import { BrowserTestRunner, BROWSER_TEST_CATALOG } from '../server/browser-tests.mjs';
import { createVpsServer } from '../../vps-server/server.mjs';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function completeOAuthLogin(localUrl, vpsBaseUrl, googleCode = 'g-code') {
  const s0 = await (await fetch(`${localUrl}/api/state`)).json();
  const localStartRes = await fetch(`${localUrl}${s0.auth.loginUrl}`, { redirect: 'manual' });
  const vpsStartRes = await fetch(localStartRes.headers.get('location'), { redirect: 'manual' });
  const stateParam = new URL(vpsStartRes.headers.get('location')).searchParams.get('state');
  const vpsCbRes = await fetch(`${vpsBaseUrl}/auth/google/callback?code=${encodeURIComponent(googleCode)}&state=${encodeURIComponent(stateParam)}`, {
    redirect: 'manual',
  });
  const localCbRes = await fetch(vpsCbRes.headers.get('location'), { redirect: 'manual' });
  assert.equal(localCbRes.status, 302);
}

async function waitForIdle(localUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${localUrl}/api/admin/browser-tests`);
    const data = await res.json();
    if (!data.activeRun) return data;
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error('Timeout aguardando conclusão do teste.');
}

test('Admin-only browser tests endpoints enforce 401/403 and support run, screenshot, concurrency, cancel, and clear history', async () => {
  let currentGoogleUser = {
    googleSub: 'sub-admin',
    email: 'admin@gmail.com',
    name: 'Admin Vigia',
    picture: 'https://lh3.googleusercontent.com/a.png',
  };

  const vps = createVpsServer({
    dbPath: ':memory:',
    publicBaseUrl: 'https://vigia-test.ts.net',
    googleClientId: 'cid',
    googleClientSecret: 'csec',
    adminEmails: ['admin@gmail.com'],
    oauthExchange: async () => currentGoogleUser,
  });
  await new Promise(resolveListen => vps.server.listen(0, '127.0.0.1', resolveListen));
  const vpsBaseUrl = `http://127.0.0.1:${vps.server.address().port}`;

  const dir = await mkdtemp(join(tmpdir(), 'vigia-bt-'));
  let releaseBlocker = null;
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const runner = new BrowserTestRunner({
    projectRoot,
    dataDirectory: dir,
    appVersion: '0.12.1',
    chromeExecutable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    customExecutor: async ({ spec, run, reportsDir, artifactsDir, onLog }) => {
      onLog(`Executando ${spec.id}\n`);
      if (spec.id === 'pixelscan-headless') {
        await new Promise(resolveWait => { releaseBlocker = resolveWait; });
        if (run.cancelled) return { exitCode: 1, stdout: '', stderr: 'cancelled' };
        const artifactId = '2026-11-27T14-00-00-000Z-chrome-pixelscan-headless-native-integrated';
        await mkdir(join(artifactsDir, artifactId), { recursive: true });
        await writeFile(join(artifactsDir, artifactId, 'result.png'), fakePng);
        await writeFile(join(reportsDir, `${artifactId}.json`), JSON.stringify({
          id: artifactId,
          verdict: 'human',
          browser: 'Chrome/140.0.0.0',
          clickedStart: true,
          groups: { Navigator: 'Clear', Webdriver: 'Clear', CDP: 'Clear', 'User Agent': 'Clear' },
          detectedChecks: [],
        }));
        return { exitCode: 0, stdout: 'ok\n', stderr: '' };
      }
      if (spec.id === 'stability-soak') {
        await new Promise(resolveWait => { releaseBlocker = resolveWait; });
        return { exitCode: run.cancelled ? 1 : 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: ' - OK ExecutionContext.js\n', stderr: '' };
    },
  });

  let app;
  try {
    app = await createApplication({
      dataDirectory: dir,
      vpsUrl: vpsBaseUrl,
      browserTestRunner: runner,
    });
    await new Promise(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
    const localUrl = `http://127.0.0.1:${app.server.address().port}`;
    const state0 = await (await fetch(`${localUrl}/api/state`)).json();

    // 1. Unauthenticated -> 401
    const unauth = await fetch(`${localUrl}/api/admin/browser-tests`);
    assert.equal(unauth.status, 401);

    // 2. Login as admin and authorize a regular user
    await completeOAuthLogin(localUrl, vpsBaseUrl, 'admin-code');
    const allowRes = await fetch(`${localUrl}/api/admin/allowlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': state0.token },
      body: JSON.stringify({ email: 'usuario@gmail.com', role: 'user', note: 'teste' }),
    });
    assert.equal(allowRes.status, 200);

    // 3. Admin gets catalog
    const adminGet = await fetch(`${localUrl}/api/admin/browser-tests`);
    assert.equal(adminGet.status, 200);
    const btInitial = await adminGet.json();
    assert.equal(btInitial.catalog.length, BROWSER_TEST_CATALOG.length);
    assert.equal(btInitial.activeRun, null);

    // 4. Admin starts pixelscan-headless -> 202, concurrent run -> 409
    const startRes = await fetch(`${localUrl}/api/admin/browser-tests/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': state0.token },
      body: JSON.stringify({ testId: 'pixelscan-headless' }),
    });
    assert.equal(startRes.status, 202);
    const { run } = await startRes.json();
    assert.equal(run.testId, 'pixelscan-headless');

    const conflictRes = await fetch(`${localUrl}/api/admin/browser-tests/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': state0.token },
      body: JSON.stringify({ testId: 'verify' }),
    });
    assert.equal(conflictRes.status, 409);

    // Release blocker and wait for completion
    releaseBlocker();
    const afterPixel = await waitForIdle(localUrl);
    assert.equal(afterPixel.history.length, 1);
    const finished = afterPixel.history[0];
    assert.equal(finished.status, 'passed');
    assert.equal(finished.summary.kind, 'pixelscan');
    assert.equal(finished.summary.verdict, 'human');
    assert.equal(finished.hasScreenshot, true);

    // 5. Screenshot endpoint returns PNG & rejects invalid IDs
    const pngRes = await fetch(`${localUrl}/api/admin/browser-tests/runs/${encodeURIComponent(finished.id)}/screenshot`);
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers.get('content-type'), 'image/png');
    const pngBytes = Buffer.from(await pngRes.arrayBuffer());
    assert.deepEqual(pngBytes, fakePng);

    const badIdRes = await fetch(`${localUrl}/api/admin/browser-tests/runs/..%2F..%2Fetc/screenshot`);
    assert.equal(badIdRes.status, 400);

    // 6. Cancel active run
    releaseBlocker = null;
    const soakRes = await fetch(`${localUrl}/api/admin/browser-tests/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': state0.token },
      body: JSON.stringify({ testId: 'stability-soak' }),
    });
    assert.equal(soakRes.status, 202);
    const cancelRes = await fetch(`${localUrl}/api/admin/browser-tests/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': state0.token },
      body: '{}',
    });
    assert.equal(cancelRes.status, 200);
    releaseBlocker?.();
    const afterCancel = await waitForIdle(localUrl);
    assert.equal(afterCancel.history[0].status, 'cancelled');

    // 7. Run batch for a specific category ('runtime' = 2 tests)
    const batchRes = await fetch(`${localUrl}/api/admin/browser-tests/run-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': state0.token },
      body: JSON.stringify({ category: 'runtime' }),
    });
    assert.equal(batchRes.status, 202);
    const { batch } = await batchRes.json();
    assert.equal(batch.category, 'runtime');
    assert.equal(batch.total, 2);
    const deadlineBatch = Date.now() + 10000;
    let afterBatch = null;
    while (Date.now() < deadlineBatch) {
      afterBatch = await (await fetch(`${localUrl}/api/admin/browser-tests`)).json();
      if (!afterBatch.activeBatch && !afterBatch.activeRun) break;
      await new Promise(r => setTimeout(r, 60));
    }
    assert.equal(afterBatch.activeBatch, null);
    const batchRuns = afterBatch.history.filter(item => item.batchId === batch.id);
    assert.equal(batchRuns.length, 2);
    assert.ok(batchRuns.every(item => item.status === 'passed'));

    // 8. Clear history
    const clearRes = await fetch(`${localUrl}/api/admin/browser-tests/history`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': state0.token },
      body: '{}',
    });
    assert.equal(clearRes.status, 200);
    const cleared = await clearRes.json();
    assert.deepEqual(cleared.history, []);

    // 9. Non-admin user -> 403 on GET, POST run, POST run-batch
    await fetch(`${localUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': state0.token },
      body: '{}',
    });
    currentGoogleUser = {
      googleSub: 'sub-user',
      email: 'usuario@gmail.com',
      name: 'Usuário Comum',
      picture: 'https://lh3.googleusercontent.com/u.png',
    };
    await completeOAuthLogin(localUrl, vpsBaseUrl, 'user-code');
    const userGet = await fetch(`${localUrl}/api/admin/browser-tests`);
    assert.equal(userGet.status, 403);
    const userRun = await fetch(`${localUrl}/api/admin/browser-tests/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': state0.token },
      body: JSON.stringify({ testId: 'verify' }),
    });
    assert.equal(userRun.status, 403);
  } finally {
    if (app) await app.close();
    await new Promise(resolveClose => vps.server.close(resolveClose));
    await rm(dir, { recursive: true, force: true });
  }
});

test('BrowserTestRunner executes real verify and identity-unit scripts cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigia-bt-real-'));
  const runner = new BrowserTestRunner({
    projectRoot,
    dataDirectory: dir,
    appVersion: '0.12.1',
  });
  try {
    await runner.init();
    assert.equal(runner.runtimeAvailable(), true);

    await runner.start('verify');
    while (runner.activeRun) await new Promise(r => setTimeout(r, 80));
    assert.equal(runner.history[0].status, 'passed');
    assert.equal(runner.history[0].summary.kind, 'verify');
    assert.equal(runner.history[0].summary.verifiedCount, 5);

    await runner.start('identity-unit');
    while (runner.activeRun) await new Promise(r => setTimeout(r, 80));
    assert.equal(runner.history[0].status, 'passed');
    assert.equal(runner.history[0].summary.kind, 'unit');
    assert.equal(runner.history[0].summary.failed, 0);
  } finally {
    await runner.close();
    await rm(dir, { recursive: true, force: true });
  }
});
