// Cloudflare API v4 客户端
// 认证：API Token（Bearer）或 Global API Key + Email
const CF_BASE = 'https://api.cloudflare.com/client/v4';

function cfHeaders(account) {
  const headers = { 'Content-Type': 'application/json' };
  if (account.auth_type === 'key') {
    headers['X-Auth-Email'] = account.email || '';
    headers['X-Auth-Key'] = account.token;
  } else {
    headers['Authorization'] = `Bearer ${account.token}`;
  }
  return headers;
}

async function cfRequest(account, path, { method = 'GET', body } = {}) {
  const res = await fetch(CF_BASE + path, {
    method,
    headers: cfHeaders(account),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.success) {
    const msg = (data.errors || []).map((e) => e.message).join('; ') || `Cloudflare HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function listZones(account) {
  const all = [];
  let page = 1;
  const perPage = 50;
  for (;;) {
    const data = await cfRequest(account, `/zones?page=${page}&per_page=${perPage}&order=name&direction=asc`);
    all.push(...data.result);
    const info = data.result_info || {};
    if (all.length >= info.total_count || !data.result.length) break;
    page += 1;
  }
  return all;
}

export async function listRecords(account, zoneId) {
  const all = [];
  let page = 1;
  const perPage = 100;
  for (;;) {
    const data = await cfRequest(account, `/zones/${zoneId}/dns_records?page=${page}&per_page=${perPage}`);
    all.push(...data.result);
    const info = data.result_info || {};
    if (all.length >= info.total_count || !data.result.length) break;
    page += 1;
  }
  return all;
}

export async function createRecord(account, zoneId, record) {
  const data = await cfRequest(account, `/zones/${zoneId}/dns_records`, { method: 'POST', body: record });
  return data.result;
}

export async function updateRecord(account, zoneId, recordId, record) {
  const data = await cfRequest(account, `/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'PATCH',
    body: record,
  });
  return data.result;
}

export async function deleteRecord(account, zoneId, recordId) {
  return cfRequest(account, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
}

export async function setProxy(account, zoneId, recordId, proxied) {
  return updateRecord(account, zoneId, recordId, { proxied });
}

// 统一记录字段模型
export function toCommon(r) {
  return {
    id: r.id,
    provider: 'cloudflare',
    type: r.type,
    name: r.name,
    content: r.content,
    ttl: r.ttl ?? 1,
    proxied: !!r.proxied,
    status: 'enabled',
    line: null,
    mx: r.type === 'MX' ? (r.priority ?? 10) : null,
    remark: r.comment || '',
    locked: !!r.locked,
  };
}

export function fromCommon(r) {
  const body = {};
  if (r.type != null) body.type = r.type;
  if (r.name != null) body.name = r.name;
  if (r.content != null && r.content !== '') body.content = r.content;
  if (r.ttl != null && r.ttl !== '') body.ttl = Number(r.ttl);
  if (r.proxied != null) body.proxied = !!r.proxied;
  if (r.type === 'MX' && r.mx != null) body.priority = Number(r.mx);
  if (r.remark != null && String(r.remark).trim()) body.comment = String(r.remark).trim();
  return body;
}
