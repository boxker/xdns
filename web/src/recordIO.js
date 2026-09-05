// 记录导入 / 导出的纯函数逻辑（无依赖，可被 Node 直接测试）

const VALID_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'CAA', 'SRV', 'PTR'];
const CAN_PROXY = ['A', 'AAAA', 'CNAME'];

// ---------- CSV ----------

// 把一行 CSV 拆成字段：支持双引号包裹、引号内逗号、"" 转义
export function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADER = ['type', 'name', 'content', 'ttl', 'proxied', 'line', 'mx', 'remark'];

// ---------- 解析入口 ----------

// text -> { records: [...], errors: [...] }
// 每条 record: { type, name, content, ttl, proxied, line, mx, _dup }
// _dup=true 表示与当前已有记录重复（type+name+content 相同），UI 会置灰
export function parseRecordsText(text, existing = []) {
  // 先剥掉开头的 UTF-8 BOM 再 trim：本工具导出的 CSV 自带 BOM（见 toCsvExport），
  // 不处理的话表头首列会变成 \uFEFFtype，导致列识别失败、导出文件无法再导入
  const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) throw new Error('文件内容为空');

  let rawList;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    rawList = parseJson(trimmed);
  } else {
    rawList = parseCsv(trimmed);
  }

  const dupKey = (r) => `${r.type}|${r.name}|${r.content}`;
  const existSet = new Set(existing.map(dupKey));
  const seen = new Set();

  const records = [];
  const errors = [];
  rawList.forEach((row, i) => {
    const lineNo = i + 1;
    try {
      const rec = normalizeRow(row);
      if (!rec) {
        errors.push(`第 ${lineNo} 行：缺少必要字段（type / name / content）`);
        return;
      }
      if (!VALID_TYPES.includes(rec.type)) {
        errors.push(`第 ${lineNo} 行：不支持的类型 ${rec.type}`);
        return;
      }
      if (!CAN_PROXY.includes(rec.type)) rec.proxied = false;
      rec._dup = existSet.has(dupKey(rec)) || seen.has(dupKey(rec));
      seen.add(dupKey(rec));
      records.push(rec);
    } catch (e) {
      errors.push(`第 ${lineNo} 行：${e.message}`);
    }
  });
  return { records, errors };
}

function normalizeRow(row) {
  if (typeof row !== 'object' || row == null) return null;
  const type = str(row.type).toUpperCase();
  const name = str(row.name);
  const content = str(row.content);
  if (!type || !name || !content) return null;

  let ttl = Number(row.ttl);
  if (!Number.isFinite(ttl) || ttl <= 0) ttl = null; // null = 留空，导入时按默认处理

  let proxied = row.proxied;
  if (typeof proxied === 'string') proxied = ['true', '1', 'yes', '是'].includes(proxied.toLowerCase());

  let mx = row.mx;
  mx = mx == null || mx === '' ? null : Number(mx);
  if (mx != null && !Number.isFinite(mx)) mx = null;

  return { type, name, content, ttl, proxied: !!proxied, line: str(row.line) || '默认', mx, remark: str(row.remark).slice(0, 200) };
}

function str(v) {
  return v == null ? '' : String(v).trim();
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSON 解析失败，请检查文件格式');
  }
  // 支持直接数组、{ records: [...] }、{ zones: { example.com: [...] } }（xDNS 导出格式）
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.records)) return data.records;
  if (data?.zones && typeof data.zones === 'object') {
    const list = [];
    for (const [zone, recs] of Object.entries(data.zones)) {
      for (const r of recs || []) list.push({ ...r, zone: r.zone || zone });
    }
    return list;
  }
  throw new Error('JSON 结构无法识别，需要数组、{records:[...]} 或 {zones:{...}}');
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('CSV 至少需要表头和一行数据');
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  if (!header.includes('type') || !header.includes('name') || !header.includes('content')) {
    throw new Error('CSV 表头需要包含 type、name、content 列');
  }
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => (row[h] = vals[i] ?? ''));
    return row;
  });
}

// ---------- 序列化导出 ----------

export function toJsonExport(records, domain) {
  return JSON.stringify({ domain, records }, null, 2);
}

export function toZonesExport(zonesMap) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), zones: zonesMap }, null, 2);
}

export function toCsvExport(records) {
  const head = CSV_HEADER.join(',');
  const rows = records.map((r) =>
    [r.type, r.name, r.content, r.ttl ?? '', r.proxied ? 'true' : 'false', r.line ?? '', r.mx ?? '', r.remark ?? '']
      .map(csvEscape)
      .join(',')
  );
  // 前置 UTF-8 BOM：Excel 双击打开 CSV 时靠它识别 UTF-8，否则中文备注会乱码；
  // 导入侧 parseRecordsText 已兼容剥掉该前缀
  return '\uFEFF' + [head, ...rows].join('\n');
}

// ---------- 下载 / 读文件 ----------

export function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}

export { CSV_HEADER };
