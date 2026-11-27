import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRemoteUserData, createApplication } from '../server.mjs';
import { AuthClient } from '../server/auth-client.mjs';
import { validateTarListing } from '../server/updater.mjs';
import { createVpsServer } from '../../vps-server/server.mjs';

async function completeOAuthLogin(localUrl, vpsBaseUrl, googleCode = 'g-code') {
  const s0 = await (await fetch(`${localUrl}/api/state`)).json();
  assert.equal(s0.auth.loginUrl, '/api/auth/start');
  const localStartRes = await fetch(`${localUrl}${s0.auth.loginUrl}`, { redirect: 'manual' });
  assert.equal(localStartRes.status, 302);
  const vpsStartUrl = localStartRes.headers.get('location');
  assert.ok(vpsStartUrl.startsWith(`${vpsBaseUrl}/auth/google/start?callback=`));

  const vpsStartRes = await fetch(vpsStartUrl, { redirect: 'manual' });
  assert.equal(vpsStartRes.status, 302);
  const stateParam = new URL(vpsStartRes.headers.get('location')).searchParams.get('state');

  const vpsCbRes = await fetch(`${vpsBaseUrl}/auth/google/callback?code=${encodeURIComponent(googleCode)}&state=${encodeURIComponent(stateParam)}`, {
    redirect: 'manual',
  });
  assert.equal(vpsCbRes.status, 302);
  const localCallbackUrl = vpsCbRes.headers.get('location');
  assert.ok(localCallbackUrl.startsWith(`${localUrl}/api/auth/callback?`));
  assert.ok(new URL(localCallbackUrl).searchParams.get('local_state'));
  assert.ok(new URL(localCallbackUrl).searchParams.get('code'));

  const localCbRes = await fetch(localCallbackUrl, { redirect: 'manual' });
  assert.equal(localCbRes.status, 302);
  assert.equal(localCbRes.headers.get('location'), '/');
  return localCallbackUrl;
}

