// 阿里云 ESA（边缘安全加速）RPC API 客户端
// 认证：AccessKey（AccessKeyId,AccessKeySecret），ACS3-HMAC-SHA256 请求签名
// 端点默认中国站 cn-hangzhou；国际站账号可设置 XDNS_ESA_ENDPOINT（如 esa.ap-southeast-1.aliyuncs.com）
import { createHash, createHmac, randomUUID } from 'node:crypto';

const VERSION = '2024-09-10';
const ENDPOINT = process.env.XDNS_ESA_ENDPOINT || 'esa.cn-hangzhou.aliyuncs.com';
const USER_AGENT = 'xDNS/1.0.0';

// 可开启代理加速的记录类型（对应 ESA 的 Proxied 字段，语义同 Cloudflare 云朵）
const PROXY_TYPES = new Set(['A', 'AAAA', 'CNAME']);
// 优先级存放在 Data.Priority 的记录类型
const PRIORITY_TYPES = new Set(['MX', 'SRV', 'URI']);
// Proxied=true 时 ESA 要求同时给出加速业务场景（web / api / image_video）
const DEFAULT_BIZ_NAME = 'web';
// UpdateRecord 为全量语义，这些顶层配置不回传就会被上游重置
const PRESERVED_PARAMS = ['SourceType', 'BizName', 'HostPolicy', 'AuthConf'];

// ---------- 凭证 ----------
// 存储格式与 DNSPod 的「数字ID,Token」同风格：「AccessKeyId,AccessKeySecret」
export function normalizeToken(raw) {
  return String(raw || '').trim().replace(/，/g, ',').replace(/\s+/g, '');
}

export function isValidToken(raw) {
  return /^[A-Za-z0-9]+,[A-Za-z0-9]+$/.test(normalizeToken(raw));
}

export function parseCredentials(raw) {
  const t = normalizeToken(raw);
  const i = t.indexOf(',');
  if (i <= 0) return {};
  return { accessKeyId: t.slice(0, i), accessKeySecret: t.slice(i + 1) };
}

// ---------- 请求签名（ACS3-HMAC-SHA256，与官方 SDK 实现一致） ----------
function acsEncode(v) {
  return encodeURIComponent(String(v))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function utcTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

// 签名用规范化查询串：键排序、值 acsEncode（键本身不含保留字符）
function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${acsEncode(params[k])}`)
    .join('&');
}

// 实际发送的查询串 / 表单体（encodeURIComponent 与官方 querystring.stringify 一致）
function encodeParams(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function explainEsaError(code, msg) {
  const map = {
    InvalidAccessKeyId: 'AccessKeyId 不存在，请检查是否复制完整（24 位，通常以 LTAI 开头）',
    SignatureDoesNotMatch: '签名不匹配，请检查 AccessKeySecret 是否正确',
    Forbidden: '无权访问 ESA，请确认 AccessKey 已授予 ESA 权限（如 AliyunESAFullAccess）',
    MissingParameter: '缺少必填参数',
    InvalidParameter: '参数无效',
    Throttling: 'ESA 接口调用频率超限，请稍后再试',
  };
  const hint = map[code];
  return hint ? `${msg}（${hint}）` : msg;
}

async function esaRequest(account, action, params = {}, { method = 'GET' } = {}) {
  const { accessKeyId, accessKeySecret } = parseCredentials(account?.token);
  if (!accessKeyId || !accessKeySecret) {
    throw badRequest('阿里云 ESA 凭证无效，应为「AccessKeyId,AccessKeySecret」');
  }

  // RPC 风格：GET 参数放查询串，POST 参数放表单体
  // 嵌套对象（Data / AuthConf）按 SDK 的 style:json 序列化为 JSON 字符串再当普通参数发送
  const flat = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    flat[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  const query = method === 'GET' ? canonicalQuery(flat) : '';
  const body = method === 'POST' ? encodeParams(flat) : null;

  const headers = {
    host: ENDPOINT,
    'x-acs-action': action,
    'x-acs-version': VERSION,
    'x-acs-date': utcTimestamp(),
    'x-acs-signature-nonce': randomUUID().replace(/-/g, ''),
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
  if (body != null) headers['content-type'] = 'application/x-www-form-urlencoded';
  const payloadHash = sha256Hex(body ?? '');
  headers['x-acs-content-sha256'] = payloadHash;

  // 参与签名：host + 实际存在的 content-type + 全部 x-acs-*（小写排序）
  // GET 请求没有 content-type，不能凭空签名一个不存在的头
  const signed = Object.keys(headers)
    .filter((k) => k === 'host' || k === 'content-type' || k.startsWith('x-acs-'))
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = signed.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
  const canonicalRequest = [
    method,
    '/',
    query,
    canonicalHeaders,
    signed.join(';'),
    payloadHash,
  ].join('\n');
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = createHmac('sha256', accessKeySecret).update(stringToSign).digest('hex');
  headers['authorization'] =
    `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signed.join(';')},Signature=${signature}`;

  const url = `https://${ENDPOINT}/${query ? `?${query}` : ''}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ?? undefined });
  } catch (e) {
    const err = new Error(`无法连接阿里云 ESA：${e.message}`);
    err.status = 502;
    throw err;
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`ESA 返回异常（HTTP ${res.status}）`);
    err.status = 502;
    throw err;
  }
  if (!res.ok) {
    const code = data.Code || data.code || '';
    const msg = data.Message || data.message || `ESA API 错误（HTTP ${res.status}）`;
    const err = new Error(explainEsaError(code, msg));
    err.status = res.status >= 400 && res.status < 500 ? 400 : 502;
    throw err;
  }
  return data;
}

