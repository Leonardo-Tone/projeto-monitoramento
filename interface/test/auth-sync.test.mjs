import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';
import { createVpsServer } from '../../vps-server/server.mjs';

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

    // 1. Antes do login, state mostra enabled=true, authenticated=false
    const stateBefore = await (await fetch(`${local1}/api/state`)).json();
    assert.equal(stateBefore.auth.enabled, true);
    assert.equal(stateBefore.auth.authenticated, false);
    assert.ok(stateBefore.auth.loginUrl.startsWith(`${vpsBaseUrl}/auth/google/start`));

    // Mutações bloqueadas antes do login
    const blockedRes = await fetch(`${local1}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vigia-Token': stateBefore.token },
      body: JSON.stringify({ store: 'amazon', url: 'https://www.amazon.com.br/dp/B09V3KXJPB' }),
    });
    assert.equal(blockedRes.status, 401);

    // 2. Simula fluxo OAuth completo (VPS -> Google -> VPS -> localhost callback)
    const startRes = await fetch(stateBefore.auth.loginUrl, { redirect: 'manual' });
    assert.equal(startRes.status, 302);
    const stateParam = new URL(startRes.headers.get('location')).searchParams.get('state');

    const vpsCbRes = await fetch(`${vpsBaseUrl}/auth/google/callback?code=g-code&state=${encodeURIComponent(stateParam)}`, {
      redirect: 'manual',
    });
    assert.equal(vpsCbRes.status, 302);
    const localCallbackUrl = vpsCbRes.headers.get('location');
    assert.ok(localCallbackUrl.startsWith(`${local1}/api/auth/callback?code=`));

    const localCbRes = await fetch(localCallbackUrl, { redirect: 'manual' });
    assert.equal(localCbRes.status, 302);
    assert.equal(localCbRes.headers.get('location'), '/');

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

    const s2 = await (await fetch(`${local2}/api/state`)).json();
    const start2 = await fetch(s2.auth.loginUrl, { redirect: 'manual' });
    const state2 = new URL(start2.headers.get('location')).searchParams.get('state');
    const vpsCb2 = await fetch(`${vpsBaseUrl}/auth/google/callback?code=g-code-2&state=${encodeURIComponent(state2)}`, {
      redirect: 'manual',
    });
    const localCb2 = await fetch(vpsCb2.headers.get('location'), { redirect: 'manual' });
    assert.equal(localCb2.status, 302);

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

    const s0 = await (await fetch(`${localUrl}/api/state`)).json();
    const startRes = await fetch(s0.auth.loginUrl, { redirect: 'manual' });
    const stateParam = new URL(startRes.headers.get('location')).searchParams.get('state');
    const vpsCb = await fetch(`${vpsBaseUrl}/auth/google/callback?code=c1&state=${encodeURIComponent(stateParam)}`, { redirect: 'manual' });
    await fetch(vpsCb.headers.get('location'), { redirect: 'manual' });

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

    // 4. 8 dias depois da última verificação online -> bloqueado!
    currentTime += 5 * DAY;
    app = await createApplication({ dataDirectory: dataDir, vpsUrl: vpsBaseUrl, authNow: now });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const localExpired = `http://127.0.0.1:${app.server.address().port}`;

    const sExpired = await (await fetch(`${localExpired}/api/state`)).json();
    assert.equal(sExpired.auth.authenticated, false);
    assert.equal(sExpired.auth.offlineExpired, true);
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
    const s0 = await (await fetch(`${localUrl}/api/state`)).json();
    const startRes = await fetch(s0.auth.loginUrl, { redirect: 'manual' });
    const stateParam = new URL(startRes.headers.get('location')).searchParams.get('state');
    const vpsCb = await fetch(`${vpsBaseUrl}/auth/google/callback?code=u1&state=${encodeURIComponent(stateParam)}`, { redirect: 'manual' });
    await fetch(vpsCb.headers.get('location'), { redirect: 'manual' });

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

