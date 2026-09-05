# xDNS v1.1(固本)开发任务清单

> 对应 PRD §五 路线图 v1.1:D1–D9 缺陷修复 + U2/U4/U5/U8 + CI 测试。
> 预估口径:S ≈ 半小时内 / M ≈ 半天 / L ≈ 一天以上。总计约 12~16 人时。
> 执行纪律:按阶段顺序推进;每阶段结束跑 `npm test` 全绿再进入下一阶段;每个任务独立提交,提交信息带任务号。
>
> **状态(2026-09-05):全部任务已完成**。82/82 单测全绿(基线 56 → 新增 26);镜像经 docker compose 构建并部署上线(容器 `xdns`,宿主机端口 **18089**,compose 管理,线上数据完整延续);已打 tag `v1.1` 推送 Gitea。部署要点:本机端口与数据卷由 `.env`(`XDNS_PORT=18089`)与 `docker-compose.override.yml`(数据卷指向 `../data`)覆盖,两者均已 git 忽略。

---

## 阶段 0 — 前置:安全网(必须最先做)

### T0.1 核心代码落库(对应 D9)【M,无代码改动】
- **现状**:整个 ESA 对接、crypto.js、validate.js、批量编辑、全部 7 个测试文件、README 均未提交(`git status` 显示 +1240/-318)。
- **任务**:
  1. 本地跑 `npm test` 确认全绿;
  2. 按"后端适配 / 加密与校验 / 前端 / 测试 / 文档"拆成 4~5 个有意义的提交落库,推送到 Gitea main(注意核对两个 remote,历史上有丢 hooks 的坑,见团队备忘);
  3. 提交后触发 CI 确认构建通过。
- **验收**:工作区干净;远程 main 与本地一致;CI 绿。
- **为什么最先**:后面所有任务都改这些文件,不落库则无法回退、无法评审。

### T0.2 CI 纳入单元测试(对应 A2)【S】
- **文件**:`.gitea/workflows/build-push.yml`
- **改动**:在「构建镜像」步骤之前插入测试步骤(job 容器是 node:22-alpine,自带 node/npm):
  ```yaml
  - name: 安装依赖并运行测试
    run: |
      npm ci
      npm test
  ```
  测试失败自然中止后续构建与推送。
- **验收**:push 后 CI 日志可见测试执行;故意改坏一个断言验证会阻断构建(验证后还原)。

---

## 阶段 1 — 后端正确性修复(独立小改,可并行)

### T1.1 CAA 检测解析修复(对应 D2)【S】
- **文件**:`src/dnscheck.js:17`、`tests/dnscheck.test.js`(新建)
- **问题**:引用不存在的 `e.value`;Node `resolveCaa` 实际返回 `[{ critical, issue, issuewild, iodef }]`(字段名即 tag,值为 CA 域名字符串),当前代码还把 critical 当 tag 判断,CAA 检测必然"不一致"。
- **改动**:
  ```js
  case 'CAA': return async (n) => (await r.resolveCaa(n)).flatMap((e) =>
    ['issue', 'issuewild', 'iodef'].filter((t) => e[t]).map((t) => `${e.critical} ${t} "${e[t]}"`)
  );
  ```
- **测试**:新建 `tests/dnscheck.test.js`,导出并测试 `matchValues`(现有纯函数):配置 `"0 issue \"ca.com\"`" 对命中/不命中/大小写/尾点;如需测 CAA 拼接,把 flatMap 逻辑提为可导出的 `formatCaaRecords(list)` 纯函数直接测。
- **验收**:对真实 CAA 记录(`xwww.cc` 或任一有 CAA 的域)手动检测返回"已生效"。

### T1.2 编辑账户补审计(对应 D8)【S】
- **文件**:`src/routes.js:206-227`
- **改动**:`PUT /accounts/:id` 成功返回前补一行(对齐 create/delete 风格):
  ```js
  audit(req, 'account_update', `修改账户「${updated.name}」(${updated.provider})${patch.token ? ' 及凭证' : ''}`);
  ```