test('Vigia local integrates with VPS Google OAuth and syncs products and settings across instances', async () => {
  const vps = createVpsServer({
    dbPath: ':memory:',
    publicBaseUrl: 'https://vigia-test.ts.net',
    googleClientId: 'cid',
    googleClientSecret: 'csec',
    adminEmails: ['dono@gmail.com'],
    oauthExchange: async () => ({
      googleSub: 'google-sub-dono',
      email: 'dono@gmail.com',
      name: 'Dono Vigia',
      picture: 'https://lh3.googleusercontent.com/dono.png',
    }),
  });
  await new Promise(resolve => vps.server.listen(0, '127.0.0.1', resolve));
  const vpsBaseUrl = `http://127.0.0.1:${vps.server.address().port}`;

  const dir1 = await mkdtemp(join(tmpdir(), 'vigia-auth-1-'));
  const dir2 = await mkdtemp(join(tmpdir(), 'vigia-auth-2-'));

  let app1;
  let app2;
  try {
    app1 = await createApplication({ dataDirectory: dir1, vpsUrl: vpsBaseUrl });
    await new Promise(resolve => app1.server.listen(0, '127.0.0.1', resolve));
    const local1 = `http://127.0.0.1:${app1.server.address().port}`;

    // 1. Antes do login, state mostra enabled=true, authenticated=false e oculta dados sensíveis
    const stateBefore = await (await fetch(`${local1}/api/state`)).json();
    assert.equal(stateBefore.auth.enabled, true);
    assert.equal(stateBefore.auth.authenticated, false);
    assert.equal('vpsUrl' in stateBefore.auth, false);
    assert.equal(stateBefore.auth.loginUrl, '/api/auth/start');
    assert.deepEqual(stateBefore.products, []);

    const historyBlocked = await fetch(`${local1}/api/availability-history`);
    assert.equal(historyBlocked.status, 401);

    // Mutações bloqueadas antes do login
    const blockedRes = await fetch(`${local1}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': stateBefore.token },
      body: JSON.stringify({ store: 'amazon', url: 'https://www.amazon.com.br/dp/B09V3KXJPB' }),
    });
    assert.equal(blockedRes.status, 401);

    // 2. Simula fluxo OAuth completo com local_state anti-CSRF
    await completeOAuthLogin(local1, vpsBaseUrl, 'g-code');

    // 3. Agora está autenticado e pode adicionar produto + alterar configurações
    const stateAfter = await (await fetch(`${local1}/api/state`)).json();
    assert.equal(stateAfter.auth.authenticated, true);
    assert.equal(stateAfter.auth.user.email, 'dono@gmail.com');
    assert.equal(stateAfter.auth.user.role, 'admin');

    const addRes = await fetch(`${local1}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': stateAfter.token },
      body: JSON.stringify({
        store: 'amazon',
        url: 'https://www.amazon.com.br/dp/B09V3KXJPB',
        name: 'Produto Sincronizado',
        quantity: 2,
      }),
    });
    assert.equal(addRes.status, 200);

    const nextSettings = structuredClone(stateAfter.settings);
    nextSettings.amazon.onlyAmazon = true;
    const settingsRes = await fetch(`${local1}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': stateAfter.token },
      body: JSON.stringify(nextSettings),
    });
    assert.equal(settingsRes.status, 200);

    // 4. Segunda instância limpa faz login com o mesmo Gmail e recebe os dados do VPS
    app2 = await createApplication({ dataDirectory: dir2, vpsUrl: vpsBaseUrl });
    await new Promise(resolve => app2.server.listen(0, '127.0.0.1', resolve));
    const local2 = `http://127.0.0.1:${app2.server.address().port}`;

    await completeOAuthLogin(local2, vpsBaseUrl, 'g-code-2');

    const syncedState = await (await fetch(`${local2}/api/state`)).json();
    assert.equal(syncedState.products.length, 1);
    assert.equal(syncedState.products[0].name, 'Produto Sincronizado');
    assert.equal(syncedState.products[0].quantity, 2);
    assert.equal(syncedState.settings.amazon.onlyAmazon, true);
  } finally {
    if (app1) await app1.close();
    if (app2) await app2.close();
    await vps.close();
    await rm(dir1, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
});

test('allows offline access for up to 7 days when VPS is down and blocks after 7 days', async () => {
  const vps = createVpsServer({
    dbPath: ':memory:',
    publicBaseUrl: 'https://vigia-test.ts.net',
    googleClientId: 'cid',
    googleClientSecret: 'csec',
    adminEmails: ['offline@gmail.com'],
    oauthExchange: async () => ({
      googleSub: 'google-sub-offline',
      email: 'offline@gmail.com',
      name: 'Usuario Offline',
      picture: '',
    }),
  });
  await new Promise(resolve => vps.server.listen(0, '127.0.0.1', resolve));
  const vpsBaseUrl = `http://127.0.0.1:${vps.server.address().port}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'vigia-offline-'));

  let currentTime = Date.parse('2026-11-26T12:00:00.000Z');
  const now = () => currentTime;
  const DAY = 24 * 60 * 60 * 1000;

  let app;
  try {
    // 1. Login online e adiciona um produto
    app = await createApplication({ dataDirectory: dataDir, vpsUrl: vpsBaseUrl, authNow: now });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${app.server.address().port}`;

    await completeOAuthLogin(localUrl, vpsBaseUrl, 'c1');

    const s1 = await (await fetch(`${localUrl}/api/state`)).json();
    assert.equal(s1.auth.authenticated, true);
    const addRes = await fetch(`${localUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': s1.token },
      body: JSON.stringify({ store: 'amazon', url: 'https://www.amazon.com.br/dp/B09V3KXJPB', name: 'Salvo Antes Offline' }),
    });
    assert.equal(addRes.status, 200);
    await app.close();
    app = null;

    // 2. Desliga o VPS!
    await vps.close();

    // 3. 3 dias depois, VPS fora do ar -> usuário continua acessando e usando o Vigia
    currentTime += 3 * DAY;
    app = await createApplication({ dataDirectory: dataDir, vpsUrl: vpsBaseUrl, authNow: now });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const localOffline = `http://127.0.0.1:${app.server.address().port}`;

    const sOffline = await (await fetch(`${localOffline}/api/state`)).json();
    assert.equal(sOffline.auth.authenticated, true);
    assert.equal(sOffline.auth.offlineMode, true);
    assert.equal(sOffline.auth.offlineDaysRemaining, 4);
    assert.equal(sOffline.products.length, 1);
    assert.equal(sOffline.products[0].name, 'Salvo Antes Offline');
    await app.close();
    app = null;

    // 4. 8 dias depois da última verificação online -> bloqueado e sessão/dados limpos!
    currentTime += 5 * DAY;
    app = await createApplication({ dataDirectory: dataDir, vpsUrl: vpsBaseUrl, authNow: now });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const localExpired = `http://127.0.0.1:${app.server.address().port}`;

    const sExpired = await (await fetch(`${localExpired}/api/state`)).json();
    assert.equal(sExpired.auth.authenticated, false);
    assert.equal(sExpired.auth.offlineExpired, true);
    assert.deepEqual(sExpired.products, []);
  } finally {
    if (app) await app.close();
    await vps.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('automatically downloads, verifies SHA-256, and installs published VPS updates on login', async () => {
  const releasesDir = await mkdtemp(join(tmpdir(), 'vigia-releases-'));
  const pkgSrcDir = await mkdtemp(join(tmpdir(), 'vigia-pkg-src-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'vigia-target-'));
  const dataDir = join(targetDir, '.data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(targetDir, 'package.json'), JSON.stringify({ version: '0.11.0' }), 'utf8');

  // Cria um pacote de atualização v0.12.0
  await writeFile(join(pkgSrcDir, 'package.json'), JSON.stringify({ version: '0.12.0' }), 'utf8');
  await writeFile(join(pkgSrcDir, 'update-marker.txt'), 'versao-0.12.0-instalada', 'utf8');
  const archiveName = 'vigia-0.12.0.tar.gz';
  const archivePath = join(releasesDir, archiveName);
  execFileSync('tar', ['-czf', archivePath, '-C', pkgSrcDir, '.']);
  const sha256 = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  await writeFile(join(releasesDir, 'latest.json'), JSON.stringify({
    version: '0.12.0',
    filename: archiveName,
    sha256,
    notes: 'Melhorias de performance',
    publishedAt: new Date().toISOString(),
  }), 'utf8');

  const vps = createVpsServer({
    dbPath: ':memory:',
    releasesDir,
    publicBaseUrl: 'https://vigia-test.ts.net',
    googleClientId: 'cid',
    googleClientSecret: 'csec',
    adminEmails: ['updater@gmail.com'],
    oauthExchange: async () => ({
      googleSub: 'google-sub-updater',
      email: 'updater@gmail.com',
      name: 'Updater',
      picture: '',
    }),
  });
  await new Promise(resolve => vps.server.listen(0, '127.0.0.1', resolve));
  const vpsBaseUrl = `http://127.0.0.1:${vps.server.address().port}`;

  let restartedManifest = null;
  let resolveRestart;
  const restartPromise = new Promise(resolve => { resolveRestart = resolve; });

  let app;
  try {
    app = await createApplication({
      dataDirectory: dataDir,
      vpsUrl: vpsBaseUrl,
      updateTargetDirectory: targetDir,
      currentVersion: '0.11.0',
      onRestart: async (manifest) => {
        restartedManifest = manifest;
        resolveRestart();
      },
    });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${app.server.address().port}`;

    // Faz login -> dispara auto-update automaticamente
    await completeOAuthLogin(localUrl, vpsBaseUrl, 'u1');

    await restartPromise;
    assert.equal(restartedManifest.version, '0.12.0');
    assert.equal(await readFile(join(targetDir, 'update-marker.txt'), 'utf8'), 'versao-0.12.0-instalada');
    const stateAfter = await (await fetch(`${localUrl}/api/state`)).json();
    assert.equal(stateAfter.update.status, 'restarting');
  } finally {
    if (app) await app.close();
    await vps.close();
    await rm(releasesDir, { recursive: true, force: true });
    await rm(pkgSrcDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('allows GET / top-level navigation with Sec-Fetch-Site: cross-site after OAuth redirect while blocking /api/*', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vigia-nav-'));
  let app;
  const rawGet = (port, path, headers) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    app = await createApplication({ dataDirectory: dataDir });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const port = app.server.address().port;

    // Navegação GET / redirecionada após OAuth (Sec-Fetch-Site: cross-site + Sec-Fetch-Mode: navigate) deve funcionar
    const rootRes = await rawGet(port, '/', {
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate',
    });
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers['content-type'] ?? '', /text\/html/);
    assert.doesNotMatch(rootRes.headers['content-security-policy'] ?? '', /img-src[^;]*data:/);

    // Requisição cross-site para / sem sec-fetch-mode: navigate continua bloqueada
    const rootNonNav = await rawGet(port, '/', {
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'cors',
    });
    assert.equal(rootNonNav.status, 403);

    // Rotas /api/* continuam bloqueadas para cross-site mesmo com sec-fetch-mode: navigate
    const apiRes = await rawGet(port, '/api/state', {
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate',
    });
    assert.equal(apiRes.status, 403);
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('instant allowlist revocation via heartbeat stops monitoring, clears local state, and hides /api/state products', async () => {
  const vps = createVpsServer({
    dbPath: ':memory:',
    publicBaseUrl: 'https://vigia-test.ts.net',
    googleClientId: 'cid',
    googleClientSecret: 'csec',
    adminEmails: ['admin@gmail.com'],
    oauthExchange: async () => ({
      googleSub: 'sub-user-revoked',
      email: 'revogado@gmail.com',
      name: 'Revogado',
      picture: 'https://lh3.googleusercontent.com/rev.png',
    }),
  });
  vps.db.addAllowedEmail('revogado@gmail.com', { role: 'user', addedBy: 'admin@gmail.com' });
  await new Promise(resolve => vps.server.listen(0, '127.0.0.1', resolve));
  const vpsBaseUrl = `http://127.0.0.1:${vps.server.address().port}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'vigia-revoke-'));

  let adapterStopped = false;
  let app;
  try {
    app = await createApplication({
      dataDirectory: dataDir,
      vpsUrl: vpsBaseUrl,
      heartbeatIntervalMs: 80,
      adapters: {
        amazon: async ({ signal, onStatus }) => {
          onStatus('running', 'Monitorando');
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          adapterStopped = true;
        },
        ml: async () => {},
      },
    });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${app.server.address().port}`;

    await completeOAuthLogin(localUrl, vpsBaseUrl, 'rev-1');
    const s1 = await (await fetch(`${localUrl}/api/state`)).json();
    await fetch(`${localUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': s1.token },
      body: JSON.stringify({ store: 'amazon', url: 'https://www.amazon.com.br/dp/B09V3KXJPB', name: 'Item Revogado' }),
    });
    const startRes = await fetch(`${localUrl}/api/monitor/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': s1.token },
      body: '{}',
    });
    assert.equal(startRes.status, 200);
    assert.equal((await (await fetch(`${localUrl}/api/state`)).json()).running, true);

    // Admin revoga usuário na VPS -> heartbeat detecta 401, para o monitoramento e limpa dados locais
    vps.db.removeAllowedEmail('revogado@gmail.com');

    const deadline = Date.now() + 3000;
    let stateAfter;
    while (Date.now() < deadline) {
      stateAfter = await (await fetch(`${localUrl}/api/state`)).json();
      if (!stateAfter.auth.authenticated && !stateAfter.running && adapterStopped) break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(adapterStopped, true);
    assert.equal(stateAfter.running, false);
    assert.equal(stateAfter.auth.authenticated, false);
    assert.deepEqual(stateAfter.products, []);
    assert.deepEqual(stateAfter.purchases.orders, []);
    assert.equal((await fetch(`${localUrl}/api/availability-history`)).status, 401);

    // POST /api/monitor/start também bloqueia quando revogado
    const startBlocked = await fetch(`${localUrl}/api/monitor/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': s1.token },
      body: '{}',
    });
    assert.equal(startBlocked.status, 401);
  } finally {
    if (app) await app.close();
    await vps.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('account isolation (ownerUserId) wipes previous user local data when another Google account logs in', async () => {
  let activeProfile = {
    googleSub: 'sub-user-a',
    email: 'user-a@gmail.com',
    name: 'User A',
    picture: 'https://lh3.googleusercontent.com/a.png',
  };
  const vps = createVpsServer({
    dbPath: ':memory:',
    publicBaseUrl: 'https://vigia-test.ts.net',
    googleClientId: 'cid',
    googleClientSecret: 'csec',
    adminEmails: ['user-a@gmail.com', 'user-b@gmail.com'],
    oauthExchange: async () => activeProfile,
  });
  await new Promise(resolve => vps.server.listen(0, '127.0.0.1', resolve));
  const vpsBaseUrl = `http://127.0.0.1:${vps.server.address().port}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'vigia-isolation-'));

  let app;
  try {
    app = await createApplication({ dataDirectory: dataDir, vpsUrl: vpsBaseUrl, heartbeatIntervalMs: 0 });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${app.server.address().port}`;

    // Conta A entra e salva dados locais + na VPS
    await completeOAuthLogin(localUrl, vpsBaseUrl, 'code-a');
    const stateA = await (await fetch(`${localUrl}/api/state`)).json();
    await fetch(`${localUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': stateA.token },
      body: JSON.stringify({ store: 'amazon', url: 'https://www.amazon.com.br/dp/B09V3KXJPB', name: 'Segredo Conta A' }),
    });
    app.service.registry.availabilityHistory.push({ id: 'h1', productId: 'p1', at: new Date().toISOString(), product: { store: 'amazon' }, filters: {} });
    assert.equal(app.service.registry.ownerUserId, stateA.auth.user.id);

    // Simula troca direta de conta sem logout explícito (ex.: sessão expirada e Conta B entra no mesmo PC)
    await app.authClient.clearSession();
    activeProfile = {
      googleSub: 'sub-user-b',
      email: 'user-b@gmail.com',
      name: 'User B',
      picture: 'https://lh3.googleusercontent.com/b.png',
    };
    await completeOAuthLogin(localUrl, vpsBaseUrl, 'code-b');

    const stateB = await (await fetch(`${localUrl}/api/state`)).json();
    assert.equal(stateB.auth.user.email, 'user-b@gmail.com');
    assert.deepEqual(stateB.products, []);
    assert.equal(app.service.registry.availabilityHistory.length, 0);
    assert.equal(app.service.registry.ownerUserId, stateB.auth.user.id);
    // Garante que Conta B não vazou produtos da Conta A para a VPS
    const vpsDataB = vps.db.getUserData(stateB.auth.user.id);
    assert.deepEqual(vpsDataB.products, []);
  } finally {
    if (app) await app.close();
    await vps.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Login CSRF protection rejects /api/auth/callback with missing, forged, or replayed local_state', async () => {
  const vps = createVpsServer({
    dbPath: ':memory:',
    publicBaseUrl: 'https://vigia-test.ts.net',
    googleClientId: 'cid',
    googleClientSecret: 'csec',
    adminEmails: ['csrf@gmail.com'],
    oauthExchange: async () => ({
      googleSub: 'sub-csrf',
      email: 'csrf@gmail.com',
      name: 'CSRF',
      picture: '',
    }),
  });
  await new Promise(resolve => vps.server.listen(0, '127.0.0.1', resolve));
  const vpsBaseUrl = `http://127.0.0.1:${vps.server.address().port}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'vigia-csrf-'));
  let app;
  try {
    app = await createApplication({ dataDirectory: dataDir, vpsUrl: vpsBaseUrl, heartbeatIntervalMs: 0 });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${app.server.address().port}`;

    // Sem local_state
    const missing = await fetch(`${localUrl}/api/auth/callback?code=fake-code`, { redirect: 'manual' });
    assert.equal(missing.status, 400);

    // local_state forjado
    const forged = await fetch(`${localUrl}/api/auth/callback?code=fake-code&local_state=forged-value`, { redirect: 'manual' });
    assert.equal(forged.status, 400);

    // Login legítimo consome local_state -> replay do mesmo URL é rejeitado
    const usedCallbackUrl = await completeOAuthLogin(localUrl, vpsBaseUrl, 'csrf-ok');
    const replay = await fetch(usedCallbackUrl, { redirect: 'manual' });
    assert.equal(replay.status, 400);
  } finally {
    if (app) await app.close();
    await vps.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('applyRemoteUserData enforces product field whitelist and blocks mass assignment', () => {
  const fakeService = { registry: { products: [], settings: null }, settings: null };
  const changed = applyRemoteUserData(fakeService, {
    exists: true,
    products: [
      {
        id: 'valid-id-1',
        store: 'amazon',
        url: 'https://www.amazon.com.br/dp/B09V3KXJPB',
        name: 'Seguro',
        target: 150,
        quantity: 2,
        alert: true,
        auto: true,
        // Campos efêmeros / injeções proibidas:
        price: 1,
        available: true,
        imageUrl: 'https://evil.example/xss.png',
        mlConfirmation: { confirmed: { available: true } },
        amazonOffers: [{ precoNormalCentavos: 100 }],
        injectedField: 'malicious',
      },
      {
        id: '../bad-id',
        store: 'amazon',
        url: 'https://www.amazon.com.br/dp/B000000001',
        name: 'ID Invalido',
      },
    ],
  });
  assert.equal(changed, true);
  assert.equal(fakeService.registry.products.length, 1);
  const p = fakeService.registry.products[0];
  assert.equal(p.id, 'valid-id-1');
  assert.equal(p.name, 'Seguro');
  assert.equal(p.target, 150);
  assert.equal(p.quantity, 2);
  assert.equal(p.alert, true);
  assert.equal(p.auto, true);
  assert.equal(p.price, null);
  assert.equal(p.available, null);
  assert.equal(p.imageUrl, undefined);
  assert.equal(p.mlConfirmation, undefined);
  assert.equal(p.amazonOffers, undefined);
  assert.equal(p.injectedField, undefined);
});

test('offline edits persist pendingSync (0o600) and push to VPS before pulling on reconnect', async () => {
  const vps = createVpsServer({
    dbPath: ':memory:',
    publicBaseUrl: 'https://vigia-test.ts.net',
    googleClientId: 'cid',
    googleClientSecret: 'csec',
    adminEmails: ['sync@gmail.com'],
    oauthExchange: async () => ({
      googleSub: 'sub-sync',
      email: 'sync@gmail.com',
      name: 'Sync User',
      picture: '',
    }),
  });
  await new Promise(resolve => vps.server.listen(0, '127.0.0.1', resolve));
  const vpsBaseUrl = `http://127.0.0.1:${vps.server.address().port}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'vigia-pending-sync-'));

  let vpsReachable = true;
  const controlledFetch = (url, opts) => {
    if (!vpsReachable) return Promise.reject(new Error('ECONNREFUSED'));
    return fetch(url, opts);
  };

  let app;
  try {
    app = await createApplication({
      dataDirectory: dataDir,
      vpsUrl: vpsBaseUrl,
      authFetch: controlledFetch,
      heartbeatIntervalMs: 80,
    });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${app.server.address().port}`;

    await completeOAuthLogin(localUrl, vpsBaseUrl, 'sync-1');
    const st = await (await fetch(`${localUrl}/api/state`)).json();

    // Verifica permissão 0o600 do arquivo auth-session.json (POSIX)
    if (process.platform !== 'win32') {
      const sessionStat = await stat(join(dataDir, 'auth-session.json'));
      assert.equal(sessionStat.mode & 0o777, 0o600);
    }

    // VPS cai -> usuário adiciona produto offline -> pendingSync = true persistido em disco
    vpsReachable = false;
    const addRes = await fetch(`${localUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': st.token },
      body: JSON.stringify({ store: 'amazon', url: 'https://www.amazon.com.br/dp/B09V3KXJPB', name: 'Criado Offline' }),
    });
    assert.equal(addRes.status, 200);
    const savedSession = JSON.parse(await readFile(join(dataDir, 'auth-session.json'), 'utf8'));
    assert.equal(savedSession.pendingSync, true);

    // VPS volta online -> heartbeat faz pushUserData ANTES de pullUserData e preserva o produto criado offline
    vpsReachable = true;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const current = await (await fetch(`${localUrl}/api/state`)).json();
      if (!current.auth.pendingSync && !current.auth.offlineMode) break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }

    const remoteAfter = vps.db.getUserData(st.auth.user.id);
    assert.equal(remoteAfter.products.length, 1);
    assert.equal(remoteAfter.products[0].name, 'Criado Offline');
    // Garante que apenas campos da whitelist foram enviados para a VPS
    assert.equal(remoteAfter.products[0].price, undefined);
    assert.equal(remoteAfter.products[0].available, undefined);
  } finally {
    if (app) await app.close();
    await vps.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

function createTarGzWithEntry(entryName, content = 'evil') {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);
  header.write(entryName, 0, Math.min(100, Buffer.byteLength(entryName)), 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const paddedSize = Math.ceil(data.length / 512) * 512;
  const body = Buffer.alloc(paddedSize, 0);
  data.copy(body);
  const trailer = Buffer.alloc(1024, 0);
  return gzipSync(Buffer.concat([header, body, trailer]));
}

test('AutoUpdater blocks Tar Slip paths and symlinks before extraction; AuthClient enforces HTTPS', async () => {
  // Validação unitária de Tar Slip, caminhos absolutos e symlinks/hardlinks
  assert.throws(() => validateTarListing('lrwxrwxrwx user/group 0 2026-11-26 08:00 evil -> /etc/passwd'), /links simbólicos/);
  assert.throws(() => validateTarListing('hrw-r--r-- user/group 0 2026-11-26 08:00 hard link to target'), /links simbólicos/);
  assert.throws(() => validateTarListing('-rw-r--r-- user/group 10 2026-11-26 08:00 ../../escape.txt'), /Tar Slip/);
  assert.throws(() => validateTarListing('-rw-r--r--  0 0      0           6 Nov 26 17:09 ../escape.txt'), /Tar Slip/);
  assert.throws(() => validateTarListing('-rw-r--r--  0 0      0           6 26 nov 17:09 ../escape.txt'), /Tar Slip/);
  assert.throws(() => validateTarListing('-rw-r--r-- user/group 10 2026-11-26 08:00 /etc/passwd'), /caminho absoluto/);
  assert.throws(() => validateTarListing('-rw-r--r-- user/group 10 2026-11-26 08:00 C:\\Windows\\win.ini'), /caminho absoluto/);

  // AuthClient rejeita HTTP não-local
  assert.throws(() => new AuthClient({ dataDirectory: tmpdir(), vpsUrl: 'http://evil.example.com' }), /HTTPS/);
  assert.doesNotThrow(() => new AuthClient({ dataDirectory: tmpdir(), vpsUrl: 'https://vigia.example.com' }));
  assert.doesNotThrow(() => new AuthClient({ dataDirectory: tmpdir(), vpsUrl: 'http://127.0.0.1:4400' }));

  // Teste real com arquivo tar.gz malicioso via AutoUpdater (symlink em POSIX; fallback Tar Slip ../escape.txt no Windows sem privilégio)
  const releasesDir = await mkdtemp(join(tmpdir(), 'vigia-tarslip-rel-'));
  const pkgSrcDir = await mkdtemp(join(tmpdir(), 'vigia-tarslip-src-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'vigia-tarslip-tgt-'));
  const dataDir = join(targetDir, '.data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(targetDir, 'package.json'), JSON.stringify({ version: '0.11.0' }), 'utf8');
  const archiveName = 'vigia-0.13.0.tar.gz';
  const archivePath = join(releasesDir, archiveName);

  // Também garante que o gerador em memória produz um .tar.gz Tar Slip válido para tar -tvzf em qualquer SO
  const tarSlipProbePath = join(releasesDir, 'probe-tarslip.tar.gz');
  await writeFile(tarSlipProbePath, createTarGzWithEntry('../escape.txt', 'escape'));
  const probeListing = execFileSync('tar', ['-tvzf', tarSlipProbePath], { encoding: 'utf8' });
  assert.throws(() => validateTarListing(probeListing), /Tar Slip/);

  try {
    await symlink('/etc/hosts', join(pkgSrcDir, 'evil-link'));
    execFileSync('tar', ['-czf', archivePath, '-C', pkgSrcDir, '.']);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      await writeFile(archivePath, createTarGzWithEntry('../escape.txt', 'escape'));
    } else {
      throw err;
    }
  }
  const sha256 = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  await writeFile(join(releasesDir, 'latest.json'), JSON.stringify({
    version: '0.13.0',
    filename: archiveName,
    sha256,
    notes: 'Malicious',
    publishedAt: new Date().toISOString(),
  }), 'utf8');

  const vps = createVpsServer({
    dbPath: ':memory:',
    releasesDir,
    publicBaseUrl: 'https://vigia-test.ts.net',
    googleClientId: 'cid',
    googleClientSecret: 'csec',
    adminEmails: ['tarslip@gmail.com'],
    oauthExchange: async () => ({
      googleSub: 'sub-tarslip',
      email: 'tarslip@gmail.com',
      name: 'TarSlip',
      picture: '',
    }),
  });
  await new Promise(resolve => vps.server.listen(0, '127.0.0.1', resolve));
  const vpsBaseUrl = `http://127.0.0.1:${vps.server.address().port}`;
  let restarted = false;
  let app;
  try {
    app = await createApplication({
      dataDirectory: dataDir,
      vpsUrl: vpsBaseUrl,
      updateTargetDirectory: targetDir,
      currentVersion: '0.11.0',
      heartbeatIntervalMs: 0,
      onRestart: async () => { restarted = true; },
    });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${app.server.address().port}`;

    await completeOAuthLogin(localUrl, vpsBaseUrl, 'ts-1');
    const applied = await app.updater.checkAndApply();
    assert.equal(applied, false);
    assert.equal(restarted, false);
    assert.equal(app.updater.state().status, 'error');
    assert.match(app.updater.state().error, /links simbólicos|Tar Slip|segurança/i);
  } finally {
    if (app) await app.close();
    await vps.close();
    await rm(releasesDir, { recursive: true, force: true });
    await rm(pkgSrcDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});



test('desktop mode encrypts sessionToken via tokenCodec, renders HTML callback, isolates monitor profile, and handles .exe updates with SHA-256', async () => {
  const releasesDir = await mkdtemp(join(tmpdir(), 'vigia-exe-rel-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'vigia-exe-data-'));
  const installerPayload = Buffer.from('MZ-FAKE-NSIS-INSTALLER-V0.12.0');
  const installerName = 'Vigia-Setup-0.12.0.exe';
  await writeFile(join(releasesDir, installerName), installerPayload);
  const sha256 = createHash('sha256').update(installerPayload).digest('hex');
  await writeFile(join(releasesDir, 'latest.json'), JSON.stringify({
    version: '0.12.0',
    filename: installerName,
    format: 'exe',
    sha256,
    notes: 'Instalador Windows',
    publishedAt: new Date().toISOString(),
  }), 'utf8');

  const vps = createVpsServer({
    dbPath: ':memory:',
    releasesDir,
    publicBaseUrl: 'https://vigia-test.ts.net',
    googleClientId: 'cid',
    googleClientSecret: 'csec',
    adminEmails: ['desk@gmail.com'],
    oauthExchange: async () => ({
      googleSub: 'sub-desk',
      email: 'desk@gmail.com',
      name: 'Desktop User',
      picture: '',
    }),
  });
  await new Promise(resolve => vps.server.listen(0, '127.0.0.1', resolve));
  const vpsBaseUrl = `http://127.0.0.1:${vps.server.address().port}`;

  const tokenCodec = {
    encrypt: plain => Buffer.from('ENC:' + plain, 'utf8').toString('base64'),
    decrypt: cipher => {
      const text = Buffer.from(cipher, 'base64').toString('utf8');
      assert.ok(text.startsWith('ENC:'));
      return text.slice(4);
    },
  };

  let authCompletedEmail = null;
  let restartPayload = null;
  let app1, app2;
  const prevDesktopEnv = process.env.VIGIA_DESKTOP;
  try {
    process.env.VIGIA_DESKTOP = '1';
    const { chromeProfile } = await import('../server/profiles.mjs');
    const monProfile = chromeProfile('C:/unused-root', dataDir, 'ml', 'monitor');
    assert.equal(monProfile.userDataDir, join(dataDir, 'chrome-profiles', 'monitor'));

    app1 = await createApplication({
      dataDirectory: dataDir,
      vpsUrl: vpsBaseUrl,
      currentVersion: '0.11.0',
      heartbeatIntervalMs: 0,
      desktopMode: true,
      tokenCodec,
      onAuthComplete: user => { authCompletedEmail = user?.email ?? null; },
      onRestart: async payload => { restartPayload = payload; },
    });
    await new Promise(resolve => app1.server.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${app1.server.address().port}`;

    const startRes = await fetch(`${localUrl}/api/auth/start`, { redirect: 'manual' });
    const vpsStartRes = await fetch(startRes.headers.get('location'), { redirect: 'manual' });
    const googleState = new URL(vpsStartRes.headers.get('location')).searchParams.get('state');
    const vpsCbRes = await fetch(`${vpsBaseUrl}/auth/google/callback?code=desk-1&state=${encodeURIComponent(googleState)}`, { redirect: 'manual' });
    const localCbRes = await fetch(vpsCbRes.headers.get('location'), { redirect: 'manual' });
    assert.equal(localCbRes.status, 200);
    const html = await localCbRes.text();
    assert.match(html, /Login concluído/i);
    assert.equal(authCompletedEmail, 'desk@gmail.com');

    const savedOnDisk = JSON.parse(await readFile(join(dataDir, 'auth-session.json'), 'utf8'));
    assert.equal(savedOnDisk.sessionToken, undefined);
    assert.ok(typeof savedOnDisk.encryptedSessionToken === 'string' && savedOnDisk.encryptedSessionToken.length > 0);

    const applied = await app1.updater.checkAndApply();
    if (process.platform === 'win32') {
      assert.equal(applied, true);
      assert.ok(restartPayload?.installerPath?.endsWith(installerName));
      const downloaded = await readFile(restartPayload.installerPath);
      assert.deepEqual(downloaded, installerPayload);
      await rm(join(restartPayload.installerPath, '..'), { recursive: true, force: true }).catch(() => {});
    }

    await app1.close();
    app1 = null;

    app2 = await createApplication({
      dataDirectory: dataDir,
      vpsUrl: vpsBaseUrl,
      currentVersion: '0.12.0',
      heartbeatIntervalMs: 0,
      desktopMode: true,
      tokenCodec,
    });
    assert.equal(app2.authClient.authenticated, true);
    assert.equal(app2.authClient.session.user.email, 'desk@gmail.com');
  } finally {
    if (prevDesktopEnv === undefined) delete process.env.VIGIA_DESKTOP;
    else process.env.VIGIA_DESKTOP = prevDesktopEnv;
    if (app1) await app1.close();
    if (app2) await app2.close();
    await vps.close();
    await rm(releasesDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('Amazon metadata parser accepts Weblab /images/W/.../images/I/ URLs and data-src fallbacks', async () => {
  const { createMetadataParser, safeProductImage } = await import('../server/metadata.mjs');
  const { resolve } = await import('node:path');
  const projectRoot = resolve(process.cwd(), '..');

  assert.equal(
    safeProductImage('https://m.media-amazon.com/images/W/MEDIAX_792452-T2/images/I/51c9-rOytCL.jpg', 'amazon'),
    'https://m.media-amazon.com/images/W/MEDIAX_792452-T2/images/I/51c9-rOytCL.jpg'
  );
  assert.equal(
    safeProductImage('https://images-sa.ssl-images-amazon.com/images/I/41QgsVd+4JL.jpg', 'amazon'),
    'https://images-sa.ssl-images-amazon.com/images/I/41QgsVd+4JL.jpg'
  );
  assert.equal(safeProductImage('https://m.media-amazon.com/images/G/01/grey-pixel.gif', 'amazon'), null);

  const parse = createMetadataParser(projectRoot);
  const htmlLazy = `<div id="aod-pinned-offer"><div id="pinned-image-id"><img id="aod-asin-image-id" src="https://m.media-amazon.com/images/G/01/grey-pixel.gif" data-src="https://m.media-amazon.com/images/W/WEBP_123/images/I/51+Wh4ejCDL.jpg"/></div><div id="aod-asin-title"><h5>Produto Lazy</h5></div></div>`;
  const parsed = parse(htmlLazy, 'amazon');
  assert.equal(parsed.title, 'Produto Lazy');
  assert.equal(parsed.imageUrl, 'https://m.media-amazon.com/images/W/WEBP_123/images/I/51+Wh4ejCDL.jpg');
});
