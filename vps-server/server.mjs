import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from './env.mjs';
import { openDatabase, normalizeEmail } from './db.mjs';
import { generatePkce, buildGoogleAuthUrl, exchangeGoogleCode } from './oauth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHtmlPage({ title, heading, message, status = 'info' }) {
  const accent = status === 'error' ? '#c0392b' : '#1f7a4c';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #f4f3ef; color: #1d1c1a; display: grid; place-items: center; min-height: 100vh; padding: 24px; }
    .card { background: #fff; border: 1px solid #e2dfd7; border-radius: 14px; max-width: 440px; width: 100%; padding: 28px; box-shadow: 0 10px 30px rgba(0,0,0,0.06); }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: ${accent}18; color: ${accent}; margin-bottom: 12px; }
    h1 { margin: 0 0 10px; font-size: 20px; }
    p { margin: 0; line-height: 1.5; color: #52504a; font-size: 14px; }
  </style>
</head>
<body>
  <main class="card">
    <span class="badge">Vigia · Autenticação</span>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

export function isValidLocalCallback(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/api/auth/callback') {
      return false;
    }
    if (parsed.username || parsed.password || parsed.hash) return false;
    if (!parsed.port || !/^\d+$/.test(parsed.port)) return false;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port >= 1024 && port <= 65535;
  } catch {
    return false;
  }
}

function safeDecodeParam(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    const err = new Error('Parâmetro de URL inválido.');
    err.status = 400;
    throw err;
  }
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) {
      const err = new Error('Corpo da requisição muito grande.');
      err.status = 413;
      throw err;
    }
  }
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('JSON inválido.');
      err.status = 400;
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err.status) throw err;
    const e = new Error('JSON inválido.');
    e.status = 400;
    throw e;
  }
}