- **验收**:改一次账户名,日志弹窗出现"修改账户"条目。
- **注**:HTTP 层暂无测试框架(属 PRD A7 范围),本任务以手工验收为准。

### T1.3 检测递归服务器可配置 + 国内可达(对应 U8)【S】
- **文件**:`src/dnscheck.js:4`、`README.md` 环境变量表
- **改动**:
  ```js
  const RESOLVERS = (process.env.XDNS_RESOLVERS || '223.5.5.5,119.29.29.29,1.1.1.1,8.8.8.8')
    .split(',').map((s) => s.trim()).filter(Boolean);
  ```
  Node Resolver 会按服务器列表顺序尝试,无需竞速逻辑。README 补 `XDNS_RESOLVERS` 行(默认值、逗号分隔示例)。
- **验收**:`XDNS_RESOLVERS=8.8.8.8 npm start` 后检测仍工作;不设置时国内服务器环境检测不再超时。

### T1.4 Cloudflare 错误兜底 + 超时(对应 D5)【M】
- **文件**:`src/cloudflare.js:16-30`、`tests/cloudflare.test.js`(新建)
- **问题**:`fetch` 网络错误、被墙/代理返回 HTML 时,`res.json()` 抛英文 `Unexpected token...`;DNSPod(`dnspod.js:53-67`)与 ESA 均有中文包装,CF 独缺;且无超时。
- **改动**(完全对齐 dnspod.js 风格):
  ```js
  async function cfRequest(account, path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(CF_BASE + path, {
        method, headers: cfHeaders(account),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const err = new Error(`无法连接 Cloudflare:${e.name === 'TimeoutError' ? '请求超时' : e.message}`);
      err.status = 502;
      throw err;
    }
    let data;
    try {
      data = await res.json();
    } catch {
      const err = new Error(`Cloudflare 返回异常(HTTP ${res.status})`);
      err.status = 502;
      throw err;
    }
    // ……success 判断保持不变
  }
  ```
- **测试**:新建 `tests/cloudflare.test.js`,mock `globalThis.fetch`:①网络 reject → 断言 502 中文信息;②返回 HTML 文本 → 502;③`success:false` → 上游错误信息透传;④toCommon/fromCommon 现有映射补几例(顺带把 providers.test.js 未覆盖的分支补上)。
- **验收**:断网点开 CF 域名列表,toast 显示"无法连接 Cloudflare:…"而非英文堆栈。

### T1.5 ESA 改名重建保留源站配置(对应 D6)【M,本阶段最关键】
- **文件**:`src/aliyun-esa.js:301-376`、`tests/aliyun-esa-update.test.js`
- **问题根因**:改名分支(`applyRecordPatch`,`aliyun-esa.js:344-376`)走 `toCommon → fromCommon` 往返构造新记录,但 `fromCommon`(`aliyun-esa.js:410-432`)不携带 `SourceType`/`HostPolicy`/`AuthConf`/`BizName`(仅 proxied 时补默认 BizName)和 SRV 的 `Weight`/`Port` → 改名后**自定义源站配置与 SRV 参数被清空**。而 `toUpdateParams`(`aliyun-esa.js:263-297`)已正确提取这些字段,只是改名分支没用它。
- **改动**:
  1. 把 `updateRecordFields`(`aliyun-esa.js:301-333`)中"回读当前记录 → 应用 patch 到 merged"的中间逻辑提取为 `applyPatchToParams(cur, patch)`(返回合并后的请求参数,不含 RecordName);
  2. `updateRecordFields` 改为调用它后提交 `updateRecord`(行为不变);
  3. 改名分支改为:`const createParams = { ...applyPatchToParams(cur, patch), RecordName: nextName }` → `createRecord` → 删旧(保留现有"先建后删"与 409 降级逻辑不动);
  4. 顺手修复:patch 应用逻辑中原 `fromCommon` 的 Ttl 默认/remark 处理保持一致。
