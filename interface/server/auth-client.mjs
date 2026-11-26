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
  constructor({ dataDirectory, vpsUrl = '', fetchImpl = fetch, now = () => Date.now(), offlineGraceMs = OFFLINE_GRACE_MS } = {}) {
    this.dataDirectory = dataDirectory;
    this.sessionFile = join(dataDirectory, 'auth-session.json');
    this.vpsUrl = String(vpsUrl ?? '').trim().replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.offlineGraceMs = offlineGraceMs;
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
      vpsUrl: this.vpsUrl || null,
      authenticated: this.authenticated,
      offlineMode: this.offlineMode && this.authenticated,
      offlineExpired: this.offlineExpired,
      offlineDaysRemaining: this.offlineMode && this.authenticated ? this.offlineDaysRemaining() : null,
      lastVerifiedAt: this.session?.lastVerifiedAt ?? null,
      pendingSync: this.pendingSync,
      user: this.authenticated ? (this.session?.user ?? null) : null,
      loginUrl: this.enabled && localOrigin
        ? `${this.vpsUrl}/auth/google/start?callback=${encodeURIComponent(`${localOrigin}/api/auth/callback`)}`
        : null,
      syncStatus: this.syncStatus,
      lastSyncedAt: this.lastSyncedAt,
      lastSyncError: this.lastSyncError,
    };
  }

  async saveSession(session) {
    this.session = session;
    await mkdir(this.dataDirectory, { recursive: true });
    await writeFile(this.sessionFile, JSON.stringify(session, null, 2), 'utf8');
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
      });
    } catch (networkErr) {
      const err = new Error(`Servidor VPS inacessível: ${networkErr.message}`);
      err.networkError = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && auth) {
        await this.clearSession();
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
        this.offlineMode = true;
        this.offlineExpired = true;
        this.syncStatus = 'error';
        this.lastSyncError = 'Mais de 7 dias sem conexão com o servidor VPS. Conecte-se para renovar o acesso.';
        return null;
      }
      throw err;
    }
  }

  async logout() {
    if (this.session?.sessionToken) {
      await this.request('/api/auth/logout', { method: 'POST' }).catch(() => {});
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
      await this.saveSession({ ...this.session, lastVerifiedAt: new Date(this.now()).toISOString() });
      this.pendingSync = false;
      this.syncStatus = 'synced';
      this.lastSyncedAt = data.updatedAt ?? new Date(this.now()).toISOString();
      return data;
    } catch (err) {
      if (err.networkError && this.isWithinOfflineGrace()) {
        this.offlineMode = true;
        this.pendingSync = true;
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
    const res = await this.fetchImpl(`${this.vpsUrl}/api/updates/download/${encodeURIComponent(filename)}`, {
      headers: { Authorization: `Bearer ${this.session.sessionToken}` },
    });
    if (!res.ok) throw new Error(`Falha ao baixar atualização (HTTP ${res.status}).`);
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