// 原始响应字段大小写做一层兼容，避免上游字段风格变化导致解析失败
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

// ---------- 站点 ----------
export async function listSites(account) {
  const all = [];
  let page = 1;
  for (;;) {
    const data = await esaRequest(account, 'ListSites', { PageNumber: page, PageSize: 100 });
    const sites = pick(data, 'Sites', 'sites') || [];
    all.push(...sites);
    const total = Number(pick(data, 'TotalCount', 'totalCount') ?? 0);
    if (!sites.length || all.length >= total || page > 100) break;
    page += 1;
  }
  return all;
}

// ---------- 记录 ----------
export async function listRecords(account, siteId) {
  const all = [];
  let page = 1;
  for (;;) {
    const data = await esaRequest(account, 'ListRecords', { SiteId: siteId, PageNumber: page, PageSize: 500 });
    const records = pick(data, 'Records', 'records') || [];
    all.push(...records);
    const total = Number(pick(data, 'TotalCount', 'totalCount') ?? 0);
    if (!records.length || all.length >= total || page > 100) break;
    page += 1;
  }
  return all;
}

export async function getRecord(account, recordId) {
  const data = await esaRequest(account, 'GetRecord', { RecordId: recordId });
  return pick(data, 'RecordModel', 'recordModel') || data;
}

// CreateRecord 仅返回 { RecordId, RequestId }
export async function createRecord(account, siteId, params) {
  const data = await esaRequest(account, 'CreateRecord', { SiteId: siteId, ...params }, { method: 'POST' });
  return pick(data, 'RecordId', 'recordId');
}

// UpdateRecord 仅返回 { RequestId }，此处回读单条记录以返回最新内容
export async function updateRecord(account, recordId, params) {
  await esaRequest(account, 'UpdateRecord', { RecordId: recordId, ...params }, { method: 'POST' });
  return getRecord(account, recordId);
}

export async function removeRecord(account, recordId) {
  return esaRequest(account, 'DeleteRecord', { RecordId: recordId }, { method: 'POST' });
}

// UpdateRecord 若为全量语义只传 Proxied 会清掉记录值：
// 统一走合并式更新（回读当前记录再提交），对局部/全量两种语义都安全
export async function setProxy(account, recordId, proxied) {
  return updateRecordFields(account, recordId, { proxied });
}

// CAA 通用格式「0 issue "ca.com"」→ 结构化字段；允许值后带 ; 注释
const CAA_RE = /^\s*(\d+)\s+(issue|issuewild|iodef)\s+"?([^";]*?)"?\s*(?:;.*)?$/i;

export function parseCaaContent(content) {
  const m = String(content).match(CAA_RE);
  if (!m) return null;
  return { Flag: Number(m[1]), Tag: m[2].toLowerCase(), Value: m[3].trim() };
}

// 构造 ESA 的嵌套 Data 参数：记录值必须放在 Data.Value，不是顶层 Value
function buildData(type, content, { mx, weight, port } = {}) {
  const t = String(type || '').toUpperCase();
  const value = content == null ? '' : String(content).trim();
  if (t === 'CAA') {
    const caa = parseCaaContent(value);
    // 解析不出结构时退回原值，让上游给出明确报错，而不是静默写坏数据
    if (caa) return caa;
    return { Value: value };
  }
  const data = { Value: value };
  if (PRIORITY_TYPES.has(t)) data.Priority = Number(mx ?? 10);
  if (t === 'SRV') {
    if (weight != null) data.Weight = Number(weight);
    if (port != null) data.Port = Number(port);
  }
  return data;
}