- **测试**(该文件已有 fetch mock 范式,照抄):
  - 用例 A:记录含 `SourceType`/`HostPolicy`/`BizName`,PATCH 改名 → 断言 CreateRecord 请求体含这三个字段且值不变;
  - 用例 B:SRV 记录(含 Weight/Port)改名 → 断言新记录 Data.Weight/Data.Port 保留;
  - 用例 C:改名同时改 content/proxied → 断言新值生效且源站字段仍保留;
  - 用例 D(回归):不改名的 PATCH 路径行为与改前一致。
- **验收**:在 ESA 上对一条已开加速(有 BizName)的记录改名,改名后加速状态与源站配置不变。

---

## 阶段 2 — 前端正确性修复

### T2.1 导入查重接线(对应 D1)【M】
- **文件**:`web/src/components/ImportRecords.vue`、`web/src/App.vue`(打开导入弹窗处)
- **问题**:`ImportRecords.vue:59` 调 `parseRecordsText(text, [])`,existing 恒为空,`recordIO.js:62-63` 的查重逻辑被架空——重复导入会真实创建重复记录。
- **改动**:
  1. ImportRecords 增加 prop `existingRecords: { type: Array, default: () => [] }`;
  2. `handleFile` 改为 `parseRecordsText(text, props.existingRecords)`(dupKey 是 `type|name|content` 精确匹配,直接传 common 记录即可);
  3. App.vue 使用处传 `:existing-records="records"`(导入弹窗打开时记录列表已加载,无需额外请求);
  4. 预览文案区分两种重复:文件内重复 vs 与线上重复(可选增强:状态列文案"文件内重复"/"已存在")——最小实现可先统一显示"重复跳过"。
- **测试**:`tests/recordIO.test.js` 已覆盖 `_dup` 标记,补一条"existing 含同 type/name/content 时标记重复"用例即可(纯函数层);接线以手工验收。
- **验收**:把当前域导出的 CSV 原样导回,预览页全部显示"重复"且导入按钮禁用(`allDup`),线上记录数不变。

### T2.2 整域检测并发池 + 限流自保护(对应 D4)【M】
- **文件**:`web/src/App.vue:278-283`、`src/routes.js:17-20`
- **问题**:`checkAllRecords` 用 `Promise.all` 全并发,>90 条记录必然触发自身 90 次/分钟限流,后半全部 429。
- **改动**(两端配合):
  1. **后端**:`routes.js:19` `LOOKUP_MAX` 从 90 提到 240(检测仅登录用户可用,滥用风险低,登录已有暴力破解限流;注释同步更新);`README.md` §安全模型"每用户每分钟 90 次"同步改;
  2. **前端**:App.vue 实现通用并发池(放 `web/src/pool.js` 纯函数,便于测试):
     ```js
     export async function runPool(items, limit, worker) // 返回与 items 对应的结果数组,worker 异常不中断整体
     ```
     `checkAllRecords` 改为 `runPool(list, 6, checkRecord)`;单条收到 429(`e.message` 含"频繁")时,该条延迟 5s 重试一次。
- **测试**:新建 `tests/pool.test.js`:并发不超 limit(用计数器断言峰值)、异常项不影响其它项、顺序无关。
- **验收**:选一个 ≥100 条记录的域点"检测",全部条目有终态(已生效/不一致/未知),无 429 toast。

