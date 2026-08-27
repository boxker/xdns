import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'xdns.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'token',
    token TEXT NOT NULL,
    email TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

export function listAccounts() {
  return db.prepare('SELECT id, provider, name, auth_type, email, token FROM accounts ORDER BY id').all();
}

export function getAccount(id) {
  return db.prepare('SELECT id, provider, name, auth_type, email, token FROM accounts WHERE id = ?').get(id);
}

export function createAccount({ provider, name, auth_type = 'token', token, email = '' }) {
  const r = db
    .prepare('INSERT INTO accounts (provider, name, auth_type, token, email) VALUES (?,?,?,?,?)')
    .run(provider, name, auth_type, token, email ?? '');
  return getAccount(Number(r.lastInsertRowid));
}

export function updateAccount(id, fields) {
  const acc = getAccount(id);
  if (!acc) return null;
  const provider = fields.provider ?? acc.provider;
  const name = fields.name ?? acc.name;
  const auth_type = fields.auth_type ?? acc.auth_type;
  const token = fields.token ?? acc.token;
  const email = fields.email ?? acc.email ?? '';
  db.prepare('UPDATE accounts SET provider=?, name=?, auth_type=?, token=?, email=? WHERE id=?')
    .run(provider, name, auth_type, token, email, id);
  return getAccount(id);
}

export function deleteAccount(id) {
  return db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

// ---------- 用户 ----------
export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

export function getUserById(id) {
  return db.prepare('SELECT id, username, password_hash FROM users WHERE id = ?').get(id);
}

export function getUserByUsername(username) {
  return db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
}

export function createUser(username, passwordHash) {
  const r = db
    .prepare('INSERT INTO users (username, password_hash) VALUES (?,?)')
    .run(username, passwordHash);
  return getUserById(Number(r.lastInsertRowid));
}

export function updatePassword(id, passwordHash) {
  return db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

// ---------- 会话 ----------
export function createSession(token, userId, expiresAt) {
  return db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expiresAt);
}

export function getSession(token) {
  return db.prepare('SELECT token, user_id, expires_at FROM sessions WHERE token = ?').get(token);
}

export function deleteSession(token) {
  return db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function deleteSessionsByUser(userId) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function deleteExpiredSessions(now) {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}
