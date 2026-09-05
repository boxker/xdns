<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { api, setUnauthorizedHandler } from './api.js';
import AccountManager from './components/AccountManager.vue';
import RecordEditor from './components/RecordEditor.vue';
import ImportRecords from './components/ImportRecords.vue';
import BatchEditRecords from './components/BatchEditRecords.vue';
import BatchResult from './components/BatchResult.vue';
import { toJsonExport, toCsvExport, downloadText } from './recordIO.js';
import { runPool } from './pool.js';

// ---- 服务商定义 ----
const PROVIDERS = [
  { id: 'cloudflare', label: 'Cloudflare', color: '#f6821f' },
  { id: 'dnspod', label: 'DNSPod', color: '#00b8d4' },
  { id: 'aliyun-esa', label: '阿里云 ESA', color: '#ff6a00' },
];
const providerLabel = (p) => PROVIDERS.find((x) => x.id === p)?.label || p;
const providerColor = (p) => PROVIDERS.find((x) => x.id === p)?.color || 'var(--text-3)';

// ---- 登录态 ----
const user = ref(null);
const authChecked = ref(false);
const loginForm = reactive({ username: '', password: '' });
const loggingIn = ref(false);
const showPwd = ref(false);
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirm: '' });
const savingPwd = ref(false);

// ---- 业务态 ----
const accounts = ref([]);
const provider = ref('cloudflare');
const accountId = ref(null);
const items = ref([]); // zones / domains / ESA sites
const activeId = ref(null);
const activeName = ref('');
const records = ref([]);
const loadingItems = ref(false);
const loadingRecords = ref(false);
const syncing = ref(false); // 后台同步中（已有缓存内容展示时）
const lastSync = ref(null); // 最近一次成功同步时间戳
const search = ref('');
const typeFilter = ref(''); // '' = 全部类型
const domainSearch = ref(''); // 侧栏域名过滤
const showAccount = ref(false);
const showRecord = ref(false);
const showImport = ref(false);
const showBatchEdit = ref(false);
// 批量操作失败明细弹窗：有失败时置 { title, ok, fails }，由 BatchResult 组件展示（U2）
const batchResult = ref(null);
const showExportMenu = ref(false);
const editingRecord = ref(null);
const busyId = ref(null);
const toasts = ref([]);

// ---- 主题（暗色模式）----
// 初始值由 index.html 内联脚本根据 localStorage / 系统偏好预先设置到 <html> 上
const theme = ref(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
function applyTheme(dark) {
  theme.value = dark ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d0e14' : '#f4f5fa');
}
function toggleTheme() {
  applyTheme(theme.value !== 'dark');
  try {
    localStorage.setItem('xdns-theme', theme.value);
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}

// ---- PWA：安装 / 新版本提示 ----
const canInstall = ref(false);
let installEvent = null;
function captureInstall(e) {
  e.preventDefault(); // 阻止浏览器默认迷你横幅，改为页面内按钮触发
  installEvent = e;
  canInstall.value = true;
}
async function installApp() {
  if (!installEvent) return;
  installEvent.prompt();
  try {
    await installEvent.userChoice;
  } catch {
    /* 用户关闭了安装弹窗 */
  }
  installEvent = null;
  canInstall.value = false;
}
window.addEventListener('beforeinstallprompt', captureInstall);
window.addEventListener('appinstalled', () => {
  canInstall.value = false;
  installEvent = null;
  toast('已添加到桌面 / 主屏幕');
});
window.addEventListener('xdns-sw-update', () => toast('新版本已就绪，刷新页面后生效'));

// ---- 响应式 ----
// ≤640px 手机：记录表格换成卡片列表；≤820px 平板：隐藏 TTL / 线路列
const mobileQuery = matchMedia('(max-width: 640px)');
const isMobile = ref(mobileQuery.matches);
const compactQuery = matchMedia('(max-width: 820px)');
const isCompact = ref(compactQuery.matches);
// 顶栏溢出菜单（≤820px 显示，收纳日志/账户/改密码/退出）
const showMore = ref(false);

// ---- 批量操作 ----
const selectedIds = ref(new Set());
const batchBusy = ref(false);

// ---- DNS 生效检测 ----
const dnsResults = reactive({}); // recordId -> { state: 'checking'|'done', matched, values }

// ---- 审计日志 ----
const showLogs = ref(false);
const logs = ref([]);
const loadingLogs = ref(false);

const providerAccounts = computed(() => accounts.value.filter((a) => a.provider === provider.value));
// 当前域名出现过的记录类型，用于筛选 chips
const availableTypes = computed(() => [...new Set(records.value.map((r) => r.type))].sort());
const filteredRecords = computed(() => {
  const q = search.value.trim().toLowerCase();
  return records.value.filter((r) => {
    if (typeFilter.value && r.type !== typeFilter.value) return false;
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      r.content.toLowerCase().includes(q) ||
      r.type.toLowerCase().includes(q) ||
      (r.remark || '').toLowerCase().includes(q)
    );
  });
});
// 侧栏域名过滤
const filteredItems = computed(() => {
  const q = domainSearch.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter((i) => i.name.toLowerCase().includes(q));
});

const isCF = computed(() => provider.value === 'cloudflare');
const isESA = computed(() => provider.value === 'aliyun-esa');
// 区域型服务商（CF / ESA）：域名用 ID 定位、A/AAAA/CNAME 支持代理加速、TTL=1 表示自动、支持局部更新
const zoned = computed(() => isCF.value || isESA.value);
const canProxyType = (t) => ['A', 'AAAA', 'CNAME'].includes(t);
const isRecordOn = (r) => r.status === 'enabled' || r.status === 'enable';
// 当前域名下已开启加速的记录数（页头统计）
const proxiedCount = computed(() => records.value.filter((r) => r.proxied && canProxyType(r.type)).length);

// ---- 批量选择 ----
const selectableRecords = computed(() => filteredRecords.value.filter((r) => !r.locked));
const allSelected = computed(
  () => selectableRecords.value.length > 0 && selectableRecords.value.every((r) => selectedIds.value.has(r.id))
);
function toggleSelectAll() {
  if (allSelected.value) selectedIds.value = new Set();
  else selectedIds.value = new Set(selectableRecords.value.map((r) => r.id));
}
function toggleSelect(id) {
  const next = new Set(selectedIds.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selectedIds.value = next;
}
function clearSelection() {
  selectedIds.value = new Set();
}
const selectedRecords = computed(() => records.value.filter((r) => selectedIds.value.has(r.id)));

async function batchDelete() {
  const list = selectedRecords.value;
  if (!list.length) return;
  if (!confirm(`确定删除选中的 ${list.length} 条记录？此操作不可恢复。`)) return;
  batchBusy.value = true;
  let ok = 0;
  let fail = 0;
  const fails = []; // 收集逐条失败原因（U2：失败明细可见），供 BatchResult 弹窗展示
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    try {
      if (isCF.value) await api.cfDelete(accountId.value, activeId.value, r.id, { type: r.type, name: r.name });
      else if (isESA.value) await api.esaDelete(accountId.value, activeId.value, activeName.value, r.id, { type: r.type, name: r.name });
      else await api.dnsDelete(accountId.value, activeName.value, r.id, { type: r.type, name: r.name });
      ok += 1;
    } catch (e) {
      fail += 1;
      fails.push(`${r.type} ${r.name}: ${e.message}`);
    }
    // 轻节流：与导入/批量编辑节奏一致，避免请求过快触发服务商限流（最后一条后不多等）
    if (i < list.length - 1) await new Promise((r2) => setTimeout(r2, 100));
  }
  batchBusy.value = false;
  clearSelection();
  // 有失败时打开明细弹窗（含逐条原因），全部成功维持原 toast 汇总
  if (fail > 0) batchResult.value = { title: '批量删除结果', ok, fails };
  else toast(`批量删除完成：成功 ${ok}`, 'success');
  loadRecords();
}

async function batchStatus(next) {
  const list = selectedRecords.value;
  if (!list.length) return;
  batchBusy.value = true;
  let ok = 0;
  let fail = 0;
  const fails = []; // 同 batchDelete：收集失败原因供明细弹窗展示
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    try {
      await api.dnsStatus(accountId.value, activeName.value, r.id, next);
      ok += 1;
    } catch (e) {
      fail += 1;
      fails.push(`${r.type} ${r.name}: ${e.message}`);
    }
    if (i < list.length - 1) await new Promise((r2) => setTimeout(r2, 100));
  }
  batchBusy.value = false;
  clearSelection();
  const act = next === 'enabled' ? '启用' : '停用';
  if (fail > 0) batchResult.value = { title: `批量${act}结果`, ok, fails };
  else toast(`批量${act}完成：成功 ${ok}`, 'success');
  loadRecords();
}

