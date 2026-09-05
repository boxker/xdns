const BASE = '/api';

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new Error(data.error || '未登录或登录已过期');
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

export const api = {
  // 认证
  auth: {
    login: (username, password) =>
      request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    me: () => request('/auth/me'),
    changePassword: (oldPassword, newPassword) =>
      request('/auth/password', { method: 'PUT', body: JSON.stringify({ oldPassword, newPassword }) }),
  },

  // 账户
  listAccounts: () => request('/accounts'),
  createAccount: (a) => request('/accounts', { method: 'POST', body: JSON.stringify(a) }),
  updateAccount: (id, a) => request(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(a) }),
  deleteAccount: (id) => request(`/accounts/${id}`, { method: 'DELETE' }),
  // 手动测试连接：后端按服务商拉一次最小列表验证凭证，只读探测、不落审计
  testAccount: (id) => request(`/accounts/${id}/test`, { method: 'POST' }),

  // Cloudflare
  cfZones: (id) => request(`/cloudflare/${id}/zones`),
  cfRecords: (id, zoneId) => request(`/cloudflare/${id}/zones/${zoneId}/records`),
  cfCreate: (id, zoneId, r) =>
    request(`/cloudflare/${id}/zones/${zoneId}/records`, { method: 'POST', body: JSON.stringify(r) }),
  cfUpdate: (id, zoneId, rid, r) =>
    request(`/cloudflare/${id}/zones/${zoneId}/records/${rid}`, { method: 'PATCH', body: JSON.stringify(r) }),
  cfDelete: (id, zoneId, rid, meta) =>
    request(`/cloudflare/${id}/zones/${zoneId}/records/${rid}`, {
      method: 'DELETE',
      body: JSON.stringify(meta || {}),
    }),
  cfProxy: (id, zoneId, rid, proxied) =>
    request(`/cloudflare/${id}/zones/${zoneId}/records/${rid}/proxy`, {
      method: 'PATCH',
      body: JSON.stringify({ proxied }),
    }),

  // DNSPod
  dnsDomains: (id) => request(`/dnspod/${id}/domains`),
  dnsRecords: (id, domain) => request(`/dnspod/${id}/records?domain=${encodeURIComponent(domain)}`),
  dnsCreate: (id, domain, r) =>
    request(`/dnspod/${id}/records?domain=${encodeURIComponent(domain)}`, {
      method: 'POST',
      body: JSON.stringify(r),
    }),
  dnsUpdate: (id, domain, rid, r) =>
    request(`/dnspod/${id}/records/${rid}?domain=${encodeURIComponent(domain)}`, {
      method: 'PUT',
      body: JSON.stringify(r),
    }),
  dnsDelete: (id, domain, rid, meta) =>
    request(`/dnspod/${id}/records/${rid}?domain=${encodeURIComponent(domain)}`, {
      method: 'DELETE',
      body: JSON.stringify(meta || {}),
    }),
  dnsStatus: (id, domain, rid, status) =>
    request(`/dnspod/${id}/records/${rid}/status?domain=${encodeURIComponent(domain)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  // 阿里云 ESA（站点用 siteId 定位，site 参数为站点名，用于记录名展开 FQDN）
  esaSites: (id) => request(`/aliyun-esa/${id}/sites`),
  esaRecords: (id, siteId, site) =>
    request(`/aliyun-esa/${id}/sites/${siteId}/records?site=${encodeURIComponent(site)}`),
  esaCreate: (id, siteId, site, r) =>
    request(`/aliyun-esa/${id}/sites/${siteId}/records?site=${encodeURIComponent(site)}`, {
      method: 'POST',
      body: JSON.stringify(r),
    }),
  esaUpdate: (id, siteId, site, rid, r) =>
    request(`/aliyun-esa/${id}/sites/${siteId}/records/${rid}?site=${encodeURIComponent(site)}`, {
      method: 'PATCH',
      body: JSON.stringify(r),
    }),
  esaDelete: (id, siteId, site, rid, meta) =>
    request(`/aliyun-esa/${id}/sites/${siteId}/records/${rid}?site=${encodeURIComponent(site)}`, {
      method: 'DELETE',
      body: JSON.stringify(meta || {}),
    }),
  esaProxy: (id, siteId, site, rid, proxied) =>
    request(`/aliyun-esa/${id}/sites/${siteId}/records/${rid}/proxy?site=${encodeURIComponent(site)}`, {
      method: 'PATCH',
      body: JSON.stringify({ proxied }),
    }),

  // 工具
  logs: (limit = 100) => request(`/logs?limit=${limit}`),
  dnsLookup: (type, name, content) => {
    const q = new URLSearchParams({ type, name });
    if (content) q.set('content', content);
    return request(`/tools/dns-lookup?${q}`);
  },
};
