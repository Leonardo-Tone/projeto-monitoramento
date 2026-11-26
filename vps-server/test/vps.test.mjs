import test from 'node:test';
import assert from 'node:assert/strict';
import { createVpsServer, isValidLocalCallback } from '../server.mjs';
import { exchangeGoogleCode } from '../oauth.mjs';

async function startTestVps(options = {}) {
  const app = createVpsServer({
    dbPath: ':memory:',
    publicBaseUrl: 'https://vigia-test.ts.net',
    googleClientId: 'test-client-id',
    googleClientSecret: 'test-client-secret',
    adminEmails: ['admin@gmail.com'],
    ...options,
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  return { app, baseUrl };
}

test('full Google OAuth + allowlist + user data sync + admin flow', async () => {
  let mockProfile = {
    googleSub: 'sub-admin-1',
    email: 'admin@gmail.com',
    name: 'Admin Vigia',
    picture: 'https://lh3.googleusercontent.com/admin.png',
  };

  const { app, baseUrl } = await startTestVps({
    oauthExchange: async () => mockProfile,
  });

  try {
    // 1. Inicia OAuth com callback local válido
    const startRes = await fetch(`${baseUrl}/auth/google/start?callback=${encodeURIComponent('http://127.0.0.1:4318/api/auth/callback')}`, {
      redirect: 'manual',
    });
    assert.equal(startRes.status, 302);
    const googleUrl = new URL(startRes.headers.get('location'));
    assert.equal(googleUrl.origin, 'https://accounts.google.com');
    assert.equal(googleUrl.searchParams.get('redirect_uri'), 'https://vigia-test.ts.net/auth/google/callback');
    const state = googleUrl.searchParams.get('state');
    assert.ok(state);

    // 2. Callback do Google para admin autorizado -> redireciona para localhost com code
    const cbRes = await fetch(`${baseUrl}/auth/google/callback?code=google-code-1&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });
    assert.equal(cbRes.status, 302);
    const localRedirect = new URL(cbRes.headers.get('location'));
    assert.equal(localRedirect.origin, 'http://127.0.0.1:4318');
    assert.equal(localRedirect.pathname, '/api/auth/callback');
    const authCode = localRedirect.searchParams.get('code');
    assert.ok(authCode);

    // 3. Troca auth_code por sessionToken
    const exchangeRes = await fetch(`${baseUrl}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: authCode, deviceLabel: 'PC-Principal' }),
    });
    assert.equal(exchangeRes.status, 200);
    const exchanged = await exchangeRes.json();
    assert.ok(exchanged.sessionToken);
    assert.equal(exchanged.user.email, 'admin@gmail.com');
    assert.equal(exchanged.user.role, 'admin');

    const authHeaders = {
      Authorization: `Bearer ${exchanged.sessionToken}`,
      'Content-Type': 'application/json',
    };

    // 4. Salva e recupera produtos + configurações do usuário
    const putRes = await fetch(`${baseUrl}/api/user/data`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        products: [{ id: 'p1', store: 'amazon', code: 'B0001', name: 'Produto Teste' }],
        settings: { amazonOnly: true },
      }),
    });
    assert.equal(putRes.status, 200);
    const putData = await putRes.json();
    assert.equal(putData.version, 1);

    const getRes = await fetch(`${baseUrl}/api/user/data`, { headers: authHeaders });
    assert.equal(getRes.status, 200);
    const userData = await getRes.json();
    assert.equal(userData.exists, true);
    assert.equal(userData.products.length, 1);
    assert.equal(userData.products[0].code, 'B0001');
    assert.equal(userData.settings.amazonOnly, true);

    // 5. E-mail fora da allowlist é bloqueado com 403
    mockProfile = {
      googleSub: 'sub-stranger',
      email: 'intruso@gmail.com',
      name: 'Intruso',
      picture: '',
    };
    const start2 = await fetch(`${baseUrl}/auth/google/start?callback=${encodeURIComponent('http://127.0.0.1:4318/api/auth/callback')}`, {
      redirect: 'manual',
    });
    const state2 = new URL(start2.headers.get('location')).searchParams.get('state');
    const cb2 = await fetch(`${baseUrl}/auth/google/callback?code=g2&state=${encodeURIComponent(state2)}`, {
      redirect: 'manual',
    });
    assert.equal(cb2.status, 403);

    // 6. Admin libera o e-mail via API -> agora consegue logar
    const addRes = await fetch(`${baseUrl}/api/admin/allowlist`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ email: 'intruso@gmail.com', role: 'user', note: 'Amigo' }),
    });
    assert.equal(addRes.status, 200);

    const start3 = await fetch(`${baseUrl}/auth/google/start?callback=${encodeURIComponent('http://127.0.0.1:4318/api/auth/callback')}`, {
      redirect: 'manual',
    });
    const state3 = new URL(start3.headers.get('location')).searchParams.get('state');
    const cb3 = await fetch(`${baseUrl}/auth/google/callback?code=g3&state=${encodeURIComponent(state3)}`, {
      redirect: 'manual',
    });
    assert.equal(cb3.status, 302);
    const code3 = new URL(cb3.headers.get('location')).searchParams.get('code');
    const ex3 = await (await fetch(`${baseUrl}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code3 }),
    })).json();
    assert.equal(ex3.user.role, 'user');

    // 7. Usuário comum não acessa rotas de admin
    const forbiddenAdmin = await fetch(`${baseUrl}/api/admin/allowlist`, {
      headers: { Authorization: `Bearer ${ex3.sessionToken}` },
    });
    assert.equal(forbiddenAdmin.status, 403);

    // 8. Admin remove usuário -> sessão dele é revogada imediatamente
    const delRes = await fetch(`${baseUrl}/api/admin/allowlist/${encodeURIComponent('intruso@gmail.com')}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    assert.equal(delRes.status, 200);

    const meAfterRevoke = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${ex3.sessionToken}` },
    });
    assert.equal(meAfterRevoke.status, 401);
  } finally {
    await app.close();
  }
});

test('rejects non-localhost callback URLs to prevent open redirects', async () => {
  const { app, baseUrl } = await startTestVps();
  try {
    const res = await fetch(`${baseUrl}/auth/google/start?callback=${encodeURIComponent('https://evil.com/api/auth/callback')}`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  } finally {
    await app.close();
  }
});

test('isValidLocalCallback enforces strict port range, no credentials, no hash, and allows local_state query', () => {
  assert.equal(isValidLocalCallback('http://127.0.0.1:4318/api/auth/callback'), true);
  assert.equal(isValidLocalCallback('http://127.0.0.1:4318/api/auth/callback?local_state=abc123'), true);
  assert.equal(isValidLocalCallback('http://127.0.0.1:1024/api/auth/callback'), true);
  assert.equal(isValidLocalCallback('http://127.0.0.1:65535/api/auth/callback'), true);
  // Inválidos
  assert.equal(isValidLocalCallback('http://127.0.0.1/api/auth/callback'), false);
  assert.equal(isValidLocalCallback('http://127.0.0.1:80/api/auth/callback'), false);
  assert.equal(isValidLocalCallback('http://127.0.0.1:1023/api/auth/callback'), false);
  assert.equal(isValidLocalCallback('http://user:pass@127.0.0.1:4318/api/auth/callback'), false);
  assert.equal(isValidLocalCallback('http://127.0.0.1:4318/api/auth/callback#frag'), false);
  assert.equal(isValidLocalCallback('https://127.0.0.1:4318/api/auth/callback'), false);
  assert.equal(isValidLocalCallback('http://localhost:4318/api/auth/callback'), false);
});

test('rate limiting returns 429 on /auth/* and /api/* when request threshold is exceeded', async () => {
  const { app, baseUrl } = await startTestVps({
    rateLimit: { authMax: 3, apiMax: 4, windowMs: 60_000 },
  });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/auth/google/start?callback=${encodeURIComponent('http://127.0.0.1:4318/api/auth/callback')}`, {
        redirect: 'manual',
        headers: { 'X-Forwarded-For': '203.0.113.10' },
      });
      assert.equal(res.status, 302);
    }
    const authLimited = await fetch(`${baseUrl}/auth/google/start?callback=${encodeURIComponent('http://127.0.0.1:4318/api/auth/callback')}`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-For': '203.0.113.10' },
    });
    assert.equal(authLimited.status, 429);
    assert.ok(Number(authLimited.headers.get('retry-after')) >= 1);

    // Outro IP continua liberado
    const otherIp = await fetch(`${baseUrl}/auth/google/start?callback=${encodeURIComponent('http://127.0.0.1:4318/api/auth/callback')}`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-For': '203.0.113.11' },
    });
    assert.equal(otherIp.status, 302);

    // Rate limit em /api/*
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${baseUrl}/api/me`, { headers: { 'X-Forwarded-For': '203.0.113.20' } });
      assert.equal(res.status, 401);
    }
    const apiLimited = await fetch(`${baseUrl}/api/me`, { headers: { 'X-Forwarded-For': '203.0.113.20' } });
    assert.equal(apiLimited.status, 429);
  } finally {
    await app.close();
  }
});

test('handles malformed decodeURIComponent (400), rejects > 100 products (400), hides 502 OAuth internals, and sanitizes Google picture URL', async () => {
  const { app, baseUrl } = await startTestVps({
    oauthExchange: async ({ code }) => {
      if (code === 'fail-google') throw new Error('RAW_SECRET_OAUTH_BODY_SHOULD_NOT_LEAK');
      return {
        googleSub: 'sub-admin-2',
        email: 'admin@gmail.com',
        name: 'Admin',
        picture: 'https://lh3.googleusercontent.com/ok.png',
      };
    },
  });
  try {
    // 502 genérico sem vazar erro interno do Google OAuth
    const startFail = await fetch(`${baseUrl}/auth/google/start?callback=${encodeURIComponent('http://127.0.0.1:4318/api/auth/callback')}`, { redirect: 'manual' });
    const stateFail = new URL(startFail.headers.get('location')).searchParams.get('state');
    const cbFail = await fetch(`${baseUrl}/auth/google/callback?code=fail-google&state=${encodeURIComponent(stateFail)}`, { redirect: 'manual' });
    assert.equal(cbFail.status, 502);
    const cbFailBody = await cbFail.text();
    assert.doesNotMatch(cbFailBody, /RAW_SECRET_OAUTH_BODY_SHOULD_NOT_LEAK/);

    // Autentica como admin
    const startOk = await fetch(`${baseUrl}/auth/google/start?callback=${encodeURIComponent('http://127.0.0.1:4318/api/auth/callback')}`, { redirect: 'manual' });
    const stateOk = new URL(startOk.headers.get('location')).searchParams.get('state');
    const cbOk = await fetch(`${baseUrl}/auth/google/callback?code=ok&state=${encodeURIComponent(stateOk)}`, { redirect: 'manual' });
    const authCode = new URL(cbOk.headers.get('location')).searchParams.get('code');
    const ex = await (await fetch(`${baseUrl}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: authCode }),
    })).json();
    const authHeaders = { Authorization: `Bearer ${ex.sessionToken}`, 'Content-Type': 'application/json' };

    // decodeURIComponent malformado retorna 400
    const badDownload = await fetch(`${baseUrl}/api/updates/download/%E0%A4%A`, { headers: authHeaders });
    assert.equal(badDownload.status, 400);
    const badDelete = await fetch(`${baseUrl}/api/admin/allowlist/%E0%A4%A`, { method: 'DELETE', headers: authHeaders });
    assert.equal(badDelete.status, 400);

    // Mais de 100 produtos retorna 400
    const tooManyProducts = Array.from({ length: 101 }, (_, i) => ({ id: `p${i}`, store: 'amazon' }));
    const putTooMany = await fetch(`${baseUrl}/api/user/data`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ products: tooManyProducts, settings: {} }),
    });
    assert.equal(putTooMany.status, 400);

    // Validação de picture em oauth.mjs
    const badPicProfile = await exchangeGoogleCode({
      code: 'c', codeVerifier: 'v', clientId: 'id', clientSecret: 'sec', redirectUri: 'https://x/cb',
      fetchImpl: async url => ({
        ok: true,
        json: async () => url.includes('token')
          ? { access_token: 'tok' }
          : { sub: '123', email: 'a@gmail.com', email_verified: true, name: 'A', picture: 'https://evil.example/pic.png' },
      }),
    });
    assert.equal(badPicProfile.picture, '');

    const goodPicProfile = await exchangeGoogleCode({
      code: 'c', codeVerifier: 'v', clientId: 'id', clientSecret: 'sec', redirectUri: 'https://x/cb',
      fetchImpl: async url => ({
        ok: true,
        json: async () => url.includes('token')
          ? { access_token: 'tok' }
          : { sub: '123', email: 'a@gmail.com', email_verified: true, name: 'A', picture: 'https://lh3.googleusercontent.com/a/avatar=s96-c' },
      }),
    });
    assert.equal(goodPicProfile.picture, 'https://lh3.googleusercontent.com/a/avatar=s96-c');
  } finally {
    await app.close();
  }
});