// 把服务端返回的记录整理成统一请求参数（供全量合并更新使用）
// UpdateRecord 是全量语义：Data 必填，未回传的顶层配置会被上游重置
function toUpdateParams(r) {
  const type = pick(r, 'RecordType', 'recordType') || '';
  const data = pick(r, 'Data', 'data') || {};
  const params = {
    Type: type,
    Ttl: pick(r, 'Ttl', 'ttl') ?? 1,
    Data: { Value: data.Value ?? data.value ?? '' },
  };
  if (PROXY_TYPES.has(type)) params.Proxied = !!pick(r, 'Proxied', 'proxied');
  if (PRIORITY_TYPES.has(type)) {
    params.Data.Priority = Number(data.Priority ?? data.priority ?? 10);
  }
  // CAA 的 Flag/Tag 不回传会丢失
  if (type === 'CAA') {
    params.Data.Flag = Number(data.Flag ?? data.flag ?? 0);
    params.Data.Tag = data.Tag ?? data.tag ?? 'issue';
  }
  // SRV 的权重与端口同理
  if (type === 'SRV') {
    const weight = data.Weight ?? data.weight;
    const port = data.Port ?? data.port;
    if (weight != null) params.Data.Weight = Number(weight);
    if (port != null) params.Data.Port = Number(port);
  }
  const comment = pick(r, 'Comment', 'comment');
  if (comment) params.Comment = comment;
  // 源站类型在响应里叫 RecordSourceType，请求侧叫 SourceType
  const sourceType = pick(r, 'RecordSourceType', 'recordSourceType', 'SourceType', 'sourceType');
  if (sourceType) params.SourceType = sourceType;
  for (const key of ['BizName', 'HostPolicy', 'AuthConf']) {
    const v = pick(r, key, key[0].toLowerCase() + key.slice(1));
    if (v != null && v !== '') params[key] = v;
  }
  return params;
}

// 在回读到的原始记录上应用 common 风格 patch，返回合并后的全量请求参数（不含 RecordName）
// 单独成函数的原因：改名重建与合并更新必须共用同一条合并链路——历史上改名走
// toCommon→fromCommon 往返，fromCommon 不携带 SourceType/HostPolicy/AuthConf/BizName
// 与 SRV 的 Weight/Port，导致改名后这些配置被清空；两份字段清单必然漂移，收敛为一份
function applyPatchToParams(cur, patch = {}) {
  const merged = toUpdateParams(cur);
  if (patch.type != null) merged.Type = patch.type;
  if (patch.ttl != null) merged.Ttl = Number(patch.ttl);
  if (patch.remark != null) merged.Comment = String(patch.remark).trim();

  // 类型变化时按新类型重建 Data，避免残留旧类型的 Flag/Priority 等字段
  const typeChanged = patch.type != null && patch.type !== (pick(cur, 'RecordType', 'recordType') || '');
  if (patch.content != null || typeChanged) {
    const content = patch.content != null ? patch.content : merged.Data.Value;
    const rebuilt = buildData(merged.Type, content, {
      mx: patch.mx != null ? patch.mx : merged.Data.Priority,
      weight: merged.Data.Weight,
      port: merged.Data.Port,
    });
    merged.Data = typeChanged ? rebuilt : { ...merged.Data, ...rebuilt };
  }

  if (patch.proxied != null && PROXY_TYPES.has(merged.Type)) merged.Proxied = !!patch.proxied;
  // 类型可能被改成不可代理的类型（如 CNAME→TXT）
  if (!PROXY_TYPES.has(merged.Type)) delete merged.Proxied;
  if (PRIORITY_TYPES.has(merged.Type)) {
    if (patch.mx != null) merged.Data.Priority = Number(patch.mx);
    else if (merged.Data.Priority == null) merged.Data.Priority = 10;
  } else {
    delete merged.Data.Priority;
  }
  // 开启加速必须带业务场景，否则上游报错
  if (merged.Proxied && !merged.BizName) merged.BizName = DEFAULT_BIZ_NAME;
  if (!merged.Proxied) delete merged.BizName;
  return merged;
}

