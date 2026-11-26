import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS allowed_emails (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      note TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL,
      added_by TEXT NOT NULL DEFAULT 'system'
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_sub TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      picture TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      created_at TEXT NOT NULL,
      last_login_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_data (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      products_json TEXT NOT NULL DEFAULT '[]',
      settings_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      callback_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_codes (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  const nowIso = () => new Date().toISOString();

  return {
    raw: db,
    close() {
      db.close();
    },

    seedAdmins(emails) {
      const stmt = db.prepare(`
        INSERT INTO allowed_emails (email, role, note, added_at, added_by)
        VALUES (?, 'admin', 'Admin inicial (.env)', ?, 'env')
        ON CONFLICT(email) DO UPDATE SET role = 'admin'
      `);
      const now = nowIso();
      for (const raw of emails) {
        const email = normalizeEmail(raw);
        if (isValidEmail(email)) {
          stmt.run(email, now);
        }
      }
    },

    getAllowedEmail(email) {
      const normalized = normalizeEmail(email);
      return db.prepare('SELECT email, role, note, added_at, added_by FROM allowed_emails WHERE email = ?').get(normalized) ?? null;
    },

    listAllowedEmails() {
      return db.prepare(`
        SELECT
          a.email,
          a.role,
          a.note,
          a.added_at AS addedAt,
          a.added_by AS addedBy,
          u.id AS userId,
          u.name,
          u.picture,
          u.last_login_at AS lastLoginAt
        FROM allowed_emails a
        LEFT JOIN users u ON u.email = a.email
        ORDER BY a.role ASC, a.email ASC
      `).all();
    },

    addAllowedEmail(email, { role = 'user', note = '', addedBy = 'admin' } = {}) {
      const normalized = normalizeEmail(email);
      if (!isValidEmail(normalized)) throw new Error('E-mail inválido.');
      if (role !== 'admin' && role !== 'user') throw new Error('Papel inválido (use admin ou user).');
      const now = nowIso();
      db.prepare(`
        INSERT INTO allowed_emails (email, role, note, added_at, added_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET role = excluded.role, note = excluded.note
      `).run(normalized, role, String(note ?? '').trim().slice(0, 200), now, addedBy);
      db.prepare('UPDATE users SET role = ? WHERE email = ?').run(role, normalized);
      return this.getAllowedEmail(normalized);
    },

    removeAllowedEmail(email) {
      const normalized = normalizeEmail(email);
      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
      if (user) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM auth_codes WHERE user_id = ?').run(user.id);
      }
      const result = db.prepare('DELETE FROM allowed_emails WHERE email = ?').run(normalized);
      return result.changes > 0;
    },

    upsertUser({ googleSub, email, name, picture, role }) {
      const normalized = normalizeEmail(email);
      const now = nowIso();
      const existing = db.prepare('SELECT id FROM users WHERE google_sub = ? OR email = ?').get(googleSub, normalized);
      if (existing) {
        db.prepare(`
          UPDATE users
          SET google_sub = ?, email = ?, name = ?, picture = ?, role = ?, last_login_at = ?
          WHERE id = ?
        `).run(googleSub, normalized, name ?? '', picture ?? '', role, now, existing.id);
        return this.getUserById(existing.id);
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO users (id, google_sub, email, name, picture, role, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, googleSub, normalized, name ?? '', picture ?? '', role, now, now);
      return this.getUserById(id);
    },

    getUserById(id) {
      const row = db.prepare(`
        SELECT id, google_sub AS googleSub, email, name, picture, role, created_at AS createdAt, last_login_at AS lastLoginAt
        FROM users WHERE id = ?
      `).get(id);
      return row ?? null;
    },

    createOAuthState({ codeVerifier, callbackUrl, ttlSeconds = 600 }) {
      const state = randomBytes(24).toString('base64url');
      const now = Date.now();
      db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(new Date(now).toISOString());
      db.prepare(`
        INSERT INTO oauth_states (state, code_verifier, callback_url, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(state, codeVerifier, callbackUrl, new Date(now).toISOString(), new Date(now + ttlSeconds * 1000).toISOString());
      return state;
    },

    consumeOAuthState(state) {
      const row = db.prepare('SELECT state, code_verifier AS codeVerifier, callback_url AS callbackUrl, expires_at AS expiresAt FROM oauth_states WHERE state = ?').get(state);
      if (!row) return null;
      db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
      if (Date.parse(row.expiresAt) < Date.now()) return null;
      return row;
    },

    createAuthCode(userId, ttlSeconds = 60) {
      const code = randomBytes(32).toString('base64url');
      const now = Date.now();
      db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(new Date(now).toISOString());
      db.prepare(`
        INSERT INTO auth_codes (code, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(code, userId, new Date(now).toISOString(), new Date(now + ttlSeconds * 1000).toISOString());
      return code;
    },

    consumeAuthCode(code) {
      const row = db.prepare('SELECT code, user_id AS userId, expires_at AS expiresAt FROM auth_codes WHERE code = ?').get(code);
      if (!row) return null;
      db.prepare('DELETE FROM auth_codes WHERE code = ?').run(code);
      if (Date.parse(row.expiresAt) < Date.now()) return null;
      return row.userId;
    },

    createSession(userId, { ttlDays = 30, deviceLabel = '' } = {}) {
      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashToken(token);
      const now = Date.now();
      const expiresAt = new Date(now + ttlDays * 24 * 60 * 60 * 1000).toISOString();
      const nowStr = new Date(now).toISOString();
      db.prepare(`
        INSERT INTO sessions (token_hash, user_id, device_label, created_at, expires_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(tokenHash, userId, String(deviceLabel).slice(0, 100), nowStr, expiresAt, nowStr);
      return { token, expiresAt };
    },

    validateSession(token) {
      if (!token) return null;
      const tokenHash = hashToken(token);
      const row = db.prepare(`
        SELECT s.token_hash AS tokenHash, s.user_id AS userId, s.expires_at AS expiresAt,
               u.id, u.email, u.name, u.picture, u.role, u.last_login_at AS lastLoginAt
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
      `).get(tokenHash);
      if (!row) return null;
      if (Date.parse(row.expiresAt) < Date.now()) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
        return null;
      }
      const allowed = this.getAllowedEmail(row.email);
      if (!allowed) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.userId);
        return null;
      }
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash);
      return {
        tokenHash,
        user: {
          id: row.id,
          email: row.email,
          name: row.name,
          picture: row.picture,
          role: allowed.role,
          lastLoginAt: row.lastLoginAt,
        },
      };
    },

    revokeSession(token) {
      if (!token) return false;
      const res = db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      return res.changes > 0;
    },

    getUserData(userId) {
      const row = db.prepare('SELECT products_json AS productsJson, settings_json AS settingsJson, version, updated_at AS updatedAt FROM user_data WHERE user_id = ?').get(userId);
      if (!row) {
        return { exists: false, products: [], settings: null, version: 0, updatedAt: null };
      }
      return {
        exists: true,
        products: JSON.parse(row.productsJson),
        settings: JSON.parse(row.settingsJson),
        version: row.version,
        updatedAt: row.updatedAt,
      };
    },

    saveUserData(userId, { products, settings }) {
      const now = nowIso();
      const productsJson = JSON.stringify(Array.isArray(products) ? products : []);
      const settingsJson = JSON.stringify(settings && typeof settings === 'object' ? settings : {});
      const existing = db.prepare('SELECT version FROM user_data WHERE user_id = ?').get(userId);
      if (existing) {
        const nextVersion = existing.version + 1;
        db.prepare(`
          UPDATE user_data
          SET products_json = ?, settings_json = ?, version = ?, updated_at = ?
          WHERE user_id = ?
        `).run(productsJson, settingsJson, nextVersion, now, userId);
        return { version: nextVersion, updatedAt: now };
      }
      db.prepare(`
        INSERT INTO user_data (user_id, products_json, settings_json, version, updated_at)
        VALUES (?, ?, ?, 1, ?)
      `).run(userId, productsJson, settingsJson, now);
      return { version: 1, updatedAt: now };
    },
  };
}