async function batchProxy(proxied) {
  const list = selectedRecords.value.filter((r) => canProxyType(r.type));
  if (!list.length) return toast('选中记录中没有可加速的类型（A/AAAA/CNAME）', 'error');
  batchBusy.value = true;
  let ok = 0;
  let fail = 0;
  const fails = []; // 同 batchDelete：收集失败原因供明细弹窗展示
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    try {
      if (isCF.value) await api.cfProxy(accountId.value, activeId.value, r.id, proxied);
      else await api.esaProxy(accountId.value, activeId.value, activeName.value, r.id, proxied);
      ok += 1;
    } catch (e) {
      fail += 1;
      fails.push(`${r.type} ${r.name}: ${e.message}`);
    }
    if (i < list.length - 1) await new Promise((r2) => setTimeout(r2, 100));
  }
  batchBusy.value = false;
  clearSelection();
  const act = proxied ? '开启' : '关闭';
  if (fail > 0) batchResult.value = { title: `批量${act}加速结果`, ok, fails };
  else toast(`批量${act}加速完成：成功 ${ok}`, 'success');
  loadRecords();
}

// DNSPod 修改需要整条记录回传（Record.Modify 是全量语义）；CF/ESA 走局部字段更新
function dnsFullPayload(r, overrides = {}) {
  return {
    type: r.type,
    name: r.name,
    content: r.content,
    ttl: r.ttl ?? 600,
    line: r.line || '默认',
    mx: r.type === 'MX' ? (r.mx ?? 10) : undefined,
    remark: r.remark || '',
    ...overrides,
  };
}

// ---- 批量编辑 ----
// BatchEditRecords 逐条回传：CF/ESA 走部分字段 PATCH，DNSPod 走全量 PUT
function onBatchApply(record, changes, resolve, reject) {
  let req;
  if (isCF.value) req = api.cfUpdate(accountId.value, activeId.value, record.id, changes);
  else if (isESA.value) req = api.esaUpdate(accountId.value, activeId.value, activeName.value, record.id, changes);
  else req = api.dnsUpdate(accountId.value, activeName.value, record.id, dnsFullPayload(record, changes));
  req.then(resolve, reject);
}

function onBatchEditDone({ ok, failed }) {
  showBatchEdit.value = false;
  clearSelection();
  toast(`批量编辑完成：成功 ${ok}${failed ? `，失败 ${failed}` : ''}`, failed ? 'error' : 'success');
  loadRecords();
}

// ---- DNS 生效检测 ----
const CHECKABLE_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// retried 标记保证限流重试只做一次，避免和后端限流窗口互相等待造成无限重试
async function checkRecord(r, retried = false) {
  if (!CHECKABLE_TYPES.has(r.type)) {
    toast(`${r.type} 类型暂不支持检测`, 'error');
    return;
  }
  // proxied 字段随结果下发：模板据此区分"已代理"展示语义（可解析/无解析），而非 生效/不一致
  dnsResults[r.id] = { state: 'checking', matched: null, values: [], proxied: !!r.proxied };
  try {
    // 已代理记录的公网解析返回的是 CDN/边缘节点地址，与源站记录值必然"不一致"造成误报；
    // 因此 content 传空串，后端不比对（matched=null），只看公网能否解析出 values
    const res = await api.dnsLookup(r.type, r.name, r.proxied ? '' : r.content);
    dnsResults[r.id] = { state: 'done', matched: res.matched, values: res.values || [], error: res.error, proxied: !!r.proxied };
  } catch (e) {
    // 限流错误（提示含"频繁"）：等 5 秒让限流窗口回落，再重试一次
    if (!retried && e.message && e.message.includes('频繁')) {
      await sleep(5000);
      return checkRecord(r, true);
    }
    dnsResults[r.id] = { state: 'done', matched: null, values: [], error: e.message, proxied: !!r.proxied };
  }
}
async function checkAllRecords() {
  const list = filteredRecords.value.filter((r) => CHECKABLE_TYPES.has(r.type) && !r.locked);
  if (!list.length) return toast('没有可检测的记录', 'error');
  toast(`正在检测 ${list.length} 条记录的公网解析…`);
  // 固定并发 6：整域检测动辄上百条，Promise.all 全量并发会瞬间打爆每分钟限流窗口
  await runPool(list, 6, checkRecord);
}

