// DNS 记录字段校验（服务端，写入前统一拦截）
// 原则：格式错误给出可操作的中文提示；服务商特有限制（套餐 TTL 下限等）交给上游 API 报错。
import net from 'node:net';

const TYPE_RE = /^[A-Z0-9]{1,16}$/;

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

// 主机名：支持 @（根域）、* 通配、单标签（DNSPod 子域）与完整域名
export function isValidHostname(name) {
  const s = String(name || '').trim().replace(/\.$/, '');
  if (!s || s === '@') return s === '@';
  if (s.length > 253) return false;
  return s.split('.').every((label) => label === '*' || /^[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?$/.test(label));
}

export function validateCommonRecord(r, { partial = false, provider = '' } = {}) {
  if (!r || typeof r !== 'object') throw bad('请求体缺少记录数据');
  const { type, name, content, ttl, mx, proxied, line, remark } = r;

  if (type != null) {
    if (!TYPE_RE.test(String(type))) throw bad(`记录类型无效：${type}`);
  } else if (!partial) {
    throw bad('缺少记录类型');
  }

  if (name != null) {
    if (!isValidHostname(name)) throw bad(`主机名格式无效：${name}。仅允许字母、数字、-、_、*（通配）与 . 分隔，且不能以 - 开头/结尾`);
  } else if (!partial) {
    throw bad('缺少主机名');
  }

  if (content != null) {
    const t = String(type || '').toUpperCase();
    const v = String(content).trim();
    if (!v) throw bad('记录值不能为空');
    if (t === 'A' && net.isIP(v) !== 4) throw bad(`A 记录的值必须是 IPv4 地址，当前为：${v}`);
    if (t === 'AAAA' && net.isIP(v) !== 6) throw bad(`AAAA 记录的值必须是 IPv6 地址，当前为：${v}`);
    if (t === 'CNAME' || t === 'NS' || t === 'MX') {
      const target = v.replace(/\s.*$/, '');
      if (net.isIP(target) || !isValidHostname(target)) {
        throw bad(`${t} 记录的值必须是域名（${t === 'MX' ? '如 mx.example.com' : '如 target.example.com'}），不能是 IP，当前为：${v}`);
      }
    }
    if (t === 'CAA' && !/^\s*\d+\s+(issue|issuewild|iodef)\s+"[^"]*"\s*(;.*)?$/i.test(v)) {
      throw bad(`CAA 记录的值格式应为「标志 标签 "值"」，例如：0 issue "letsencrypt.org"，当前为：${v}`);
    }
    if (v.length > 4000) throw bad('记录值过长（超过 4000 字符）');
  } else if (!partial) {
    throw bad('缺少记录值');
  }

  if (ttl != null && ttl !== '') {
    const n = Number(ttl);
    if (!Number.isInteger(n) || n < 1 || n > 604800) throw bad(`TTL 必须是 1~604800 的整数秒（Cloudflare 1 = 自动），当前为：${ttl}`);
  }

  if (mx != null && mx !== '') {
    const n = Number(mx);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw bad(`MX 优先级必须是 0~65535 的整数，当前为：${mx}`);
  }

  if (line != null) {
    const s = String(line).trim();
    if (!s) throw bad('线路不能为空（如不确定请填「默认」）');
    if (s.length > 50) throw bad('线路名过长');
  }

  if (remark != null) {
    // ESA 的备注上限比其它服务商低，超长会被上游拒绝
    const max = provider === 'aliyun-esa' ? 50 : 200;
    if (String(remark).length > max) throw bad(`备注最长 ${max} 字符`);
  }

  if (proxied != null && typeof proxied !== 'boolean') throw bad('proxied 必须是布尔值');

  return true;
}
