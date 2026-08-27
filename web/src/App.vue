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
    if (isCF.value) await api.cfDelete(accountId.value, activeId.value, r.id);
    else await api.dnsDelete(accountId.value, activeName.value, r.id);
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
      <form class="login-card" @submit.prevent="doLogin">
        <div class="login-brand"><span class="logo">🛰️</span> xDNS</div>
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
        <div class="brand"><span class="logo">🛰️</span> xDNS</div>

        <div class="tabs">
          <button :class="{ active: provider === 'cloudflare' }" @click="switchProvider('cloudflare')">Cloudflare</button>
          <button :class="{ active: provider === 'dnspod' }" @click="switchProvider('dnspod')">DNSPod</button>
        </div>

        <select v-if="providerAccounts.length" v-model="accountId" class="account-select">
          <option v-for="a in providerAccounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>

        <div class="spacer"></div>

        <button class="ghost" @click="refresh" title="刷新">↻ 刷新</button>
        <button @click="showAccount = true">🔑 账户</button>
        <button class="ghost" @click="showPwd = true">🔒 改密码</button>
        <span class="user-chip" :title="user?.username">{{ user?.username }}</span>
              <button class="ghost" @click="doLogout">退出</button>
      </header>

      <div class="body">
        <aside class="aside">
          <div class="aside-head">域名</div>

          <div v-if="!providerAccounts.length" class="empty" style="padding: 30px 16px">
            <div class="icon">🔌</div>
            <div class="title">未配置账户</div>
            <div style="font-size: 12px">请先添加 {{ provider === 'cloudflare' ? 'Cloudflare' : 'DNSPod' }} 账户</div>
            <button class="primary" @click="showAccount = true">添加账户</button>
          </div>

          <div v-else class="zone-list">
            <div v-if="loadingItems" class="empty"><div>加载中…</div></div>
            <div v-else-if="!items.length" class="empty">
              <div class="icon">📭</div>
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
            <div class="export-wrap" v-if="activeId" @mouseleave="closeExportMenu">
              <button :disabled="!filteredRecords.length" @click="showExportMenu = !showExportMenu" title="导出当前域名记录">
                ⇩ 导出
              </button>
              <div v-if="showExportMenu" class="export-menu">
                <button @click="exportRecords('json')">JSON 格式</button>
                <button @click="exportRecords('csv')">CSV 格式</button>
              </div>
            </div>
            <button :disabled="!activeId" @click="showImport = true" title="从 JSON/CSV 文件导入记录">⇧ 导入</button>
            <button class="primary" :disabled="!activeId" @click="addRecord">+ 添加记录</button>
          </div>

          <div class="table-wrap">
            <div v-if="!activeId" class="empty" style="height: 60%">
              <div class="icon">👈</div>
              <div class="title">请选择一个域名</div>
            </div>

            <div v-else-if="loadingRecords" class="empty" style="height: 60%">
              <div>加载记录中…</div>
            </div>

            <div v-else-if="!filteredRecords.length" class="empty" style="height: 60%">
              <div class="icon">🗂️</div>
              <div class="title">{{ search ? '未找到匹配记录' : '暂无记录' }}</div>
              <button class="primary" @click="addRecord">+ 添加第一条记录</button>
            </div>

            <table v-else>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>主机名</th>
                  <th>记录值</th>
                  <th>TTL</th>
                  <th v-if="!isCF">线路</th>
                  <th v-if="isCF">CDN</th>
                  <th v-else>状态</th>
                  <th style="text-align: right">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in filteredRecords" :key="r.id">
                  <td><span class="type-badge">{{ r.type }}</span></td>
                  <td>
                    <div class="record-name">
                      {{ r.name }}
                      <span v-if="r.locked" title="由 Cloudflare 托管，不可编辑">🔒</span>
                    </div>
                  </td>
                  <td>
                    <div class="record-value">
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
                    <div class="actions">
                      <button class="icon-btn" :disabled="r.locked" title="编辑" @click="editRecord(r)">✏️</button>
                      <button class="icon-btn danger" :disabled="r.locked" title="删除" @click="deleteRecord(r)">🗑️</button>
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