// ---- 复制 / 日志 ----
async function copyContent(r) {
  try {
    await navigator.clipboard.writeText(r.content);
    toast('记录值已复制');
  } catch {
    toast('复制失败，请手动选择复制', 'error');
  }
}

async function openLogs() {
  showLogs.value = true;
  loadingLogs.value = true;
  try {
    logs.value = await api.logs(200);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    loadingLogs.value = false;
  }
}

function actionLabel(a) {
  const map = {
    login: '登录', login_failed: '登录失败', change_password: '修改密码',
    account_create: '添加账户', account_delete: '删除账户',
    record_create: '新增记录', record_update: '修改记录', record_delete: '删除记录',
  };
  return map[a] || a;
}

function logBadgeClass(a) {
  if (a === 'login_failed') return 't-caa';          // 红：失败告警
  if (a.includes('delete')) return 't-mx';            // 橙：删除类危险操作
  if (a === 'login' || a === 'change_password') return 't-txt'; // 绿：登录/改密
  return 't-a';                                       // 蓝：创建/修改类
}

function toast(msg, type = 'success') {
  const id = Date.now() + Math.random();
  toasts.value.push({ id, msg, type });
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 3200);
}

// ---- 认证 ----
async function checkAuth() {
  try {
    user.value = await api.auth.me();
  } catch {
    user.value = null;
  }
  authChecked.value = true;
  if (user.value) initMain();
}

async function doLogin() {
  if (!loginForm.username.trim() || !loginForm.password) {
    toast('请输入用户名和密码', 'error');
    return;
  }
  loggingIn.value = true;
  try {
    user.value = await api.auth.login(loginForm.username.trim(), loginForm.password);
    loginForm.password = '';
    toast('登录成功');
    initMain();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    loggingIn.value = false;
  }
}

async function doLogout() {
  try {
    await api.auth.logout();
  } catch {
    /* 忽略：会话可能已过期 */
  }
  user.value = null;
  accounts.value = [];
  items.value = [];
  records.value = [];
  activeId.value = null;
  activeName.value = '';
  accountId.value = null;
  domainSearch.value = '';
}

async function doChangePassword() {
  if (!pwdForm.oldPassword) return toast('请输入原密码', 'error');
  if (!pwdForm.newPassword || pwdForm.newPassword.length < 6) return toast('新密码至少 6 位', 'error');
  if (pwdForm.newPassword !== pwdForm.confirm) return toast('两次输入的新密码不一致', 'error');
  savingPwd.value = true;
  try {
    await api.auth.changePassword(pwdForm.oldPassword, pwdForm.newPassword);
    toast('密码已修改');
    showPwd.value = false;
    pwdForm.oldPassword = '';
    pwdForm.newPassword = '';
    pwdForm.confirm = '';
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    savingPwd.value = false;
  }
}

function selectAccount(id, nextProvider) {
  if (nextProvider && provider.value !== nextProvider) {
    provider.value = nextProvider;
    activeId.value = null;
    activeName.value = '';
    items.value = [];
    records.value = [];
    search.value = '';
  }
  accountId.value = id ?? null;
}

// ---- 业务 ----
function initMain() {
  loadAccounts().then(() => {
    const first = providerAccounts.value[0] || accounts.value[0];
    if (first) selectAccount(first.id, first.provider);
  });
}

async function loadAccounts() {
  accounts.value = await api.listAccounts();
}

async function loadItems() {
  if (!accountId.value) return;
  loadingItems.value = true;
  try {
    if (isCF.value) {
      items.value = await api.cfZones(accountId.value);
    } else if (isESA.value) {
      items.value = await api.esaSites(accountId.value);
    } else {
      items.value = await api.dnsDomains(accountId.value);
    }
    if (!items.value.find((i) => i.id === activeId.value)) {
      activeId.value = items.value[0]?.id ?? null;
      activeName.value = items.value[0]?.name ?? '';
    }
    if (activeId.value) await loadRecords();
    else records.value = [];
  } catch (e) {
    items.value = [];
    records.value = [];
    toast(e.message, 'error');
  } finally {
    loadingItems.value = false;
  }
}

// ---- 记录本地缓存（localStorage，key 随账户 + 域名）----
const recordCacheKey = computed(() =>
  accountId.value && (activeId.value || activeName.value)
    ? `xdns-rc:${accountId.value}:${activeId.value || activeName.value}`
    : ''
);

function readRecordCache() {
  if (!recordCacheKey.value) return null;
  try {
    const data = JSON.parse(localStorage.getItem(recordCacheKey.value) || 'null');
    return Array.isArray(data?.records) ? data : null;
  } catch {
    return null;
  }
}

function writeRecordCache(list) {
  if (!recordCacheKey.value || !Array.isArray(list)) return;
  try {
    localStorage.setItem(recordCacheKey.value, JSON.stringify({ ts: Date.now(), records: list }));
  } catch {
    /* localStorage 不可用 / 配额满：缓存只是优化，失败静默 */
  }
}

function fmtSyncTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

