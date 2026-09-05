// 生成 PWA / favicon 全套 PNG 图标（无第三方依赖，构建时执行）
// 设计与页面 logo 一致：135° 渐变圆角方块 + 白色地球线稿（圆 + 赤道 + 经线）
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');

// ---------- PNG 编码（RGBA，zlib 为 Node 内置） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const stride = w * 4 + 1; // 每行行首加 1 字节滤镜类型 0
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 光栅化（viewBox 24 坐标系，4x 超采样抗锯齿） ----------
const G1 = [91, 91, 214]; // #5b5bd6
const G2 = [156, 91, 214]; // #9c5bd6
const HALF_STROKE = 0.95; // 描边半宽（总宽 1.9，同页面 logo stroke-width 2）
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (d, half) => clamp01(half + 0.5 - Math.abs(d)); // 距离场转边缘平滑覆盖

// 地球线稿三要素的近似距离场（外圈 r8 / 赤道 4→20 / 经线椭圆 3.2x8）
function strokeCoverage(x, y) {
  const dCircle = Math.hypot(x - 12, y - 12) - 8; // 外圈
  const dx = x < 4 ? 4 - x : x > 20 ? x - 20 : 0; // 赤道（4→20 水平线）
  const dLine = Math.hypot(dx, y - 12);
  const q = Math.hypot((x - 12) / 3.2, (y - 12) / 8); // 经线（椭圆 rx3.2 ry8）
  const dEllipse = (q - 1) * 3.2;
  return Math.max(smooth(dCircle, HALF_STROKE), smooth(dLine, HALF_STROKE), smooth(dEllipse, HALF_STROKE));
}

function render(size, bleed) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  const rRect = bleed ? 0 : 5.5; // 出血版（maskable / 苹果触屏图标）不带圆角
  const n = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 24;
          const y = ((py + (sy + 0.5) / SS) / size) * 24;
          // 圆角矩形（SDF）：四角之外透明
          const cx = Math.max(Math.abs(x - 12) - (12 - rRect), 0);
          const cy = Math.max(Math.abs(y - 12) - (12 - rRect), 0);
          const inside = Math.hypot(cx, cy) <= rRect;
          if (!inside) continue;
          a += 1;
          const t = clamp01((x + y) / 48); // 135° 渐变
          const cov = strokeCoverage(x, y);
          r += G1[0] + (G2[0] - G1[0]) * t + (255 - (G1[0] + (G2[0] - G1[0]) * t)) * cov;
          g += G1[1] + (G2[1] - G1[1]) * t + (255 - (G1[1] + (G2[1] - G1[1]) * t)) * cov;
          b += G1[2] + (G2[2] - G1[2]) * t + (255 - (G1[2] + (G2[2] - G1[2]) * t)) * cov;
        }
      }
      const i = (py * size + px) * 4;
      buf[i] = Math.round(r / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(b / n);
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, size, buf);
}

mkdirSync(OUT_DIR, { recursive: true });
const variants = [
  ['icon-16.png', 16, false], // 浏览器标签 favicon 兜底
  ['icon-32.png', 32, false],
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true], // 全出血，Android 圆形裁剪安全
  ['apple-touch-icon.png', 180, true], // iOS 主屏图标
];
for (const [name, size, bleed] of variants) {
  writeFileSync(path.join(OUT_DIR, name), render(size, bleed));
  console.log(`[gen-icons] ${name} (${size}x${size})`);
}
