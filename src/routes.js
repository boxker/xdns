import express from 'express';
import * as cf from './cloudflare.js';
import * as dns from './dnspod.js';
import * as store from './db.js';
import * as dnscheck from './dnscheck.js';
import { hashPassword, verifyPassword, createSession, sessionCookie, clearCookie } from './auth.js';

export const router = express.Router();

// 登录失败速率限制（内存版，防暴力破解）：每个 IP 15 分钟内最多 10 次失败
const loginFailures = new Map(); // ip -> { count, resetAt }
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function clientIp(req) {
  return req.socket?.remoteAddress || '';
}

function loginThrottled(ip) {
  const rec = loginFailures.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    loginFailures.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const rec = loginFailures.get(ip);
  if (!rec || Date.now() > rec.resetAt) {
    loginFailures.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  } else {
    rec.count += 1;
  }
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

function audit(req, action, detail = '') {
  try {
    store.addAuditLog({ username: req.user?.username || '-', action, detail, ip: clientIp(req) });
  } catch (e) {
    console.error('[AUDIT]', e.message);
  }
}

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error('[API ERROR]', e.message);
      res.status(e.status || 500).json({ error: e.message || 'Internal error' });
    }
  };
}

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function getAccount(req) {
  const acc = store.getAccount(Number(req.params.accountId));
  if (!acc) {
    const e = new Error('账户不存在');
    e.status = 404;
    throw e;
  }
  return acc;
}

// ---------- 认证 ----------
router.post('/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const ip = clientIp(req);
  if (loginThrottled(ip)) {
    const e = new Error('失败次数过多，请 15 分钟后再试');
    e.status = 429;
    throw e;
  }
  if (!username || !password) throw badRequest('请输入用户名和密码');
  const user = store.getUserByUsername(String(username));
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    recordLoginFailure(ip);
    store.addAuditLog({ username: String(username), action: 'login_failed', detail: '', ip });
    const e = new Error('用户名或密码错误');
    e.status = 401;
    throw e;
  }
  clearLoginFailures(ip);
  const token = createSession(user.id);
  res.setHeader('Set-Cookie', sessionCookie(token));
  req.user = user;
  audit(req, 'login', `用户 ${user.username} 登录`);
  res.json({ username: user.username });
}));

router.post('/auth/logout', wrap(async (req, res) => {
  if (req.sessionToken) store.deleteSession(req.sessionToken);
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
}));

router.get('/auth/me', wrap(async (req, res) => {
  res.json({ username: req.user.username });
}));

router.put('/auth/password', wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !verifyPassword(String(oldPassword), req.user.password_hash)) throw badRequest('原密码错误');
  if (!newPassword || String(newPassword).length < 6) throw badRequest('新密码至少 6 位');
  store.updatePassword(req.user.id, hashPassword(String(newPassword)));
  store.deleteSessionsByUser(req.user.id);
  res.setHeader('Set-Cookie', clearCookie());
  audit(req, 'change_password', `用户 ${req.user.username} 修改了密码`);
  res.json({ ok: true });
}));

// ---------- 账户管理 ----------
router.get('/accounts', wrap(async (req, res) => {
  res.json(store.listAccounts().map((a) => ({
    ...publicAccount(a),
    tokenHint: a.provider === 'dnspod' && !dns.isValidToken(a.token)
      ? 'Token 不完整，需要「数字ID,Token」'
      : '',
  })));
}));

function publicAccount(a) {
  return {
    id: a.id,
    provider: a.provider,
    name: a.name,
    auth_type: a.auth_type,
    email: a.email || '',
    hasToken: !!a.token,
  };
}

async function normalizeAccountPayload({ provider, name, auth_type, token, email }, { requireToken }) {
  if (!provider || !name) throw badRequest('缺少必要字段：服务商 / 名称');
  if (requireToken && !token) throw badRequest('缺少 Token');
  let t = token;
  if (provider === 'dnspod' && token) {
    t = dns.normalizeToken(token);
    if (!dns.isValidToken(t)) {
      throw badRequest('DNSPod Token 格式应为「数字ID,Token」，例如 123456,xxxxxxxx。请到 DNSPod 控制台 → 密钥管理 复制完整 Token，不要只用后半段。');
    }
  }
  return { provider, name, auth_type: auth_type || 'token', token: t, email: email || '' };
}

router.post('/accounts', wrap(async (req, res) => {
  const payload = await normalizeAccountPayload(req.body || {}, { requireToken: true });
  if (payload.provider === 'dnspod') await dns.listDomains(payload);
  const acc = store.createAccount(payload);
  audit(req, 'account_create', `添加账户「${acc.name}」(${acc.provider})`);
  res.json(publicAccount(acc));
}));

router.put('/accounts/:id', wrap(async (req, res) => {
  const existing = store.getAccount(Number(req.params.id));
  if (!existing) {
    const e = new Error('账户不存在');
    e.status = 404;
    throw e;
  }
  const payload = await normalizeAccountPayload(
    { ...req.body, provider: existing.provider, name: (req.body || {}).name || existing.name },
    { requireToken: false }
  );
  const patch = { name: payload.name, auth_type: payload.auth_type, email: payload.email };
  if (payload.token) patch.token = payload.token;
  if (existing.provider === 'dnspod' && patch.token) {
    await dns.listDomains({ ...existing, ...patch });
  }
  const updated = store.updateAccount(Number(req.params.id), patch);
  res.json(publicAccount(updated));
}));