async function loadRecords() {
  if (!accountId.value || !activeId.value) return;
  // 先展示本地缓存（若有且当前无内容），再后台拉取最新数据
  const cached = readRecordCache();
  if (cached && !records.value.length) {
    records.value = cached.records;
    lastSync.value = cached.ts;
  }
  syncing.value = true;
  loadingRecords.value = !records.value.length; // 无缓存时才显示骨架屏
  try {
    let fresh;
    if (isCF.value) {
      fresh = await api.cfRecords(accountId.value, activeId.value);
    } else if (isESA.value) {
      fresh = await api.esaRecords(accountId.value, activeId.value, activeName.value);
    } else {
      fresh = await api.dnsRecords(accountId.value, activeName.value);
    }
    records.value = fresh;
    lastSync.value = Date.now();
    writeRecordCache(fresh);
  } catch (e) {
    if (cached) toast(`同步失败，正在展示本地缓存（${e.message}）`, 'error');
    else {
      records.value = [];
      toast(e.message, 'error');
    }
  } finally {
    loadingRecords.value = false;
    syncing.value = false;
  }
}

function selectItem(item) {
  activeId.value = item.id;
  activeName.value = item.name;
  typeFilter.value = '';
  records.value = [];
  loadRecords();
}

function switchProvider(p) {
  if (provider.value === p) return;
  provider.value = p;
  activeId.value = null;
  activeName.value = '';
  items.value = [];
  records.value = [];
  search.value = '';
  domainSearch.value = '';
  typeFilter.value = '';
  const first = providerAccounts.value[0];
  accountId.value = first?.id ?? null;
  if (accountId.value) loadItems();
}

watch(accountId, () => {
  activeId.value = null;
  activeName.value = '';
  items.value = [];
  records.value = [];
  typeFilter.value = '';
  loadItems();
});

// 记录列表变化（切换域名/刷新/增删）后清空勾选
watch(records, () => clearSelection());

// ---- 账户 ----
async function onAccountSave({ id, payload, onDone }) {
  try {
    if (id) {
      await api.updateAccount(id, payload);
      toast(`${providerLabel(payload.provider)} 账户已更新，凭证校验通过`);
      await loadAccounts();
      selectAccount(id, payload.provider);
      await loadItems();
    } else {
      const created = await api.createAccount(payload);
      toast(`${providerLabel(payload.provider)} 账户已添加，凭证校验通过`);
      await loadAccounts();
      selectAccount(created.id, created.provider);
      await loadItems();
    }
    onDone?.(true);
  } catch (e) {
    toast(e.message, 'error');
    onDone?.(false);
  }
}

