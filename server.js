import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { router } from './src/routes.js';
import { authMiddleware, hashPassword } from './src/auth.js';
import * as store from './src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// 健康检查（无需登录）
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'xdns' }));

// 业务路由（除 /auth/login 外均需登录）
app.use('/api', authMiddleware, router);

// 静态资源：前端构建产物（存在时）与 SPA 回退
const dist = path.join(__dirname, 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      return res.sendFile(path.join(dist, 'index.html'));
    }
    next();
  });
}

// 首次启动：创建初始管理员账号
if (store.countUsers() === 0) {
  const pwd = process.env.XDNS_ADMIN_PASSWORD || randomBytes(6).toString('base64url');
  store.createUser('admin', hashPassword(pwd));
  console.log('\n  ───────────────────────────────────────────');
  console.log('  初始管理员账号已创建');
  console.log('  用户名: admin');
  console.log(`  密码:   ${pwd}`);
  console.log('  可通过环境变量 XDNS_ADMIN_PASSWORD 指定初始密码');
  console.log('  ───────────────────────────────────────────');
}

// 定期清理过期会话（每小时）
setInterval(() => store.deleteExpiredSessions(Date.now()), 60 * 60 * 1000).unref();

const PORT = process.env.PORT || 3090;
app.listen(PORT, () => {
  console.log(`\n  ✅ xDNS 管理平台已启动`);
  console.log(`  ➜ 本地访问: http://localhost:${PORT}\n`);
});
