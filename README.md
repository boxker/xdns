# xDNS · DNS 管理平台

自托管的轻量 DNS Web 面板，统一管理 **Cloudflare**、**DNSPod（腾讯云 DNSPod 独立版）** 与 **阿里云 ESA（边缘安全加速）** 的域名解析记录。

- 后端：Node.js 22+（Express + 内置 `node:sqlite`，除 Express 外零运行时依赖）
- 前端：Vue 3 + Vite，支持 PWA / 暗色模式 / 移动端适配
- 部署：Docker 一键运行，SQLite 单文件持久化

## 功能

**记录管理**
- 7+ 种记录类型（A / AAAA / CNAME / MX / TXT / NS / CAA …）增删改查
- Cloudflare：CDN 云朵代理一键开关、TTL 自动/手动、锁定记录保护
- DNSPod：分线路解析（电信/联通/移动…）、记录启停
- 阿里云 ESA：站点接入管理、边缘加速（Proxied）一键开关、TTL 自动/手动
- 服务端写入校验：IP 格式、域名格式、CAA 格式、TTL/MX 优先级范围，错误在到达服务商前拦截
- 备注（remark）：编辑、搜索、随 CSV/JSON 导入导出

**批量操作**：删除、启停、CDN/加速开关、批量编辑（记录值精确替换/统一设置、主机名查找替换、TTL、DNSPod 线路，任意组合 + 变更预览 + 逐条进度）

**导入导出**：JSON / CSV（带预览、重复检测、逐条进度）；CSV/JSON 可往返无损

**检测与治理**
- 公网解析生效检测（1.1.1.1 / 8.8.8.8 递归查询，逐条或整域）
- 操作审计日志（登录/改密/账户/记录变更/CDN/启停）
- 登录暴力破解限流、DNS 检测接口限流

## 快速开始

```bash
git clone <repo> && cd xdns
docker compose up -d
```

访问 `http://<host>:3090`。首次启动自动创建管理员 `admin`，随机密码打印在容器日志中（`docker logs xdns`），建议用 `XDNS_ADMIN_PASSWORD` 指定。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3090` | 监听端口 |
| `XDNS_ADMIN_PASSWORD` | 随机生成 | 首次启动创建 admin 的初始密码（仅首次生效） |
| `XDNS_SECRET` | 自动生成 | **Token 加密主密钥**，见下方「安全模型」 |
| `XDNS_TRUST_PROXY` | `loopback` | `1` = 信任所有来源的 `X-Forwarded-For`（跨容器/远程反代时设置）；默认仅信任本机回环代理 |
| `XDNS_ESA_ENDPOINT` | `esa.cn-hangzhou.aliyuncs.com` | 阿里云 ESA API 端点，国际站账号改为 `esa.ap-southeast-1.aliyuncs.com` |
| `XDNS_RESOLVERS` | `223.5.5.5,119.29.29.29,1.1.1.1,8.8.8.8` | DNS 生效检测使用的公网递归服务器，逗号分隔 IP |
| `TZ` | 系统 | 容器时区，影响日志时间戳，建议 `Asia/Shanghai` |

数据全部落在挂载的 `./data` 目录（SQLite 数据库 + 密钥文件），备份该目录即可迁移。

## 获取服务商 API 密钥

**Cloudflare**
1. 控制台 → My Profile → API Tokens → Create Token
2. 推荐模板「Edit zone DNS」，Zone Resources 限定需要的域名（最小权限）
3. 也支持 Global API Key + 邮箱（auth_type 选 key），不推荐

**DNSPod（独立版 dnsapi.cn，非腾讯云 SecretId）**
1. 控制台 → 密钥管理 → 创建 API Token
2. Token 格式为 `数字ID,Token`（英文逗号分隔），两者缺一不可
3. 常见错误：只复制了后半段、误用腾讯云 SecretId/SecretKey、账号绑定了 IP 白名单

**阿里云 ESA（边缘安全加速）**
1. 阿里云控制台 → RAM 访问控制 → 身份管理 → 用户 → 创建用户（勾选 OpenAPI 调用访问）→ 创建 AccessKey
2. 为该 RAM 用户授予 ESA 权限（推荐最小化：`AliyunESAFullAccess`，或自定义仅含 ESA 读写权限）
3. 在 xDNS 中填写 `AccessKey ID` 与 `AccessKey Secret` 两项（内部以 `ID,Secret` 加密存储）
4. 默认使用中国站端点 `esa.cn-hangzhou.aliyuncs.com`；国际站账号设置环境变量 `XDNS_ESA_ENDPOINT=esa.ap-southeast-1.aliyuncs.com`
5. ESA 记录的「加速」开关对应记录的 Proxied 字段；TTL=1 表示自动；根域名记录的主机名即站点名

## 反向代理（HTTPS）

推荐 Caddy（自动证书）：

```
dns.example.com {
    reverse_proxy 127.0.0.1:3090
}
```

Nginx：

```nginx
server {
    listen 443 ssl;
    server_name dns.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;
    location / {
        proxy_pass http://127.0.0.1:3090;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

同机反代（默认）无需额外配置；反代与 xDNS 不在同一机器/容器时，设置 `XDNS_TRUST_PROXY=1`，否则登录限流与审计日志会记录成反代 IP。HTTPS 下会话 Cookie 自动附加 `Secure` 标记。

## 安全模型

- **密码**：scrypt 加盐哈希；登录失败每 IP 15 分钟 10 次锁定；改密后所有会话失效
- **会话**：服务端存储（SQLite），HttpOnly Cookie，7 天有效，每小时清理过期
- **Token 静态加密**：账户 Token 以 AES-256-GCM 加密后落库
  - 推荐用 `XDNS_SECRET` 环境变量指定主密钥（任意字符串，内部派生 32 字节密钥）
  - 未设置时自动生成随机密钥保存到 `data/.secret.key`（与数据库同盘，仅防数据库文件单独泄露）
  - 历史明文 Token 读取时自动兼容，更新该账户后即转为密文
  - **更换主密钥后旧密文将无法解密**（Token 需重新录入），换密钥前请先记下各账户 Token
- **审计**：登录（含失败）、改密、账户增删、记录增删改、CDN/启停切换均记录用户/IP/时间
- **限流**：登录暴力破解防护；DNS 检测接口每用户每分钟 240 次

## 本地开发

```bash
npm install          # 后端依赖
cd web && npm install # 前端依赖
npm run build        # 构建前端（含 PWA 图标与 Service Worker）
npm start            # 启动 http://localhost:3090
npm test             # 单元测试（crypto / validate / providers / recordIO）
```

前端热更新开发：`cd web && npm run dev`（Vite 默认 5173 端口，API 代理见 `web/vite.config.js`）。

## Roadmap

- [ ] DDNS 动态解析（定时同步本机公网 IP 到 A/AAAA 记录）
- [ ] 解析监控告警（周期检测 + Webhook 通知）
- [ ] 跨账户/跨服务商记录复制与域名迁移
- [x] 阿里云 ESA（边缘安全加速）对接
- [ ] 更多服务商（阿里云 DNS / 华为云 / Route53）
- [ ] 多用户与只读角色

## License

MIT
