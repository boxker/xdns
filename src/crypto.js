// 账户 Token 静态加密（AES-256-GCM）
// 主密钥来源（按优先级）：
//   1. 环境变量 XDNS_SECRET（推荐，任意字符串，内部派生为 32 字节密钥）
//   2. data/.secret.key 自动生成的随机密钥（保护级别有限：密钥与数据库同盘）
// 兼容历史数据：解密时遇到无前缀的明文原样返回，下次更新账户时自动转为密文。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = 'enc:v1:'; // 版本前缀：将来更换算法时可平滑迁移

let key = null;

function loadKey() {
  if (key) return key;
  const env = process.env.XDNS_SECRET;
  if (env) {
    key = createHash('sha256').update(env).digest();
    return key;
  }
  const file = path.join(__dirname, '..', 'data', '.secret.key');
  try {
    const raw = fs.readFileSync(file);
    if (raw.length === 32) {
      key = raw;
      return key;
    }
  } catch {
    /* 文件不存在：下面创建 */
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const gen = randomBytes(32);
    fs.writeFileSync(file, gen, { mode: 0o600 });
    key = gen;
    console.warn('[安全提示] 未设置 XDNS_SECRET，已生成随机主密钥保存到 data/.secret.key');
    console.warn('[安全提示] 建议通过环境变量 XDNS_SECRET 指定主密钥（见 README「安全模型」）');
  } catch (e) {
    throw new Error(`无法加载/创建 Token 加密主密钥: ${e.message}`);
  }
  return key;
}

export function encrypt(plain) {
  if (plain == null || plain === '') return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, data]).toString('base64');
}

export function decrypt(stored) {
  if (stored == null || stored === '') return stored;
  if (!String(stored).startsWith(PREFIX)) return stored; // 历史明文：原样返回
  try {
    const raw = Buffer.from(String(stored).slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', loadKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // 密钥不匹配 / 数据损坏：返回空串，后续 API 调用会报 Token 无效
    return '';
  }
}