// 合并式更新：先回读记录，应用局部变更后全量提交（不依赖上游局部更新语义）
// 注意 UpdateRecord 没有 RecordName 参数，改名需删除后重建，由调用方处理
export async function updateRecordFields(account, recordId, patch = {}) {
  const cur = await getRecord(account, recordId);
  const merged = applyPatchToParams(cur, patch);
  return updateRecord(account, recordId, merged);
}

// 计算 common 记录名对应的 FQDN（根域即站点名）
function toFqdn(name, siteName) {
  const n = String(name || '').trim().replace(/\.$/, '');
  if (!n || n === '@' || n === siteName) return siteName;
  return n.endsWith(`.${siteName}`) ? n : `${n}.${siteName}`;
}

// 记录更新入口：UpdateRecord 无法修改记录名，改名时先建新记录再删旧记录
// 先建后删，中途失败不会丢记录（宁可短暂重复，也不能出现解析空档）
export async function applyRecordPatch(account, { recordId, siteId, siteName, patch = {} }) {
  const cur = await getRecord(account, recordId);
  const curName = pick(cur, 'RecordName', 'recordName') || '';
  const nextName = patch.name != null ? toFqdn(patch.name, siteName) : curName;

  if (nextName === curName) return updateRecordFields(account, recordId, patch);

  // 以当前记录为底、叠加 patch 后重建新记录：与合并更新共用 applyPatchToParams，
  // 保证 SourceType/HostPolicy/AuthConf/BizName 与 SRV Weight/Port 在改名时不丢失
  // （CreateRecord 必填 RecordName，而合并参数本身不含该字段，在此补上）
  const createParams = { ...applyPatchToParams(cur, patch), RecordName: nextName };
  const newId = await createRecord(account, siteId, createParams);
  if (!newId) throw badRequest('ESA 改名失败：新记录创建后未返回记录 ID，请刷新列表确认');
  try {
    await removeRecord(account, recordId);
  } catch (e) {
    // 新记录已建好，旧记录残留只需用户手动删一次，不应把整个操作判为失败
    const err = new Error(`记录已改名为 ${nextName}，但旧记录 ${curName} 删除失败：${e.message}，请手动删除`);
    err.status = 409;
    throw err;
  }
  return getRecord(account, newId);
}

// ---------- 统一记录字段模型 ----------
export function toCommon(r) {
  const type = pick(r, 'RecordType', 'recordType') || '';
  const data = pick(r, 'Data', 'data') || {};
  const dataValue = data.Value ?? data.value ?? '';
  let content = dataValue;
  let mx = null;
  // ESA 的 CAA 是结构化存储（Flag/Tag/Value），还原成与其它服务商一致的「0 issue "ca.com"」格式
  if (type === 'CAA') {
    content = `${data.Flag ?? data.flag ?? 0} ${data.Tag ?? data.tag ?? 'issue'} "${dataValue}"`;
  }
  if (PRIORITY_TYPES.has(type)) {
    mx = Number(data.Priority ?? data.priority ?? 10);
  }
  return {
    id: String(pick(r, 'RecordId', 'recordId')),
    provider: 'aliyun-esa',
    type,
    name: pick(r, 'RecordName', 'recordName') || '',
    content,
    // ESA 与 Cloudflare 相同：TTL = 1 表示自动
    ttl: Number(pick(r, 'Ttl', 'ttl') ?? 1) || 1,
    proxied: !!pick(r, 'Proxied', 'proxied'),
    status: 'enabled',
    line: null,
    mx,
    remark: pick(r, 'Comment', 'comment') || '',
    locked: false,
  };
}

// common 记录 -> CreateRecord 请求参数（RecordName 需要 FQDN，根域即站点名）
export function fromCommon(r, siteName) {
  const name = String(r.name || '').trim().replace(/\.$/, '');
  const recordName =
    !name || name === '@' || name === siteName
      ? siteName
      : name.endsWith(`.${siteName}`)
        ? name
        : `${name}.${siteName}`;

  const type = String(r.type || '').toUpperCase();
  const params = {
    Type: r.type,
    RecordName: recordName,
    // Ttl 在 CreateRecord 是必填参数，1 表示自动
    Ttl: r.ttl != null && r.ttl !== '' ? Number(r.ttl) : 1,
    Data: buildData(type, r.content, { mx: r.mx }),
  };
  if (r.proxied != null && PROXY_TYPES.has(type)) params.Proxied = !!r.proxied;
  // 开启加速时 ESA 要求同时给出业务场景
  if (params.Proxied) params.BizName = DEFAULT_BIZ_NAME;
  if (r.remark != null && String(r.remark).trim()) params.Comment = String(r.remark).trim();
  return params;
}