function extractBearerToken(req) {
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export function createVpsServer({
  dbPath = join(__dirname, 'data', 'vigia-vps.sqlite'),
  releasesDir = process.env.RELEASES_DIR ? resolve(__dirname, process.env.RELEASES_DIR) : join(__dirname, 'releases'),
  publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:4400',
  googleClientId = process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '',
  adminEmails = (process.env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  sessionTtlDays = Number(process.env.SESSION_TTL_DAYS ?? 30) || 30,
  oauthExchange = exchangeGoogleCode,
  rateLimit = {},
} = {}) {
  const normalizedBaseUrl = publicBaseUrl.replace(/\/+$/, '');
  const redirectUri = `${normalizedBaseUrl}/auth/google/callback`;
  const db = openDatabase(dbPath);
  db.seedAdmins(adminEmails);

  const rateLimitEnabled = rateLimit.enabled ?? true;
  const rateLimitWindowMs = rateLimit.windowMs ?? 60_000;
  const rateLimitAuthMax = rateLimit.authMax ?? 30;
  const rateLimitApiMax = rateLimit.apiMax ?? 120;
  const rateBuckets = new Map();

  const checkRateLimit = (req, pathname) => {
    if (!rateLimitEnabled) return { allowed: true };
    const isAuthPath = pathname.startsWith('/auth/') || pathname === '/api/auth/exchange';
    const isApiPath = pathname.startsWith('/api/');
    if (!isAuthPath && !isApiPath) return { allowed: true };
    const bucketGroup = isAuthPath ? 'auth' : 'api';
    const max = isAuthPath ? rateLimitAuthMax : rateLimitApiMax;
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    const ip = forwarded || req.socket?.remoteAddress || 'unknown';
    const key = `${bucketGroup}:${ip}`;
    const now = Date.now();
    if (rateBuckets.size > 1000) {
      for (const [k, entry] of rateBuckets) {
        if (entry.resetAt <= now) rateBuckets.delete(k);
      }
    }
    const existing = rateBuckets.get(key);
    if (!existing || existing.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
      return { allowed: true };
    }
    existing.count += 1;
    if (existing.count > max) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      return { allowed: false, retryAfter };
    }
    return { allowed: true };
  };

  const server = createServer(async (req, res) => {
    const sendJson = (status, data, extraHeaders = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders,
      });
      res.end(JSON.stringify(data));
    };

    const sendHtml = (status, html) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      });
      res.end(html);
    };

    try {
      const url = new URL(req.url, normalizedBaseUrl);
      const limitCheck = checkRateLimit(req, url.pathname);
      if (!limitCheck.allowed) {
        return sendJson(429, { error: 'Muitas requisições. Tente novamente em instantes.' }, { 'Retry-After': String(limitCheck.retryAfter) });
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(200, { ok: true, service: 'vigia-vps', oauthConfigured: Boolean(googleClientId && googleClientSecret) });
      }

      if (req.method === 'GET' && url.pathname === '/auth/google/start') {
        if (!googleClientId || !googleClientSecret) {
          return sendHtml(500, renderHtmlPage({
            title: 'Vigia · Configuração pendente',
            heading: 'Google OAuth não configurado',
            message: 'O login Google ainda não está configurado neste servidor.',
            status: 'error',
          }));
        }
        const callbackUrl = url.searchParams.get('callback') ?? '';
        if (!isValidLocalCallback(callbackUrl)) {
          return sendHtml(400, renderHtmlPage({
            title: 'Vigia · Callback inválido',
            heading: 'Endereço de retorno inválido',
            message: 'O login deve ser iniciado a partir do painel local do Vigia.',
            status: 'error',
          }));
        }
        const { codeVerifier, codeChallenge } = generatePkce();
        const state = db.createOAuthState({ codeVerifier, callbackUrl });
        const googleUrl = buildGoogleAuthUrl({
          clientId: googleClientId,
          redirectUri,
          state,
          codeChallenge,
        });
        res.writeHead(302, { Location: googleUrl, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          return sendHtml(400, renderHtmlPage({
            title: 'Vigia · Login cancelado',
            heading: 'Login não concluído',
            message: `O Google retornou: ${oauthError}. Você pode fechar esta aba e tentar novamente pelo Vigia.`,
            status: 'error',
          }));
        }
        const code = url.searchParams.get('code') ?? '';
        const state = url.searchParams.get('state') ?? '';
        if (!code || !state) {
          return sendHtml(400, renderHtmlPage({
            title: 'Vigia · Erro no login',
            heading: 'Parâmetros ausentes',
            message: 'A resposta do Google não contém os parâmetros esperados.',
            status: 'error',
          }));
        }

        const oauthState = db.consumeOAuthState(state);
        if (!oauthState) {
          return sendHtml(400, renderHtmlPage({
            title: 'Vigia · Sessão expirada',
            heading: 'Tentativa de login expirada',
            message: 'Inicie o login novamente a partir do painel do Vigia.',
            status: 'error',
          }));
        }

        let profile;
        try {
          profile = await oauthExchange({
            code,
            codeVerifier: oauthState.codeVerifier,
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            redirectUri,
          });
        } catch (err) {
          console.error('[vps] Falha na troca OAuth com o Google:', err);
          return sendHtml(502, renderHtmlPage({
            title: 'Vigia · Erro ao validar conta',
            heading: 'Não foi possível validar sua conta Google',
            message: 'Ocorreu um erro temporário ao validar sua conta Google. Tente novamente em instantes.',
            status: 'error',
          }));
        }

        const allowed = db.getAllowedEmail(profile.email);
        if (!allowed) {
          return sendHtml(403, renderHtmlPage({
            title: 'Vigia · Acesso não autorizado',
            heading: 'Acesso não autorizado',
            message: `O e-mail ${profile.email} não está na lista de contas autorizadas deste servidor Vigia. Peça ao administrador para liberar o acesso.`,
            status: 'error',
          }));
        }

        const user = db.upsertUser({
          googleSub: profile.googleSub,
          email: profile.email,
          name: profile.name,
          picture: profile.picture,
          role: allowed.role,
        });

        const authCode = db.createAuthCode(user.id);
        const target = new URL(oauthState.callbackUrl);
        target.searchParams.set('code', authCode);
        res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/exchange') {
        const body = await readJsonBody(req, 16384);
        const code = String(body.code ?? '').trim();
        if (!code) return sendJson(400, { error: 'Código de autenticação ausente.' });
        const userId = db.consumeAuthCode(code);
        if (!userId) return sendJson(401, { error: 'Código inválido ou expirado.' });
        const user = db.getUserById(userId);
        if (!user || !db.getAllowedEmail(user.email)) {
          return sendJson(403, { error: 'Conta não autorizada.' });
        }
        const session = db.createSession(user.id, {
          ttlDays: sessionTtlDays,
          deviceLabel: String(body.deviceLabel ?? ''),
        });
        return sendJson(200, {
          sessionToken: session.token,
          expiresAt: session.expiresAt,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            picture: user.picture,
            role: user.role,
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const token = extractBearerToken(req);
        if (token) db.revokeSession(token);
        return sendJson(200, { ok: true });
      }

      // Rotas autenticadas
      if (url.pathname.startsWith('/api/')) {
        const token = extractBearerToken(req);
        const session = db.validateSession(token);
        if (!session) {
          return sendJson(401, { error: 'Sessão inválida ou expirada. Faça login novamente.' });
        }

        if (req.method === 'GET' && url.pathname === '/api/me') {
          return sendJson(200, { user: session.user });
        }

        if (req.method === 'GET' && url.pathname === '/api/user/data') {
          const data = db.getUserData(session.user.id);
          return sendJson(200, data);
        }

        if (req.method === 'PUT' && url.pathname === '/api/user/data') {
          const body = await readJsonBody(req, 2 * 1024 * 1024);
          if (!Array.isArray(body.products)) {
            return sendJson(400, { error: 'O campo products deve ser uma lista.' });
          }
          if (body.products.length > 100) {
            return sendJson(400, { error: 'O limite máximo é de 100 produtos por conta.' });
          }
          if (body.settings !== null && body.settings !== undefined && (typeof body.settings !== 'object' || Array.isArray(body.settings))) {
            return sendJson(400, { error: 'O campo settings deve ser um objeto.' });
          }
          const saved = db.saveUserData(session.user.id, {
            products: body.products,
            settings: body.settings ?? {},
          });
          return sendJson(200, { ok: true, ...saved });
        }

        if (req.method === 'GET' && url.pathname === '/api/updates/latest') {
          try {
            const manifest = JSON.parse(readFileSync(join(releasesDir, 'latest.json'), 'utf8'));
            if (!manifest?.version || !manifest?.filename || !manifest?.sha256) {
              return sendJson(200, { available: false });
            }
            return sendJson(200, { available: true, ...manifest });
          } catch (err) {
            if (err.code === 'ENOENT') return sendJson(200, { available: false });
            throw err;
          }
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/updates/download/')) {
          const requested = safeDecodeParam(url.pathname.slice('/api/updates/download/'.length));
          const safeName = basename(requested);
          if (!safeName || safeName !== requested || !/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(safeName)) {
            return sendJson(400, { error: 'Nome de arquivo de atualização inválido.' });
          }
          const filePath = join(releasesDir, safeName);
          let fileStat;
          try {
            fileStat = statSync(filePath);
          } catch (err) {
            if (err.code === 'ENOENT') return sendJson(404, { error: 'Pacote de atualização não encontrado.' });
            throw err;
          }
          res.writeHead(200, {
            'Content-Type': 'application/gzip',
            'Content-Length': String(fileStat.size),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          const stream = createReadStream(filePath);
          stream.on('error', err => {
            console.error('[vps] Erro ao ler pacote de atualização:', err);
            if (!res.headersSent) {
              sendJson(500, { error: 'Erro interno do servidor.' });
            } else {
              res.destroy();
            }
          });
          stream.pipe(res);
          return;
        }

        // Rotas de administrador
        if (url.pathname.startsWith('/api/admin/')) {
          if (session.user.role !== 'admin') {
            return sendJson(403, { error: 'Acesso restrito a administradores.' });
          }

          if (req.method === 'GET' && url.pathname === '/api/admin/allowlist') {
            return sendJson(200, { entries: db.listAllowedEmails() });
          }

          if (req.method === 'POST' && url.pathname === '/api/admin/allowlist') {
            const body = await readJsonBody(req, 16384);
            let entry;
            try {
              entry = db.addAllowedEmail(body.email, {
                role: body.role === 'admin' ? 'admin' : 'user',
                note: body.note ?? '',
                addedBy: session.user.email,
              });
            } catch (err) {
              return sendJson(400, { error: err.message });
            }
            return sendJson(200, { ok: true, entry, entries: db.listAllowedEmails() });
          }

          if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/allowlist/')) {
            const targetEmail = normalizeEmail(safeDecodeParam(url.pathname.slice('/api/admin/allowlist/'.length)));
            if (targetEmail === session.user.email) {
              return sendJson(400, { error: 'Você não pode remover o próprio acesso de administrador.' });
            }
            const removed = db.removeAllowedEmail(targetEmail);
            if (!removed) return sendJson(404, { error: 'E-mail não encontrado na lista.' });
            return sendJson(200, { ok: true, entries: db.listAllowedEmails() });
          }
        }
      }

      return sendJson(404, { error: 'Rota não encontrada.' });
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) {
        console.error('[vps] Erro interno na requisição:', err);
      }
      if (!res.headersSent) {
        sendJson(status, { error: status >= 500 ? 'Erro interno do servidor.' : (err.message || 'Requisição inválida.') });
      } else {
        res.end();
      }
    }
  });

  server.requestTimeout = 30000;

  return {
    server,
    db,
    async close() {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise(resolveClose => server.close(resolveClose));
      }
      db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadEnvFile(join(__dirname, '.env'));
  const port = Number(process.env.PORT ?? 4400);
  const host = process.env.HOST ?? '127.0.0.1';
  const dbPath = process.env.DB_PATH ? resolve(__dirname, process.env.DB_PATH) : join(__dirname, 'data', 'vigia-vps.sqlite');
  const app = createVpsServer({ dbPath });
  app.server.listen(port, host, () => {
    console.log(`Vigia VPS rodando em http://${host}:${port}`);
    console.log(`URL pública configurada: ${process.env.PUBLIC_BASE_URL ?? '(não definida)'}`);
    console.log(`Banco SQLite: ${dbPath}`);
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