async function onAccountDelete(acc) {
  if (!confirm(`确定删除账户「${acc.name}」？`)) return;
  try {
    await api.deleteAccount(acc.id);
    toast('账户已删除');
    await loadAccounts();
    if (accountId.value === acc.id) {
      accountId.value = providerAccounts.value[0]?.id ?? null;
    }
    if (accountId.value) loadItems();
    else {
      items.value = [];
      records.value = [];
      activeId.value = null;
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---- 记录 ----
function addRecord() {
  editingRecord.value = null;
  showRecord.value = true;
}
function editRecord(r) {
  if (r.locked) return;
  editingRecord.value = r;
  showRecord.value = true;
}

async function onRecordSave(payload) {
  try {
    if (isCF.value) {
      if (editingRecord.value) await api.cfUpdate(accountId.value, activeId.value, editingRecord.value.id, payload);
      else await api.cfCreate(accountId.value, activeId.value, payload);
    } else if (isESA.value) {
      if (editingRecord.value) await api.esaUpdate(accountId.value, activeId.value, activeName.value, editingRecord.value.id, payload);
      else await api.esaCreate(accountId.value, activeId.value, activeName.value, payload);
    } else {
      if (editingRecord.value) await api.dnsUpdate(accountId.value, activeName.value, editingRecord.value.id, payload);
      else await api.dnsCreate(accountId.value, activeName.value, payload);
    }
    showRecord.value = false;
    toast(editingRecord.value ? '记录已更新' : '记录已添加');
    loadRecords();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteRecord(r) {
  if (r.locked) return;
  if (!confirm(`确定删除记录「${r.name}」(${r.type})？`)) return;
  try {
    if (isCF.value) await api.cfDelete(accountId.value, activeId.value, r.id, { type: r.type, name: r.name });
    else if (isESA.value) await api.esaDelete(accountId.value, activeId.value, activeName.value, r.id, { type: r.type, name: r.name });
    else await api.dnsDelete(accountId.value, activeName.value, r.id, { type: r.type, name: r.name });
    toast('记录已删除');
    loadRecords();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function toggleProxy(r) {
  busyId.value = r.id;
  try {
    const updated = isCF.value
      ? await api.cfProxy(accountId.value, activeId.value, r.id, !r.proxied)
      : await api.esaProxy(accountId.value, activeId.value, activeName.value, r.id, !r.proxied);
    const idx = records.value.findIndex((x) => x.id === r.id);
    if (idx >= 0) {
      records.value[idx] = updated;
      writeRecordCache(records.value);
    }
    toast(updated.proxied ? '已开启边缘加速' : '已关闭边缘加速');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busyId.value = null;
  }
}

async function toggleStatus(r) {
  busyId.value = r.id;
  try {
    const next = isRecordOn(r) ? 'disabled' : 'enabled';
    const updated = await api.dnsStatus(accountId.value, activeName.value, r.id, next);
    const idx = records.value.findIndex((x) => x.id === r.id);
    if (idx >= 0) {
      records.value[idx] = updated;
      writeRecordCache(records.value);
    }
    toast(next === 'enabled' ? '记录已启用' : '记录已停用');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busyId.value = null;
  }
}

function refresh() {
  if (accountId.value) loadItems();
}

// ---- 导入 / 导出 ----
function exportRecords(fmt) {
  showExportMenu.value = false;
  if (!activeName.value || !filteredRecords.value.length) {
    toast('当前域名没有可导出的记录', 'error');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  if (fmt === 'csv') {
    downloadText(`${activeName.value}-records-${stamp}.csv`, toCsvExport(filteredRecords.value), 'text/csv');
  } else {
    const data = { domain: activeName.value, records: filteredRecords.value };
    downloadText(`${activeName.value}-records-${stamp}.json`, toJsonExport(data.records, data.domain));
  }
  toast(`已导出 ${filteredRecords.value.length} 条记录`);
}

async function onImportOne(record, resolve, reject) {
  const payload = { type: record.type, name: record.name, content: record.content, remark: record.remark || '' };
  if (isCF.value) {
    payload.ttl = record.ttl ?? 1;
    if (['A', 'AAAA', 'CNAME'].includes(record.type)) payload.proxied = record.proxied;
    if (record.type === 'MX') payload.mx = record.mx ?? 10;
  } else if (isESA.value) {
    payload.ttl = record.ttl ?? 1;
    if (['A', 'AAAA', 'CNAME'].includes(record.type)) payload.proxied = record.proxied;
    if (record.type === 'MX') payload.mx = record.mx ?? 10;
  } else {
    payload.ttl = record.ttl ?? 600;
    payload.line = record.line || '默认';
    if (record.type === 'MX') payload.mx = record.mx ?? 10;
  }
  try {
    if (isCF.value) await api.cfCreate(accountId.value, activeId.value, payload);
    else if (isESA.value) await api.esaCreate(accountId.value, activeId.value, activeName.value, payload);
    else await api.dnsCreate(accountId.value, activeName.value, payload);
    resolve();
  } catch (e) {
    reject(e);
  }
}

async function onImportDone() {
  showImport.value = false;
  toast('导入完成');
  await loadRecords();
}

function closeExportMenu() {
  showExportMenu.value = false;
}

onMounted(() => {
  setUnauthorizedHandler(() => {
    user.value = null;
  });
  // 用户未手动选择过主题时，跟随系统切换
  const media = matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', (e) => {
    if (!localStorage.getItem('xdns-theme')) applyTheme(e.matches);
  });
  mobileQuery.addEventListener('change', (e) => (isMobile.value = e.matches));
  compactQuery.addEventListener('change', (e) => (isCompact.value = e.matches));
  checkAuth();
});
</script>

<template>
  <div class="app">
    <!-- 登录页 -->
    <div v-if="!authChecked" class="login-page">
      <div class="login-loading">加载中…</div>
    </div>

    <div v-else-if="!user" class="login-page">
      <div class="login-decor" aria-hidden="true"></div>
      <button class="theme-toggle" @click="toggleTheme" :title="theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'">
        <svg class="icon icon-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        <svg class="icon icon-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      </button>
      <form class="login-card" @submit.prevent="doLogin">
        <div class="login-brand">
          <span class="logo"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/></svg></span>
          <div class="login-brand-text">
            <span class="login-title">xDNS</span>
            <span class="login-sub">多服务商 DNS 管理平台</span>
          </div>
        </div>
        <div class="login-field">
          <input v-model="loginForm.username" placeholder="用户名" autocomplete="username" />
        </div>
        <div class="login-field">
          <input v-model="loginForm.password" type="password" placeholder="密码" autocomplete="current-password" />
        </div>
        <button class="primary login-submit" type="submit" :disabled="loggingIn">
          {{ loggingIn ? '登录中…' : '登 录' }}
        </button>
        <div class="login-providers">
          <span v-for="p in PROVIDERS" :key="p.id" class="login-provider">
            <i class="p-dot" :style="{ background: p.color }"></i>{{ p.label }}
          </span>
        </div>
      </form>
    </div>

    <!-- 主界面 -->
    <template v-else>
      <header class="header">
        <div class="brand">
          <span class="logo"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/></svg></span>
          <span class="btn-text">xDNS</span>
        </div>

        <nav class="tabs" aria-label="服务商">
          <button
            v-for="p in PROVIDERS"
            :key="p.id"
            :class="{ active: provider === p.id }"
            @click="switchProvider(p.id)"
          >
            <i class="p-dot" :style="{ background: p.color }"></i>{{ p.label }}
          </button>
        </nav>

        <select v-if="providerAccounts.length" v-model="accountId" class="account-select">
          <option v-for="a in providerAccounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>

        <div class="spacer"></div>

        <button class="theme-toggle" @click="toggleTheme" :title="theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'">
          <svg class="icon icon-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          <svg class="icon icon-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        </button>
        <button v-if="canInstall" class="ghost" @click="installApp" title="安装到桌面 / 主屏幕">
          <svg class="icon" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg><span class="btn-text">安装</span>
        </button>
        <button class="ghost" @click="refresh" title="刷新">
          <svg class="icon" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg><span class="btn-text">刷新</span>
        </button>
        <button class="ghost hide-mobile" @click="openLogs" title="操作日志">
          <svg class="icon" viewBox="0 0 24 24"><path d="M4 5h16v14H4zM8 9h8M8 13h8M8 17h5"/></svg><span class="btn-text">日志</span>
        </button>
        <button class="hide-mobile" @click="showAccount = true">
          <svg class="icon" viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4"/><path d="M10.3 12.9 21 2m-5.5 1.5 4 4M14 8l2-2"/></svg><span class="btn-text">账户</span>
        </button>
        <button class="ghost hide-mobile" @click="showPwd = true">
          <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span class="btn-text">改密码</span>
        </button>
        <span class="user-chip hide-mobile" :title="user?.username">{{ user?.username }}</span>
        <button class="ghost hide-mobile" @click="doLogout">退出</button>

        <!-- 移动端溢出菜单：收纳次要操作 -->
        <div class="more-wrap hide-desktop">
          <button class="ghost" title="更多" @click="showMore = !showMore">
            <svg class="icon" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>
          </button>
          <div v-if="showMore" class="export-menu" @mouseleave="showMore = false">
            <button @click="openLogs(); showMore = false">操作日志</button>
            <button @click="showAccount = true; showMore = false">账户管理</button>
            <button @click="showPwd = true; showMore = false">修改密码</button>
            <button @click="doLogout(); showMore = false">退出登录</button>
          </div>
        </div>
      </header>

      <div class="body">
        <aside class="aside">
          <div class="aside-head">
            <span>{{ isESA ? '站点' : '域名' }}</span>
            <span v-if="items.length" class="aside-count">{{ items.length }}</span>
          </div>

          <div v-if="items.length > 5" class="aside-search">
            <svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg>
            <input v-model="domainSearch" placeholder="筛选…" />
          </div>

          <div v-if="!providerAccounts.length" class="empty" style="padding: 30px 16px">
            <div class="icon"><svg viewBox="0 0 24 24"><path d="M9 17H7A5 5 0 0 1 7 7h2m6 10h2a5 5 0 0 0 0-10h-2M8 12h8"/></svg></div>
            <div class="title">未配置账户</div>
            <div style="font-size: 12px">请先添加 {{ providerLabel(provider) }} 账户</div>
            <button class="primary" @click="showAccount = true">添加账户</button>
          </div>

          <div v-else class="zone-list">
            <div v-if="loadingItems" class="empty"><div class="skeleton-list"><div class="skeleton" v-for="i in 4" :key="i"></div></div></div>
            <div v-else-if="!items.length" class="empty">
              <div class="icon"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg></div>
              <div class="title">暂无{{ isESA ? '站点' : '域名' }}</div>
              <div style="font-size: 12px">{{ isCF ? '该账户下没有可用区域' : isESA ? '该账户下没有 ESA 站点' : '该账户下没有域名' }}</div>
            </div>
            <div
              v-for="item in filteredItems"
              :key="item.id"
              class="zone-item"
              :class="{ active: item.id === activeId }"
              @click="selectItem(item)"
            >
              <span class="zone-name">{{ item.name }}</span>
              <span class="zone-dot" :class="{ ok: item.status === 'active' || item.status === 'enable' }"></span>
            </div>
            <div v-if="!filteredItems.length && domainSearch" class="empty" style="padding: 20px"><div style="font-size: 12px">无匹配结果</div></div>
          </div>
        </aside>

        <main class="main">
          <div class="page-head">
            <div class="page-head-row">
              <div class="domain-block" v-if="activeName">
                <div class="domain-title">{{ activeName }}</div>
                <span
                  v-if="records.length && !loadingRecords"
                  class="count-chip"
                  :title="lastSync ? `最后同步 ${fmtSyncTime(lastSync)}` : undefined"
                >
                  {{ filteredRecords.length === records.length ? records.length : filteredRecords.length + ' / ' + records.length }} 条
                </span>
                <span v-if="zoned && proxiedCount" class="accent-chip">{{ proxiedCount }} 加速中</span>
                <span v-if="syncing" class="sync-chip" role="status">
                  <span class="sync-spin"></span>同步中
                </span>
              </div>
              <div class="domain-title muted" v-else>记录管理</div>
              <div class="spacer"></div>
              <button v-if="activeId" class="ghost" @click="checkAllRecords" title="检测公网解析是否与配置一致">
                <svg class="icon" viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg><span class="btn-text">检测</span>
              </button>
              <div class="export-wrap" v-if="activeId" @mouseleave="closeExportMenu">
                <button :disabled="!filteredRecords.length" @click="showExportMenu = !showExportMenu" title="导出当前域名记录">
                  <svg class="icon" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg><span class="btn-text">导出</span>
                </button>
                <div v-if="showExportMenu" class="export-menu">
                  <button @click="exportRecords('json')">JSON 格式</button>
                  <button @click="exportRecords('csv')">CSV 格式</button>
                </div>
              </div>
              <button :disabled="!activeId" @click="showImport = true" title="从 JSON/CSV 文件导入记录">
                <svg class="icon" viewBox="0 0 24 24"><path d="M12 15V3m0 0 4 4m-4-4L8 7M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg><span class="btn-text">导入</span>
              </button>
              <button class="primary" :disabled="!activeId" @click="addRecord">
                <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14m-7-7h14"/></svg>添加记录
              </button>
            </div>

            <div class="page-head-row filter-row" v-if="activeId">
              <div class="search-wrap">
                <svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg>
                <input v-model="search" class="search" placeholder="搜索主机名 / 记录值…" />
              </div>
              <div class="type-chips" v-if="availableTypes.length">
                <button class="chip" :class="{ active: !typeFilter }" @click="typeFilter = ''">全部</button>
                <button
                  v-for="t in availableTypes"
                  :key="t"
                  class="chip"
                  :class="{ active: typeFilter === t }"
                  @click="typeFilter = typeFilter === t ? '' : t"
                >
                  {{ t }}
                </button>
              </div>
            </div>
          </div>

          <div v-if="selectedIds.size" class="batch-bar">
            <span>已选 <b>{{ selectedIds.size }}</b> 条</span>
            <button class="primary" :disabled="batchBusy" @click="zoned ? batchProxy(true) : batchStatus('enabled')">
              {{ zoned ? '批量开启加速' : '批量启用' }}
            </button>
            <button :disabled="batchBusy" @click="zoned ? batchProxy(false) : batchStatus('disabled')">
              {{ zoned ? '批量关闭加速' : '批量停用' }}
            </button>
            <button class="ghost" :disabled="batchBusy" @click="showBatchEdit = true" title="批量修改记录值 / 主机名 / TTL / 线路">
              批量编辑
            </button>
            <button class="danger" :disabled="batchBusy" @click="batchDelete">批量删除</button>
            <div class="spacer"></div>
            <button class="ghost" @click="clearSelection">取消选择</button>
          </div>

          <div class="table-wrap">
            <div v-if="!activeId" class="empty" style="height: 60%">
              <div class="icon"><svg viewBox="0 0 24 24"><path d="M9 11V6a3 3 0 0 1 6 0v5m-9 0h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z"/></svg></div>
              <div class="title">请选择一个{{ isESA ? '站点' : '域名' }}</div>
            </div>

            <div v-else-if="loadingRecords" class="empty" style="height: 60%">
              <div class="skeleton-list">
                <div class="skeleton" v-for="i in 5" :key="i"></div>
              </div>
            </div>

            <div v-else-if="!filteredRecords.length" class="empty" style="height: 60%">
              <div class="icon"><svg viewBox="0 0 24 24"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg></div>
              <div class="title">{{ search ? '未找到匹配记录' : '暂无记录' }}</div>
              <button class="primary" v-if="!search" @click="addRecord">+ 添加第一条记录</button>
            </div>

            <table v-else-if="!isMobile" class="records-table">
              <colgroup>
                <col style="width: 40px" />
                <col style="width: 80px" />
                <col style="width: 200px" />
                <col />
                <col v-if="!isCompact" style="width: 64px" />
                <col v-if="!zoned && !isCompact" style="width: 72px" />
                <col style="width: 104px" />
                <col style="width: 80px" />
                <col style="width: 124px" />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" title="全选" />
                  </th>
                  <th>类型</th>
                  <th>主机名</th>
                  <th>记录值</th>
                  <th v-if="!isCompact">TTL</th>
                  <th v-if="!zoned && !isCompact">线路</th>
                  <th v-if="zoned">加速</th>
                  <th v-else>状态</th>
                  <th>解析</th>
                  <th style="text-align: right">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in filteredRecords" :key="r.id" :class="{ selected: selectedIds.has(r.id) }">
                  <td><input type="checkbox" :disabled="r.locked" :checked="selectedIds.has(r.id)" @change="toggleSelect(r.id)" /></td>
                  <td><span class="type-badge" :class="'t-' + r.type.toLowerCase()">{{ r.type }}</span></td>
                  <td>
                    <div class="record-name" :title="r.remark ? r.name + ' · ' + r.remark : r.name">
                      {{ r.name }}
                      <svg v-if="r.locked" class="icon muted" style="width: 12px; height: 12px" title="由服务商托管，不可编辑" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                    </div>
                  </td>
                  <td>
                    <div class="record-value copyable" :title="'点击复制：' + r.content" @click="copyContent(r)">
                      {{ r.content }}
                      <span v-if="r.type === 'MX' && r.mx != null" class="muted" style="font-family: inherit">（优先级 {{ r.mx }}）</span>
                    </div>
                  </td>
                  <td v-if="!isCompact" class="record-ttl">{{ zoned && r.ttl === 1 ? '自动' : r.ttl }}</td>
                  <td v-if="!zoned && !isCompact" class="record-line">{{ r.line || '默认' }}</td>
                  <td v-if="zoned">
                    <span v-if="canProxyType(r.type)" class="cdn-toggle" :class="{ on: r.proxied }" @click="!r.locked && toggleProxy(r)">
                      <input type="checkbox" :checked="r.proxied" />
                      <span class="switch"></span>
                      <span class="cdn-label">{{ r.proxied ? '加速中' : '关闭' }}</span>
                    </span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td v-else>
                    <span class="cdn-toggle status-toggle" :class="{ on: isRecordOn(r) }" @click="toggleStatus(r)">
                      <input type="checkbox" :checked="isRecordOn(r)" />
                      <span class="switch"></span>
                      <span class="cdn-label">{{ isRecordOn(r) ? '启用' : '停用' }}</span>
                    </span>
                  </td>
                  <td>
                    <span v-if="dnsResults[r.id]?.state === 'checking'" class="dns-badge checking">检测中</span>
                    <!-- 已代理记录：公网返回的是 CDN 节点地址，不与源站配置比对，只区分能否解析，避免"不一致"误报 -->
                    <span
                      v-else-if="dnsResults[r.id]?.state === 'done' && dnsResults[r.id].proxied"
                      class="dns-badge"
                      :class="(dnsResults[r.id].values || []).length ? 'ok' : 'mismatch'"
                      :title="((dnsResults[r.id].values || []).join('\n') || dnsResults[r.id].error || '公网未解析到该记录') + '\n经 CDN/边缘代理，公网返回的是代理节点地址，不与源站配置比对'"
                    >
                      {{ (dnsResults[r.id].values || []).length ? '已代理 · 可解析' : '已代理 · 无解析' }}
                    </span>
                    <span
                      v-else-if="dnsResults[r.id]?.state === 'done'"
                      class="dns-badge"
                      :class="dnsResults[r.id].matched === true ? 'ok' : dnsResults[r.id].matched === false ? 'mismatch' : 'unknown'"
                      :title="(dnsResults[r.id].values || []).join('\n') || dnsResults[r.id].error || '公网未解析到该记录'"
                    >
                      {{ dnsResults[r.id].matched === true ? '已生效' : dnsResults[r.id].matched === false ? '不一致' : '未知' }}
                    </span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td>
                    <div class="actions">
                      <button class="icon-btn" title="检测公网解析" @click="checkRecord(r)">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
                      </button>
                      <button class="icon-btn" :disabled="r.locked" title="编辑" @click="editRecord(r)">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5m-1.5-9.5a2.1 2.1 0 0 1 3 3L12 16l-4 1 1-4z"/></svg>
                      </button>
                      <button class="icon-btn danger" :disabled="r.locked" title="删除" @click="deleteRecord(r)">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M4 7h16m-2 0-.7 12a2 2 0 0 1-2 1.9H8.7a2 2 0 0 1-2-1.9L6 7m4 0V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2m-5 4v6m4-6v6"/></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- 手机端：记录卡片列表 -->
            <div v-else class="record-cards">
              <div
                v-for="r in filteredRecords"
                :key="r.id"
                class="record-card"
                :class="{ selected: selectedIds.has(r.id) }"
              >
                <label class="card-check">
                  <input type="checkbox" :disabled="r.locked" :checked="selectedIds.has(r.id)" @change="toggleSelect(r.id)" />
                </label>
                <div class="card-body">
                  <div class="card-top">
                    <span class="type-badge" :class="'t-' + r.type.toLowerCase()">{{ r.type }}</span>
                    <span class="card-name" :title="r.remark ? r.name + ' · ' + r.remark : r.name">
                      {{ r.name }}
                      <svg v-if="r.locked" class="icon muted" style="width: 12px; height: 12px; flex-shrink: 0" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                    </span>
                    <span
                      v-if="zoned && canProxyType(r.type) && !r.locked"
                      class="cdn-toggle"
                      :class="{ on: r.proxied }"
                      @click="toggleProxy(r)"
                    >
                      <input type="checkbox" :checked="r.proxied" />
                      <span class="switch"></span>
                    </span>
                    <span v-else-if="!zoned" class="cdn-toggle status-toggle" :class="{ on: isRecordOn(r) }" @click="toggleStatus(r)">
                      <input type="checkbox" :checked="isRecordOn(r)" />
                      <span class="switch"></span>
                    </span>
                  </div>
                  <div class="record-value copyable" :title="'点击复制：' + r.content" @click="copyContent(r)">
                    {{ r.content }}
                    <span v-if="r.type === 'MX' && r.mx != null" class="muted" style="font-family: inherit">（优先级 {{ r.mx }}）</span>
                  </div>
                  <div class="card-foot">
                    <span>TTL {{ zoned && r.ttl === 1 ? '自动' : r.ttl }}</span>
                    <span v-if="!zoned">{{ r.line || '默认' }}</span>
                    <span v-if="dnsResults[r.id]?.state === 'checking'" class="dns-badge checking">检测中</span>
                    <!-- 已代理记录：公网返回的是 CDN 节点地址，不与源站配置比对，只区分能否解析，避免"不一致"误报 -->
                    <span
                      v-else-if="dnsResults[r.id]?.state === 'done' && dnsResults[r.id].proxied"
                      class="dns-badge"
                      :class="(dnsResults[r.id].values || []).length ? 'ok' : 'mismatch'"
                      :title="((dnsResults[r.id].values || []).join('\n') || dnsResults[r.id].error || '公网未解析到该记录') + '\n经 CDN/边缘代理，公网返回的是代理节点地址，不与源站配置比对'"
                    >
                      {{ (dnsResults[r.id].values || []).length ? '已代理 · 可解析' : '已代理 · 无解析' }}
                    </span>
                    <span
                      v-else-if="dnsResults[r.id]?.state === 'done'"
                      class="dns-badge"
                      :class="dnsResults[r.id].matched === true ? 'ok' : dnsResults[r.id].matched === false ? 'mismatch' : 'unknown'"
                      :title="(dnsResults[r.id].values || []).join('\n') || dnsResults[r.id].error || '公网未解析到该记录'"
                    >
                      {{ dnsResults[r.id].matched === true ? '已生效' : dnsResults[r.id].matched === false ? '不一致' : '未知' }}
                    </span>
                    <div class="actions">
                      <button class="icon-btn" title="检测公网解析" @click="checkRecord(r)">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
                      </button>
                      <button class="icon-btn" :disabled="r.locked" title="编辑" @click="editRecord(r)">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5m-1.5-9.5a2.1 2.1 0 0 1 3 3L12 16l-4 1 1-4z"/></svg>
                      </button>
                      <button class="icon-btn danger" :disabled="r.locked" title="删除" @click="deleteRecord(r)">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M4 7h16m-2 0-.7 12a2 2 0 0 1-2 1.9H8.7a2 2 0 0 1-2-1.9L6 7m4 0V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2m-5 4v6m4-6v6"/></svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      <!-- 弹窗 -->
      <AccountManager
        v-if="showAccount"
        :accounts="accounts"
        @close="showAccount = false"
        @save="onAccountSave"
        @delete="onAccountDelete"
      />

      <RecordEditor
        v-if="showRecord"
        :provider="provider"
        :domain="activeName"
        :record="editingRecord"
        @close="showRecord = false"
        @save="onRecordSave"
      />

      <ImportRecords
        v-if="showImport"
        :provider="provider"
        :domain="activeName"
        :existing-records="records"
        @close="showImport = false"
        @import="onImportOne"
      />

      <BatchEditRecords
        v-if="showBatchEdit"
        :provider="provider"
        :domain="activeName"
        :records="selectedRecords"
        @close="showBatchEdit = false"
        @apply="onBatchApply"
        @done="onBatchEditDone"
      />

      <!-- 批量操作失败明细（有失败时由 batchDelete/batchStatus/batchProxy 置入数据） -->
      <BatchResult
        v-if="batchResult"
        :title="batchResult.title"
        :ok="batchResult.ok"
        :fails="batchResult.fails"
        @close="batchResult = null"
      />


      <!-- 操作日志 -->
      <div v-if="showLogs" class="modal-mask" @click.self="showLogs = false">
        <div class="modal" style="width: 720px; max-height: 80vh; display: flex; flex-direction: column">
          <h3>操作日志</h3>
          <div style="overflow: auto; flex: 1">
            <div v-if="loadingLogs" class="empty"><div>加载中…</div></div>
            <div v-else-if="!logs.length" class="empty"><div class="title">暂无日志</div></div>
            <table v-else class="logs-table">
              <thead>
                <tr><th>时间</th><th>用户</th><th>操作</th><th>详情</th></tr>
              </thead>
              <tbody>
                <tr v-for="l in logs" :key="l.id">
                  <td class="muted" style="white-space: nowrap">{{ l.created_at }}</td>
                  <td>{{ l.username }}</td>
                  <td><span class="type-badge" :class="logBadgeClass(l.action)">{{ actionLabel(l.action) }}</span></td>
                  <td>{{ l.detail }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="modal-foot">
            <button @click="showLogs = false">关闭</button>
            <button class="ghost" @click="openLogs">刷新</button>
          </div>
        </div>
      </div>

      <!-- 修改密码 -->
      <div v-if="showPwd" class="modal-mask" @click.self="showPwd = false">
        <div class="modal">
          <h3>修改密码</h3>
          <div class="form-row">
            <label>原密码</label>
            <input v-model="pwdForm.oldPassword" type="password" autocomplete="current-password" />
          </div>
          <div class="form-row">
            <label>新密码（至少 6 位）</label>
            <input v-model="pwdForm.newPassword" type="password" autocomplete="new-password" />
          </div>
          <div class="form-row">
            <label>确认新密码</label>
            <input v-model="pwdForm.confirm" type="password" autocomplete="new-password" />
          </div>
          <div class="modal-foot">
            <button @click="showPwd = false">取消</button>
            <button class="primary" :disabled="savingPwd" @click="doChangePassword">
              {{ savingPwd ? '保存中…' : '确认修改' }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <div class="toast-wrap">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">{{ t.msg }}</div>
    </div>
  </div>
</template>