### T2.3 proxied 记录检测不再误报(对应 D3)【M】
- **文件**:`web/src/App.vue:265-277`(checkRecord)、记录表格中检测状态列的渲染模板
- **问题**:已开 CDN/加速的记录,公网解析返回边缘节点 IP,与源站配置值对比必然"不一致",误导用户。
- **改动**:
  1. `checkRecord`:`if (r.proxied)` 时不传 content(`api.dnsLookup(r.type, r.name, '')`),后端 content 为空时 `matched: null`;
  2. 结果对象加 `proxied: !!r.proxied`;渲染时 proxied 记录显示两态:**"已代理 · 可解析"**(values 非空)/ **"已代理 · 无解析"**(values 空且有 error),不再显示"生效/不一致";
  3. 悬停 tooltip 文案补一句"经 CDN/边缘代理,公网返回的是代理节点地址,不与源站配置比对"。
- **验收**:对一条已开云朵的 CF 记录检测,显示"已代理 · 可解析";关闭云朵后检测恢复三态比对。
- **依赖**:T2.2 先合入(避免整域检测时新状态被打断)。

### T2.4 SRV/PTR 可编辑(对应 D7)【M】
- **文件**:`web/src/components/RecordEditor.vue:11`、`src/validate.js`、`tests/validate.test.js`
- **问题**:导入允许 9 种类型(`recordIO.js:3` 含 SRV/PTR),编辑器下拉只有 7 种,导入的 SRV/PTR 无法正确编辑。
- **改动**:
  1. RecordEditor `TYPES` 补 `'SRV', 'PTR'`(放在 NS 之后);SRV 的记录值输入框下加格式提示:`优先级 权重 端口 目标,如 0 5 5060 sip.example.com`(v1.1 不做结构化拆分,原文编辑;MX 优先级已有独立字段,SRV 的 priority 并入 content 首段,与 CF 的 content 整串语义一致);
  2. `validate.js`:SRV 用正则 `^\d+ \d+ \d+ \S+$` 校验四段;PTR 按 CNAME/NS 同样的域名格式校验;
  3. ESA 侧已知残留:`fromCommon` 创建 SRV 时不带 Weight/Port(`buildData` 仅在显式传入时携带)——**编辑路径无恙**(`toUpdateParams` 保留),新建 SRV 的 Weight/Port 缺失记入 v1.2 待办,不在本任务扩散。
- **测试**:`tests/validate.test.js` 补 SRV 合法/缺段/非数字、PTR 合法/非域名用例。
- **验收**:导入一条 SRV 后点编辑,类型下拉能选中 SRV、值正常显示,保存通过校验。

---

## 阶段 3 — 体验优化

### T3.1 CSV 导出 BOM + 导入容错(对应 U4)【S】
- **文件**:`web/src/recordIO.js:135`(parseCsv)与 `:160-168`(toCsvExport)、`tests/recordIO.test.js`
- **改动**:
  1. `toCsvExport` 返回 `'\uFEFF' + 现有内容`(Excel 双击打开中文备注不乱码);
  2. `parseRecordsText` 开头 `text = String(text||'').replace(/^\uFEFF/, '')`(否则带 BOM 的导出文件再导入时表头首列变成 `\uFEFFtype`,识别失败)。
- **测试**:往返用例改为"导出字符串 → 再解析",断言无损(自动覆盖 BOM 容错);补一条显式 BOM 前缀 CSV 解析用例。
- **验收**:导出 CSV 用 Excel 打开备注列无乱码;导出的文件重新导入预览正常。

### T3.2 批量操作失败明细可见(对应 U2)【M】
- **文件**:`web/src/App.vue:168-230`(batchDelete/batchStatus/batchProxy)、新建 `web/src/components/BatchResult.vue`
- **问题**:三个批量函数 `catch {}` 只计数,失败原因完全不可见。
- **改动**:
  1. 新建 `BatchResult.vue`:标题、`成功 N / 失败 M` 统计、失败明细滚动列表(每条 `类型 主机名:原因`)、"复制失败明细"按钮、关闭即刷新列表;
  2. 三个批量函数收集 `fails.push(\`${r.type} ${r.name}: ${e.message}\`)`;完成时若 `fail > 0` 打开 BatchResult 弹窗,否则维持现有 toast;
  3. 节流:三个循环目前无间隔(批量删除/启停/加速),顺手统一加 100ms(`await new Promise(r=>setTimeout(r,100))`),与导入/批量编辑节奏一致,降低上游限流风险;
  4. 可选收敛:`BatchEditRecords.vue` 与 `ImportRecords.vue` 的 done 态也切到 BatchResult(样式统一)——若改动大可留 v1.2。
