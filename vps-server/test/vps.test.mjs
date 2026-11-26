import test from 'node:test';
import assert from 'node:assert/strict';
import { createVpsServer } from '../server.mjs';

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
  } finally {
    await app.close();
  }
});