router.delete('/accounts/:id', wrap(async (req, res) => {
  const existing = store.getAccount(Number(req.params.id));
  store.deleteAccount(Number(req.params.id));
  if (existing) audit(req, 'account_delete', `删除账户「${existing.name}」(${existing.provider})`);
  res.json({ ok: true });
}));

// ---------- 审计日志 ----------
router.get('/logs', wrap(async (req, res) => {
  res.json(store.listAuditLogs(req.query.limit));
}));

// ---------- DNS 生效检测 ----------
router.get('/tools/dns-lookup', wrap(async (req, res) => {
  const { type, name, content } = req.query;
  if (!type || !name) throw badRequest('缺少 type / name 参数');
  const result = await dnscheck.lookup(String(type), String(name));
  const matched = result.supported && content
    ? dnscheck.matchValues(String(content), result.values)
    : null;
  res.json({ ...result, matched });
}));

// ---------- Cloudflare ----------
router.get('/cloudflare/:accountId/zones', wrap(async (req, res) => {
  const acc = getAccount(req);
  const zones = await cf.listZones(acc);
  res.json(zones.map((z) => ({ id: z.id, name: z.name, status: z.status, nameServers: z.name_servers })));
}));

router.get('/cloudflare/:accountId/zones/:zoneId/records', wrap(async (req, res) => {
  const acc = getAccount(req);
  const records = await cf.listRecords(acc, req.params.zoneId);
  res.json(records.map(cf.toCommon));
}));

router.post('/cloudflare/:accountId/zones/:zoneId/records', wrap(async (req, res) => {
  const acc = getAccount(req);
  const record = await cf.createRecord(acc, req.params.zoneId, cf.fromCommon(req.body));
  audit(req, 'record_create', `[CF:${acc.name}] 新增 ${record.type} ${record.name} -> ${record.content}`);
  res.json(cf.toCommon(record));
}));

router.patch('/cloudflare/:accountId/zones/:zoneId/records/:recordId', wrap(async (req, res) => {
  const acc = getAccount(req);
  const record = await cf.updateRecord(acc, req.params.zoneId, req.params.recordId, cf.fromCommon(req.body));
  audit(req, 'record_update', `[CF:${acc.name}] 修改 ${record.type} ${record.name} -> ${record.content}`);
  res.json(cf.toCommon(record));
}));

router.patch('/cloudflare/:accountId/zones/:zoneId/records/:recordId/proxy', wrap(async (req, res) => {
  const acc = getAccount(req);
  const record = await cf.setProxy(acc, req.params.zoneId, req.params.recordId, !!req.body?.proxied);
  res.json(cf.toCommon(record));
}));

router.delete('/cloudflare/:accountId/zones/:zoneId/records/:recordId', wrap(async (req, res) => {
  const acc = getAccount(req);
  const body = req.body || {};
  await cf.deleteRecord(acc, req.params.zoneId, req.params.recordId);
  audit(req, 'record_delete', `[CF:${acc.name}] 删除 ${body.type || ''} ${body.name || req.params.recordId}`.trim());
  res.json({ ok: true });
}));

// ---------- DNSPod ----------
router.get('/dnspod/:accountId/domains', wrap(async (req, res) => {
  const acc = getAccount(req);
  const domains = await dns.listDomains(acc);
  res.json(domains.map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    grade: d.grade_title || d.grade || '',
  })));
}));

router.get('/dnspod/:accountId/records', wrap(async (req, res) => {
  const acc = getAccount(req);
  const domain = req.query.domain;
  if (!domain) throw badRequest('缺少 domain 参数');
  const { records } = await dns.listRecords(acc, domain);
  res.json(records.map((r) => dns.toCommon(r, domain)));
}));

router.post('/dnspod/:accountId/records', wrap(async (req, res) => {
  const acc = getAccount(req);
  const domain = req.query.domain;
  if (!domain) throw badRequest('缺少 domain 参数');
  const record = await dns.createRecord(acc, domain, dns.fromCommon(req.body, domain));
  audit(req, 'record_create', `[DNSPod:${acc.name}] 新增 ${req.body?.type} ${req.body?.name} -> ${req.body?.content}`);
  res.json(dns.toCommon(record, domain));
}));

router.put('/dnspod/:accountId/records/:recordId', wrap(async (req, res) => {
  const acc = getAccount(req);
  const domain = req.query.domain;
  if (!domain) throw badRequest('缺少 domain 参数');
  const record = await dns.modifyRecord(acc, domain, req.params.recordId, dns.fromCommon(req.body, domain));
  audit(req, 'record_update', `[DNSPod:${acc.name}] 修改 ${req.body?.type} ${req.body?.name} -> ${req.body?.content}`);
  res.json(dns.toCommon(record, domain));
}));

router.patch('/dnspod/:accountId/records/:recordId/status', wrap(async (req, res) => {
  const acc = getAccount(req);
  const domain = req.query.domain;
  if (!domain) throw badRequest('缺少 domain 参数');
  const record = await dns.setStatus(acc, domain, req.params.recordId, req.body?.status);
  res.json(dns.toCommon(record, domain));
}));

router.delete('/dnspod/:accountId/records/:recordId', wrap(async (req, res) => {
  const acc = getAccount(req);
  const domain = req.query.domain;
  if (!domain) throw badRequest('缺少 domain 参数');
  const body = req.body || {};
  await dns.removeRecord(acc, domain, req.params.recordId);
  audit(req, 'record_delete', `[DNSPod:${acc.name}] 删除 ${body.type || ''} ${body.name || req.params.recordId}`.trim());
  res.json({ ok: true });
}));