- **验收**:构造一条会失败的记录(如把 DNSPod Token 改错后批量启停),弹窗列出该条目与人话原因,其余成功条目正常。

### T3.3 账户「测试连接」按钮(对应 U5)【M】
- **文件**:`src/routes.js`(新端点)、`web/src/api.js`、`web/src/components/AccountManager.vue`
- **改动**:
  1. 后端 `POST /api/accounts/:id/test`:按 provider 调 `cf.listZones` / `dns.listDomains` / `esa.listSites`,返回 `{ ok: true }` 或抛错(wrap 已统一转 HTTP 响应);**CF 的 listZones 同时充当凭证验证**(保存时 CF 本来就没校验,这里补齐);
  2. api.js 加 `testAccount(id)`;AccountManager 账户行加"测试连接"按钮,点击后按钮进入 loading,成功打勾、失败显示错误信息(复用现有行内错误条样式);
  3. 按钮触发的失败**不落审计**(仅显式变更落审计,与现有口径一致)。
- **验收**:三个服务商各一条账户,测试连接分别返回成功;填错 Token 的 DNSPod 账户返回"登录失败,请检查 Token…"引导文案。

---

## 阶段 4 — 回归与发布

### T4.1 全量回归 + 发布【M】
- **清单**:
  1. `npm test` 全绿(此时应含新增:dnscheck/cloudflare/pool 测试 + 扩充的 validate/recordIO/esa-update);
  2. `npm run build && npm start`,按 PRD §一 现状基线逐模块手测:登录→账户→三服务商记录 CRUD→批量→导入导出(含重复导入)→检测(单条/整域/proxied)→日志→改密;
  3. 重点回归 ESA 改名(T1.5)与整域检测(T2.2/T2.3);
  4. 打 `v1.1` 标签推送,确认 CI 测试+构建+推送镜像全绿;
  5. PRD.md 的 D1–D9、U2/U4/U5/U8 状态更新为已完成;README Roadmap 不变(本版本全是修复与体验,无新特性)。
- **验收**:线上容器升级后数据无损(SQLite 无 schema 变更,理论免迁移),冒烟通过。

---

## 任务依赖关系(执行顺序图)

```
T0.1 落库 ──► T0.2 CI测试 ──► ┬─ T1.1 CAA检测 ─┬─► T2.1 导入查重 ──► T3.1 CSV BOM
                              ├─ T1.2 补审计   ─┤
                              ├─ T1.3 递归配置 ─┼─► T2.2 检测并发池 ──► T2.3 proxied检测
                              ├─ T1.4 CF兜底   ─┤
                              └─ T1.5 ESA改名  ─┴─► T2.4 SRV/PTR编辑 ──► T3.2 批量明细 ──► T3.3 测试连接 ──► T4.1 回归发布
```
(阶段 1 五个任务相互独立可并行;阶段 2 内 T2.2 → T2.3 有依赖;其余线性仅为建议。)

## 明确不在本版本(移入 v1.2 及以后,避免范围蔓延)

- U1 虚拟滚动/分页、U3 审计日志增强、U6 Token 失效引导、U7 服务商重试退避、U9 DNSPod 启停优化;
- A3 migration、A4 备份、A6 优雅停机、A7 routes/auth/db 测试补齐;
- ESA 新建 SRV 携带 Weight/Port(见 T2.4 说明);
- BatchEdit/Import 的 done 态统一到 BatchResult(见 T3.2 第 4 点)。
