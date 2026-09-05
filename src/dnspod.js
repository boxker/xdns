// DNSPod 传统 API（dnsapi.cn）
// 认证：login_token = "ID,Token"（英文逗号）。子账号 / 腾讯云 SecretId 不可用。
// User-Agent 必须是「程序名/版本 (邮箱)」，否则官方会拒请求甚至封 API。
const DNS_BASE = 'https://dnsapi.cn/';
const USER_AGENT = 'xDNS/1.0.0 (xdns@localhost)';

export function normalizeToken(raw) {
  return String(raw || '')
    .trim()
    .replace(/，/g, ',')
    .replace(/\s+/g, '');
}

export function isValidToken(raw) {
  return /^\d+,[^,\s]+$/.test(normalizeToken(raw));
}

function statusCode(data) {
  return String(data?.status?.code ?? '');
}

async function dnsRequest(account, action, params = {}) {
  const loginToken = normalizeToken(account.token);
  if (!isValidToken(loginToken)) {
    const err = new Error('DNSPod Token 格式无效，应为「数字ID,Token」，例如 123456,xxxxxxxx');
    err.status = 400;
    throw err;
  }

  const body = new URLSearchParams();
  const all = {
    login_token: loginToken,
    format: 'json',
    lang: 'cn',
    error_on_empty: 'no',
    ...params,
  };
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined || v === null) continue;
    body.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(DNS_BASE + action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
    });
  } catch (e) {
    const err = new Error(`无法连接 DNSPod：${e.message}`);
    err.status = 502;
    throw err;
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`DNSPod 返回异常（HTTP ${res.status}）`);
    err.status = 502;
    throw err;
  }

  const code = statusCode(data);
  // 9/10：没有数据。配合 error_on_empty=no，按空列表处理，不当成鉴权失败。
  if (code === '9' || code === '10') {
    return { ...data, domains: data.domains || [], records: data.records || [] };
  }
  if (code && code !== '1') {
    const msg = data.status?.message || 'DNSPod API 错误';
    const err = new Error(explainDnsError(code, msg));
    err.status = 400;
    throw err;
  }
  return data;
}

function explainDnsError(code, msg) {
  const map = {
    '-1': '登录失败，请检查 Token 是否为「ID,Token」完整格式，且来自 DNSPod 密钥管理（不是腾讯云 SecretId/SecretKey）',
    2: '只允许 POST',
    3: '请使用 HTTPS',
    6: '用户 ID 错误',
    7: '无效的 Token',
    8: '登录失败次数过多，请稍后再试',
    13: '当前 IP 未在 API 白名单中',
  };
  const extra = map[code] || map[String(code)];
  return extra ? `${msg}（${extra}）` : msg;
}

export async function listDomains(account) {
  const data = await dnsRequest(account, 'Domain.List', { type: 'all', length: 3000 });
  return data.domains || [];
}

export async function listRecords(account, domain) {
  const data = await dnsRequest(account, 'Record.List', { domain, length: 3000 });
  return { domain: data.domain, records: data.records || [] };
}

export async function createRecord(account, domain, record) {
  const data = await dnsRequest(account, 'Record.Create', buildParams(domain, record));
  return data.record;
}

export async function modifyRecord(account, domain, recordId, record) {
  const data = await dnsRequest(account, 'Record.Modify', {
    ...buildParams(domain, record),
    record_id: recordId,
  });
  return data.record;
}

export async function removeRecord(account, domain, recordId) {
  return dnsRequest(account, 'Record.Remove', { domain, record_id: recordId });
}

export function normalizeRecordStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'disable' || s === 'disabled' || s === 'pause' || s === 'paused' ? 'disabled' : 'enabled';
}

export async function setStatus(account, domain, recordId, status) {
  const action = normalizeRecordStatus(status) === 'disabled' ? 'disable' : 'enable';
  await dnsRequest(account, 'Record.Status', { domain, record_id: recordId, status: action });
  const { records } = await listRecords(account, domain);
  return records.find((r) => String(r.id) === String(recordId));
}

function buildParams(domain, record) {
  const params = {
    domain,
    sub_domain: record.name,
    record_type: record.type,
    record_line: record.line || '默认',
    value: record.content,
    ttl: record.ttl,
    mx: record.type === 'MX' ? (record.mx ?? 10) : null,
  };
  if (record.remark != null && String(record.remark).trim()) params.remark = String(record.remark).trim().slice(0, 200);
  return params;
}

export function toCommon(r, domain) {
  const full = r.name === '@' ? domain : `${r.name}.${domain}`;
  return {
    id: r.id,
    provider: 'dnspod',
    type: r.type,
    name: full,
    content: r.value,
    ttl: parseInt(r.ttl, 10) || 600,
    proxied: null,
    status: normalizeRecordStatus(r.status),
    line: r.line || '默认',
    mx: r.type === 'MX' ? (parseInt(r.mx, 10) || 10) : null,
    remark: r.remark || '',
    locked: false,
  };
}

export function fromCommon(r, domain) {
  const sub =
    !r.name || r.name === domain || r.name === '@'
      ? '@'
      : r.name.endsWith(`.${domain}`)
        ? r.name.slice(0, -(domain.length + 1))
        : r.name;
  return {
    name: sub,
    type: r.type,
    content: r.content,
    ttl: r.ttl != null && r.ttl !== '' ? Number(r.ttl) : 600,
    line: r.line || '默认',
    mx: r.mx ?? null,
    remark: r.remark ?? '',
  };
}