test('serves authenticated .exe update packages with application/octet-stream', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const relDir = await mkdtemp(join(tmpdir(), 'vigia-vps-exe-'));
  const exeName = 'Vigia-Setup-0.12.0.exe';
  const exeBytes = Buffer.from('MZ-TEST-EXE-PAYLOAD');
  await writeFile(join(relDir, exeName), exeBytes);
  const { app, baseUrl } = await startTestVps({
    releasesDir: relDir,
    oauthExchange: async () => ({ googleSub: 'sub-exe', email: 'admin@gmail.com', name: 'Admin', picture: '' }),
  });
  try {
    const s1 = await fetch(`${baseUrl}/auth/google/start?callback=${encodeURIComponent('http://127.0.0.1:4318/api/auth/callback')}`, { redirect: 'manual' });
    const st1 = new URL(s1.headers.get('location')).searchParams.get('state');
    const c1 = await fetch(`${baseUrl}/auth/google/callback?code=ok&state=${encodeURIComponent(st1)}`, { redirect: 'manual' });
    const ac1 = new URL(c1.headers.get('location')).searchParams.get('code');
    const ex1 = await (await fetch(`${baseUrl}/api/auth/exchange`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: ac1 }),
    })).json();
    const dlRes = await fetch(`${baseUrl}/api/updates/download/${exeName}`, {
      headers: { Authorization: `Bearer ${ex1.sessionToken}` },
    });
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await dlRes.arrayBuffer()), exeBytes);
  } finally {
    await app.close();
    await rm(relDir, { recursive: true, force: true });
  }
});
