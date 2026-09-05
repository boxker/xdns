// 构建时生成 dist/sw.js：扫描最终产物生成预缓存清单（含内容哈希版本号）
// 必须在 vite build 之后执行（见 package.json 的 build 脚本）
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

// sw.js 自身不能预缓存（浏览器会自动对其做更新检查）
const files = walk(DIST).filter((f) => f !== 'sw.js');
const urls = [];
const versionHash = createHash('md5');
for (const rel of files) {
  urls.push('/' + rel.split(path.sep).join('/'));
  versionHash.update(rel);
  versionHash.update(createHash('md5').update(readFileSync(path.join(DIST, rel))).digest());
}
const VERSION = 'xdns-' + versionHash.digest('hex').slice(0, 10);

const sw = `// 本文件由 scripts/gen-sw.mjs 在构建时自动生成，请勿手改
const VERSION = ${JSON.stringify(VERSION)};
const PRECACHE = 'xdns-precache-' + VERSION;
const RUNTIME = 'xdns-runtime-' + VERSION;
const PRECACHE_URLS = ${JSON.stringify(urls, null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== PRECACHE && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 接口始终走网络，由页面自行提示错误
  if (url.pathname.startsWith('/api/')) return;

  function cachePut(res) {
    if (res.ok) {
      const copy = res.clone();
      caches.open(RUNTIME).then((c) => c.put(req, copy));
    }
    return res;
  }

  // 页面导航：网络优先，离线回退缓存的 index.html（离线可用，且更新及时）
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put('/index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || Response.error()))
    );
    return;
  }

  // 带内容哈希的构建产物：内容不可变，缓存优先
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then(cachePut))
    );
    return;
  }

  // 其余（图标 / manifest 等）：stale-while-revalidate
  event.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req).then(cachePut).catch(() => hit);
      return hit || fresh;
    })
  );
});
`;

writeFileSync(path.join(DIST, 'sw.js'), sw);
console.log(`[gen-sw] dist/sw.js：预缓存 ${urls.length} 个文件，版本 ${VERSION}`);
