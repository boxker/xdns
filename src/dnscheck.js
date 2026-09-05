// DNS 生效检测：用公共递归解析器查询记录的实际解析结果
import dns from 'node:dns/promises';

// 递归服务器需可配置：国内环境直连 1.1.1.1/8.8.8.8 常超时，故默认前两个用国内可达的
// 公共 DNS 兜底再回落海外；Node Resolver 按列表顺序自动尝试，无需额外竞速逻辑。
const RESOLVERS = (process.env.XDNS_RESOLVERS || '223.5.5.5,119.29.29.29,1.1.1.1,8.8.8.8')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Node 的 resolveCaa 返回 [{ critical, issue?, issuewild?, iodef? }]：字段名即 CAA tag、
// 值为 CA 域名字符串（不存在统一的 value 字段），且同一条记录对象可能同时带多个 tag。
// 这里逐个展开为 ESA/通用 content 格式 `0 issue "ca.com"`，供 matchValues 精确比对。
export function formatCaaRecords(list) {
  return (list || []).flatMap((e) =>
    ['issue', 'issuewild', 'iodef']
      .filter((t) => e[t])
      .map((t) => {
        // 防御性写法：个别平台可能把值解析成字符串数组，引用前先归一为字符串
        const v = Array.isArray(e[t]) ? e[t].join('') : e[t];
        return `${e.critical} ${t} "${v}"`;
      })
  );
}

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
    case 'CAA': return async (n) => formatCaaRecords(await r.resolveCaa(n));
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
