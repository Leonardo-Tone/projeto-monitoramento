import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';

export function loadLocalEnv(filePath) {
  let content;
  try {
    content = readFileSync(resolve(filePath), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export class AuthClient {
  constructor({ dataDirectory, vpsUrl = '', fetchImpl = fetch, now = () => Date.now(), offlineGraceMs = OFFLINE_GRACE_MS, onSessionRevoked = null } = {}) {
    this.dataDirectory = dataDirectory;
    this.sessionFile = join(dataDirectory, 'auth-session.json');
    const normalizedVpsUrl = String(vpsUrl ?? '').trim().replace(/\/+$/, '');
    if (normalizedVpsUrl) {
      let parsed;
      try {
        parsed = new URL(normalizedVpsUrl);
      } catch {
        throw new Error('URL do servidor VPS inválida.');
      }
      const isLocalHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !isLocalHttp) {
        throw new Error('A URL do servidor VPS deve usar HTTPS.');
      }
    }
    this.vpsUrl = normalizedVpsUrl;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.offlineGraceMs = offlineGraceMs;
    this.onSessionRevoked = onSessionRevoked;
    this.session = null;
    this.offlineMode = false;
    this.offlineExpired = false;
    this.pendingSync = false;
    this.syncStatus = 'idle';
    this.lastSyncedAt = null;
    this.lastSyncError = null;
  }

  get enabled() {
    return Boolean(this.vpsUrl);
  }

  get authenticated() {
    if (!this.session?.sessionToken || !this.session?.user) return false;
    if (this.offlineMode && !this.isWithinOfflineGrace()) return false;
    return true;
  }

  isWithinOfflineGrace() {
    const verifiedAt = Date.parse(this.session?.lastVerifiedAt ?? '');
    if (Number.isNaN(verifiedAt)) return false;
    return (this.now() - verifiedAt) < this.offlineGraceMs;
  }

  offlineDaysRemaining() {
    const verifiedAt = Date.parse(this.session?.lastVerifiedAt ?? '');
    if (Number.isNaN(verifiedAt)) return 0;
    const remainingMs = Math.max(0, this.offlineGraceMs - (this.now() - verifiedAt));
    return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  }

  async init() {
    if (!this.enabled) return;
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.sessionFile, 'utf8'));
      if (raw?.sessionToken && raw?.user?.email) {
        this.session = raw;
        this.pendingSync = Boolean(raw.pendingSync);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.session = null;
      }
    }
    if (this.session) {
      await this.verifySession().catch(() => {});
    }
  }

  state(localOrigin = '') {
    return {
      enabled: this.enabled,
      authenticated: this.authenticated,
      offlineMode: this.offlineMode && this.authenticated,
      offlineExpired: this.offlineExpired,
      offlineDaysRemaining: this.offlineMode && this.authenticated ? this.offlineDaysRemaining() : null,
      lastVerifiedAt: this.session?.lastVerifiedAt ?? null,
      pendingSync: this.pendingSync,
      user: this.authenticated ? (this.session?.user ?? null) : null,
      loginUrl: this.enabled ? '/api/auth/start' : null,
      syncStatus: this.syncStatus,
      lastSyncedAt: this.lastSyncedAt,
      lastSyncError: this.lastSyncError,
    };
  }

  async saveSession(session) {
    const persisted = { ...session, pendingSync: Boolean(session.pendingSync ?? this.pendingSync) };
    this.session = persisted;
    this.pendingSync = persisted.pendingSync;
    await mkdir(this.dataDirectory, { recursive: true });
    await writeFile(this.sessionFile, JSON.stringify(persisted, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  async clearSession() {
    this.session = null;
    this.offlineMode = false;
    this.offlineExpired = false;
    this.pendingSync = false;
    this.syncStatus = 'idle';
    this.lastSyncError = null;
    await unlink(this.sessionFile).catch(err => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  async handleRevoked({ offlineExpired = false } = {}) {
    await this.clearSession();
    if (offlineExpired) {
      this.offlineExpired = true;
      this.syncStatus = 'error';
      this.lastSyncError = 'Mais de 7 dias sem conexão com o servidor VPS. Conecte-se para renovar o acesso.';
    }
    await this.onSessionRevoked?.();
  }

  async request(path, { method = 'GET', body, auth = true } = {}) {
    if (!this.enabled) throw new Error('Servidor VPS não configurado.');
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      if (!this.session?.sessionToken) {
        const err = new Error('Sessão não autenticada.');
        err.status = 401;
        throw err;
      }
      headers.Authorization = `Bearer ${this.session.sessionToken}`;
    }
    let res;
    try {
      res = await this.fetchImpl(`${this.vpsUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
    } catch (networkErr) {
      const timedOut = networkErr?.name === 'TimeoutError' || networkErr?.name === 'AbortError';
      const err = new Error(timedOut ? 'Tempo limite ao conectar ao servidor VPS.' : `Servidor VPS inacessível: ${networkErr.message}`);
      err.networkError = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && auth) {
        await this.handleRevoked();
      }
      const err = new Error(data.error || `Erro HTTP ${res.status} no servidor VPS.`);
      err.status = res.status;
      if (res.status >= 500) err.networkError = true;
      throw err;
    }
    this.offlineMode = false;
    this.offlineExpired = false;
    return data;
  }

  async completeCallback(code) {
    const data = await this.request('/api/auth/exchange', {
      method: 'POST',
      auth: false,
      body: { code, deviceLabel: hostname() },
    });
    const nowIso = new Date(this.now()).toISOString();
    await this.saveSession({
      sessionToken: data.sessionToken,
      expiresAt: data.expiresAt,
      user: data.user,
      lastVerifiedAt: nowIso,
      pendingSync: false,
    });
    this.offlineMode = false;
    this.offlineExpired = false;
    return data.user;
  }

  async verifySession() {
    if (!this.session?.sessionToken) return null;
    try {
      const data = await this.request('/api/me');
      if (data.user) {
        await this.saveSession({
          ...this.session,
          user: data.user,
          lastVerifiedAt: new Date(this.now()).toISOString(),
        });
      }
      this.offlineMode = false;
      this.offlineExpired = false;
      return data.user;
    } catch (err) {
      if (err.networkError) {
        if (this.isWithinOfflineGrace()) {
          this.offlineMode = true;
          this.offlineExpired = false;
          this.syncStatus = 'offline';
          this.lastSyncError = 'VPS fora do ar · usando dados salvos localmente';
          return this.session.user;
        }
        await this.handleRevoked({ offlineExpired: true });
        return null;
      }
      throw err;
    }
  }

  async logout() {
    if (this.session?.sessionToken) {
      const token = this.session.sessionToken;
      await this.fetchImpl(`${this.vpsUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }
    await this.clearSession();
  }

  async pullUserData() {
    if (!this.authenticated) return null;
    this.syncStatus = 'syncing';
    this.lastSyncError = null;
    try {
      const data = await this.request('/api/user/data');
      await this.saveSession({ ...this.session, lastVerifiedAt: new Date(this.now()).toISOString() });
      this.syncStatus = 'synced';
      this.lastSyncedAt = data.updatedAt ?? new Date(this.now()).toISOString();
      return data;
    } catch (err) {
      if (err.networkError && this.isWithinOfflineGrace()) {
        this.offlineMode = true;
        this.syncStatus = 'offline';
        this.lastSyncError = 'VPS fora do ar · usando dados locais';
        return null;
      }
      this.syncStatus = 'error';
      this.lastSyncError = err.message;
      throw err;
    }
  }

  async pushUserData({ products, settings }) {
    if (!this.authenticated) return null;
    this.syncStatus = 'syncing';
    this.lastSyncError = null;
    try {
      const data = await this.request('/api/user/data', {
        method: 'PUT',
        body: { products, settings },
      });
      this.pendingSync = false;
      await this.saveSession({ ...this.session, pendingSync: false, lastVerifiedAt: new Date(this.now()).toISOString() });
      this.syncStatus = 'synced';
      this.lastSyncedAt = data.updatedAt ?? new Date(this.now()).toISOString();
      return data;
    } catch (err) {
      if (err.networkError && this.isWithinOfflineGrace()) {
        this.offlineMode = true;
        this.pendingSync = true;
        await this.saveSession({ ...this.session, pendingSync: true }).catch(() => {});
        this.syncStatus = 'offline';
        this.lastSyncError = 'Alterações salvas localmente (serão enviadas quando o VPS voltar)';
        return null;
      }
      this.syncStatus = 'error';
      this.lastSyncError = err.message;
      return null;
    }
  }

  async fetchLatestUpdate() {
    if (!this.authenticated || this.offlineMode) return null;
    return this.request('/api/updates/latest');
  }

  async downloadUpdate(filename) {
    if (!this.authenticated) throw new Error('Sessão não autenticada.');
    let res;
    try {
      res = await this.fetchImpl(`${this.vpsUrl}/api/updates/download/${encodeURIComponent(filename)}`, {
        headers: { Authorization: `Bearer ${this.session.sessionToken}` },
        signal: AbortSignal.timeout(60000),
      });
    } catch (networkErr) {
      const timedOut = networkErr?.name === 'TimeoutError' || networkErr?.name === 'AbortError';
      const err = new Error(timedOut ? 'Tempo limite ao baixar atualização do servidor VPS.' : `Falha de rede ao baixar atualização: ${networkErr.message}`);
      err.networkError = true;
      throw err;
    }
    if (!res.ok) {
      if (res.status === 401) {
        await this.handleRevoked();
      }
      const err = new Error(`Falha ao baixar atualização (HTTP ${res.status}).`);
      err.status = res.status;
      if (res.status >= 500) err.networkError = true;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async adminListAllowlist() {
    return this.request('/api/admin/allowlist');
  }

  async adminAddEmail({ email, role = 'user', note = '' }) {
    return this.request('/api/admin/allowlist', {
      method: 'POST',
      body: { email, role, note },
    });
  }

  async adminRemoveEmail(email) {
    return this.request(`/api/admin/allowlist/${encodeURIComponent(email)}`, {
      method: 'DELETE',
    });
  }
}
