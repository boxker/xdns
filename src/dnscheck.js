// DNS 生效检测：用公共递归解析器查询记录的实际解析结果
import dns from 'node:dns/promises';

const RESOLVERS = ['1.1.1.1', '8.8.8.8'];

function resolverFor(type) {
  const r = new dns.Resolver({ timeout: 3000, tries: 2 });
  r.setServers(RESOLVERS);
  switch (type) {
    case 'A': return async (n) => (await r.resolve4(n)).map(String);
    case 'AAAA': return async (n) => (await r.resolve6(n)).map(String);
    case 'CNAME': return async (n) => (await r.resolveCname(n)).map(String);
    case 'MX': return async (n) => (await r.resolveMx(n)).map((e) => `${e.priority} ${e.exchange}`);
    case 'TXT': return async (n) => (await r.resolveTxt(n)).map((chunks) => chunks.join(''));
    case 'NS': return async (n) => (await r.resolveNs(n)).map(String);
    case 'SRV': return async (n) => (await r.resolveSrv(n)).map((e) => `${e.priority} ${e.weight} ${e.port} ${e.name}`);
    case 'CAA': return async (n) => (await r.resolveCaa(n)).map((e) => `${e.critical ? 'issue' : 'issuewild'} "${e.value}"`);
    default: return null; // SOA/PTR 等不检测
  }
}

export async function lookup(type, name) {
  const resolve = resolverFor(String(type || '').toUpperCase());
  if (!resolve) return { supported: false, values: [] };
  try {
    const values = await resolve(name);
    return { supported: true, values };
  } catch (e) {
    // 未解析到（ENODATA / NOTFOUND）视为已生效但无记录，网络错误视为失败
    if (e.code === 'ENODATA' || e.code === 'ENOTFOUND') return { supported: true, values: [] };
    return { supported: true, values: [], error: e.code || e.message };
  }
}

// 对比 DNSPod/Cloudflare 上配置的值与公网解析值
export function matchValues(configured, resolved) {
  const norm = (v) => String(v).trim().replace(/\.$/, '').toLowerCase();
  const target = norm(configured);
  return resolved.some((v) => norm(v) === target || norm(v).endsWith(` ${target}`));
}
