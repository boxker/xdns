<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { api, setUnauthorizedHandler } from './api.js';
import AccountManager from './components/AccountManager.vue';
import RecordEditor from './components/RecordEditor.vue';
import ImportRecords from './components/ImportRecords.vue';
import { toJsonExport, toCsvExport, downloadText } from './recordIO.js';

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
const items = ref([]); // zones 或 domains
const activeId = ref(null);
const activeName = ref('');
const records = ref([]);
const loadingItems = ref(false);
const loadingRecords = ref(false);
const search = ref('');
const showAccount = ref(false);
const showRecord = ref(false);
const showImport = ref(false);
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
}
function toggleTheme() {
  applyTheme(theme.value !== 'dark');
  try {
    localStorage.setItem('xdns-theme', theme.value);
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}

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
const filteredRecords = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return records.value;
  return records.value.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.content.toLowerCase().includes(q) ||
      r.type.toLowerCase().includes(q)
  );
});

const isCF = computed(() => provider.value === 'cloudflare');
const canProxyType = (t) => ['A', 'AAAA', 'CNAME'].includes(t);
const isRecordOn = (r) => r.status === 'enabled' || r.status === 'enable';

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
  for (const r of list) {
    try {
      if (isCF.value) await api.cfDelete(accountId.value, activeId.value, r.id, { type: r.type, name: r.name });
      else await api.dnsDelete(accountId.value, activeName.value, r.id, { type: r.type, name: r.name });
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  batchBusy.value = false;
  clearSelection();
  toast(`批量删除完成：成功 ${ok}${fail ? `，失败 ${fail}` : ''}`, fail ? 'error' : 'success');
  loadRecords();
}

async function batchStatus(next) {
  const list = selectedRecords.value;
  if (!list.length) return;
  batchBusy.value = true;
  let ok = 0;
  let fail = 0;
  for (const r of list) {
    try {
      await api.dnsStatus(accountId.value, activeName.value, r.id, next);
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  batchBusy.value = false;
  clearSelection();
  toast(`批量${next === 'enabled' ? '启用' : '停用'}完成：成功 ${ok}${fail ? `，失败 ${fail}` : ''}`, fail ? 'error' : 'success');
  loadRecords();
}

async function batchProxy(proxied) {
  const list = selectedRecords.value.filter((r) => canProxyType(r.type));
  if (!list.length) return toast('选中记录中没有可切换 CDN 的类型（A/AAAA/CNAME）', 'error');
  batchBusy.value = true;
  let ok = 0;
  let fail = 0;
  for (const r of list) {
    try {
      await api.cfProxy(accountId.value, activeId.value, r.id, proxied);
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  batchBusy.value = false;
  clearSelection();
  toast(`批量${proxied ? '开启' : '关闭'} CDN 完成：成功 ${ok}${fail ? `，失败 ${fail}` : ''}`, fail ? 'error' : 'success');
  loadRecords();
}

// ---- DNS 生效检测 ----
const CHECKABLE_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']);
async function checkRecord(r) {
  if (!CHECKABLE_TYPES.has(r.type)) {
    toast(`${r.type} 类型暂不支持检测`, 'error');
    return;
  }
  dnsResults[r.id] = { state: 'checking', matched: null, values: [] };
  try {
    const res = await api.dnsLookup(r.type, r.name, r.content);
    dnsResults[r.id] = { state: 'done', matched: res.matched, values: res.values || [], error: res.error };
  } catch (e) {
    dnsResults[r.id] = { state: 'done', matched: null, values: [], error: e.message };
  }
}
async function checkAllRecords() {
  const list = filteredRecords.value.filter((r) => CHECKABLE_TYPES.has(r.type) && !r.locked);
  if (!list.length) return toast('没有可检测的记录', 'error');
  toast(`正在检测 ${list.length} 条记录的公网解析…`);
  await Promise.all(list.map((r) => checkRecord(r)));
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

async function loadRecords() {
  if (!accountId.value || !activeId.value) return;
  loadingRecords.value = true;
  try {
    if (isCF.value) {
      records.value = await api.cfRecords(accountId.value, activeId.value);
    } else {
      records.value = await api.dnsRecords(accountId.value, activeName.value);
    }
  } catch (e) {
    records.value = [];
    toast(e.message, 'error');
  } finally {
    loadingRecords.value = false;
  }
}

function selectItem(item) {
  activeId.value = item.id;
  activeName.value = item.name;
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
  const first = providerAccounts.value[0];
  accountId.value = first?.id ?? null;
  if (accountId.value) loadItems();
}

watch(accountId, () => {
  activeId.value = null;
  activeName.value = '';
  items.value = [];
  records.value = [];
  loadItems();
});

// 记录列表变化（切换域名/刷新/增删）后清空勾选
watch(records, () => clearSelection());

// ---- 账户 ----
async function onAccountSave({ id, payload, onDone }) {
  try {
    if (id) {
      await api.updateAccount(id, payload);
      toast(payload.provider === 'dnspod' ? 'DNSPod 账户已更新，密钥校验通过' : '账户已更新');
      await loadAccounts();
      selectAccount(id, payload.provider);
      await loadItems();
    } else {
      const created = await api.createAccount(payload);
      toast(payload.provider === 'dnspod' ? 'DNSPod 账户已添加，密钥校验通过' : '账户已添加');
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
    const updated = await api.cfProxy(accountId.value, activeId.value, r.id, !r.proxied);
    const idx = records.value.findIndex((x) => x.id === r.id);
    if (idx >= 0) records.value[idx] = updated;
    toast(updated.proxied ? '已开启 CDN 加速' : '已关闭 CDN 加速');
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
    if (idx >= 0) records.value[idx] = updated;
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
  const payload = { type: record.type, name: record.name, content: record.content };
  if (isCF.value) {
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
      <button class="theme-toggle" @click="toggleTheme" :title="theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'">
        <svg class="icon icon-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        <svg class="icon icon-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      </button>
      <form class="login-card" @submit.prevent="doLogin">
        <div class="login-brand">
          <span class="logo"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/></svg></span>
          xDNS
        </div>
        <div class="login-sub">DNS 管理平台</div>
        <input v-model="loginForm.username" placeholder="用户名" autocomplete="username" />
        <input v-model="loginForm.password" type="password" placeholder="密码" autocomplete="current-password" />
        <button class="primary" type="submit" :disabled="loggingIn">
          {{ loggingIn ? '登录中…' : '登 录' }}
        </button>
      </form>
    </div>

    <!-- 主界面 -->
    <template v-else>
      <header class="header">
        <div class="brand">
          <span class="logo"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/></svg></span>
          xDNS
        </div>

        <div class="tabs">
          <button :class="{ active: provider === 'cloudflare' }" @click="switchProvider('cloudflare')">Cloudflare</button>
          <button :class="{ active: provider === 'dnspod' }" @click="switchProvider('dnspod')">DNSPod</button>
        </div>

        <select v-if="providerAccounts.length" v-model="accountId" class="account-select">
          <option v-for="a in providerAccounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>

        <div class="spacer"></div>

        <button class="theme-toggle" @click="toggleTheme" :title="theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'">
          <svg class="icon icon-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          <svg class="icon icon-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        </button>
        <button class="ghost" @click="refresh" title="刷新">
          <svg class="icon" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>刷新
        </button>
        <button class="ghost" @click="openLogs" title="操作日志">
          <svg class="icon" viewBox="0 0 24 24"><path d="M4 5h16v14H4zM8 9h8M8 13h8M8 17h5"/></svg>日志
        </button>
        <button @click="showAccount = true">
          <svg class="icon" viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4"/><path d="M10.3 12.9 21 2m-5.5 1.5 4 4M14 8l2-2"/></svg>账户
        </button>
        <button class="ghost" @click="showPwd = true">
          <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>改密码
        </button>
        <span class="user-chip" :title="user?.username">{{ user?.username }}</span>
        <button class="ghost" @click="doLogout">退出</button>
      </header>

      <div class="body">
        <aside class="aside">
          <div class="aside-head">域名</div>

          <div v-if="!providerAccounts.length" class="empty" style="padding: 30px 16px">
            <div class="icon"><svg viewBox="0 0 24 24"><path d="M9 17H7A5 5 0 0 1 7 7h2m6 10h2a5 5 0 0 0 0-10h-2M8 12h8"/></svg></div>
            <div class="title">未配置账户</div>
            <div style="font-size: 12px">请先添加 {{ provider === 'cloudflare' ? 'Cloudflare' : 'DNSPod' }} 账户</div>
            <button class="primary" @click="showAccount = true">添加账户</button>
          </div>

          <div v-else class="zone-list">
            <div v-if="loadingItems" class="empty"><div>加载中…</div></div>
            <div v-else-if="!items.length" class="empty">
              <div class="icon"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg></div>
              <div class="title">暂无域名</div>
              <div style="font-size: 12px">{{ isCF ? '该账户下没有可用区域' : '该账户下没有域名' }}</div>
            </div>
            <div
              v-for="item in items"
              :key="item.id"
              class="zone-item"
              :class="{ active: item.id === activeId }"
              @click="selectItem(item)"
            >
              <span class="zone-name">{{ item.name }}</span>
              <span class="zone-dot" :class="{ ok: item.status === 'active' || item.status === 'enable' }"></span>
            </div>
          </div>
        </aside>

        <main class="main">
          <div class="toolbar">
            <div class="domain-title" v-if="activeName">{{ activeName }}</div>
            <input v-model="search" class="search" placeholder="搜索记录…" />
            <div class="spacer"></div>
            <button v-if="activeId" class="ghost" @click="checkAllRecords" title="检测公网解析是否与配置一致">
              <svg class="icon" viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>检测
            </button>
            <div class="export-wrap" v-if="activeId" @mouseleave="closeExportMenu">
              <button :disabled="!filteredRecords.length" @click="showExportMenu = !showExportMenu" title="导出当前域名记录">
                <svg class="icon" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>导出
              </button>
              <div v-if="showExportMenu" class="export-menu">
                <button @click="exportRecords('json')">JSON 格式</button>
                <button @click="exportRecords('csv')">CSV 格式</button>
              </div>
            </div>
            <button :disabled="!activeId" @click="showImport = true" title="从 JSON/CSV 文件导入记录">
              <svg class="icon" viewBox="0 0 24 24"><path d="M12 15V3m0 0 4 4m-4-4L8 7M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>导入
            </button>
            <button class="primary" :disabled="!activeId" @click="addRecord">
              <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14m-7-7h14"/></svg>添加记录
            </button>
          </div>

          <div v-if="selectedIds.size" class="batch-bar">
            <span>已选 <b>{{ selectedIds.size }}</b> 条</span>
            <button class="primary" :disabled="batchBusy" @click="isCF ? batchProxy(true) : batchStatus('enabled')">
              {{ isCF ? '批量开启 CDN' : '批量启用' }}
            </button>
            <button :disabled="batchBusy" @click="isCF ? batchProxy(false) : batchStatus('disabled')">
              {{ isCF ? '批量关闭 CDN' : '批量停用' }}
            </button>
            <button class="danger" :disabled="batchBusy" @click="batchDelete">批量删除</button>
            <div class="spacer"></div>
            <button class="ghost" @click="clearSelection">取消选择</button>
          </div>

          <div class="table-wrap">
            <div v-if="!activeId" class="empty" style="height: 60%">
              <div class="icon"><svg viewBox="0 0 24 24"><path d="M9 11V6a3 3 0 0 1 6 0v5m-9 0h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z"/></svg></div>
              <div class="title">请选择一个域名</div>
            </div>

            <div v-else-if="loadingRecords" class="empty" style="height: 60%">
              <div>加载记录中…</div>
            </div>

            <div v-else-if="!filteredRecords.length" class="empty" style="height: 60%">
              <div class="icon"><svg viewBox="0 0 24 24"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg></div>
              <div class="title">{{ search ? '未找到匹配记录' : '暂无记录' }}</div>
              <button class="primary" v-if="!search" @click="addRecord">+ 添加第一条记录</button>
            </div>

            <table v-else>
              <thead>
                <tr>
                  <th style="width: 32px">
                    <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" title="全选" />
                  </th>
                  <th>类型</th>
                  <th>主机名</th>
                  <th>记录值</th>
                  <th>TTL</th>
                  <th v-if="!isCF">线路</th>
                  <th v-if="isCF">CDN</th>
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
                    <div class="record-name">
                      {{ r.name }}
                      <svg v-if="r.locked" class="icon muted" style="width: 12px; height: 12px" title="由 Cloudflare 托管，不可编辑" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                    </div>
                  </td>
                  <td>
                    <div class="record-value copyable" :title="'点击复制：' + r.content" @click="copyContent(r)">
                      {{ r.content }}
                      <span v-if="r.type === 'MX' && r.mx != null" class="muted" style="font-family: inherit">（优先级 {{ r.mx }}）</span>
                    </div>
                  </td>
                  <td class="record-ttl">{{ isCF && r.ttl === 1 ? '自动' : r.ttl }}</td>
                  <td v-if="!isCF" class="record-line">{{ r.line || '默认' }}</td>
                  <td v-if="isCF">
                    <span v-if="canProxyType(r.type)" class="cdn-toggle" :class="{ on: r.proxied }" @click="!r.locked && toggleProxy(r)">
                      <input type="checkbox" :checked="r.proxied" />
                      <span class="switch"></span>
                      <span class="cdn-label">{{ r.proxied ? '加速中' : '关闭' }}</span>
                    </span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td v-else>
                    <span class="cdn-toggle" :class="{ on: isRecordOn(r) }" @click="toggleStatus(r)">
                      <input type="checkbox" :checked="isRecordOn(r)" />
                      <span class="switch"></span>
                      <span class="cdn-label">{{ isRecordOn(r) ? '启用' : '停用' }}</span>
                    </span>
                  </td>
                  <td>
                    <span v-if="dnsResults[r.id]?.state === 'checking'" class="dns-badge checking">检测中</span>
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
        @close="showImport = false"
        @import="onImportOne"
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
