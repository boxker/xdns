// 认证模块：密码哈希（scrypt）、会话管理、鉴权中间件、Cookie 解析
// 全站纯 Node.js 内置能力实现，无第三方依赖
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import * as store from './db.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 会话有效期 7 天
export const COOKIE_NAME = 'xdns_session';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(String(password), salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  store.createSession(token, userId, Date.now() + SESSION_TTL_MS);
  return token;
}

export function sessionCookie(token, { secure = false } = {}) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearCookie({ secure = false } = {}) {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = part.slice(i + 1).trim();
  }
  return out;
}

// 免登录路径（相对 /api）
const PUBLIC_PATHS = new Set(['/auth/login']);

export function authMiddleware(req, res, next) {
  const path = (req.originalUrl || req.url || req.path || '').split('?')[0];
  if (PUBLIC_PATHS.has(req.path) || path === '/api/auth/login' || path.endsWith('/auth/login')) return next();

  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: '未登录' });

  const session = store.getSession(token);
  if (!session || session.expires_at < Date.now()) {
    if (session) store.deleteSession(token);
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }

  const user = store.getUserById(session.user_id);
  if (!user) return res.status(401).json({ error: '用户不存在' });

  req.user = user;
  req.sessionToken = token;
  next();
}
