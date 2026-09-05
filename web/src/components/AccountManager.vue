<script setup>
import { ref, reactive, computed } from 'vue';
import { api } from '../api'; // 测试连接是只读探测，组件内直接调 API 即可，无需经父组件流转

const props = defineProps({ accounts: { type: Array, default: () => [] } });
const emit = defineEmits(['save', 'delete', 'close']);

const editing = ref(false);
const editId = ref(null);
const saving = ref(false);
const formError = ref('');

const form = reactive({
  provider: 'cloudflare',
  name: '',
  auth_type: 'token',
  token: '',
  email: '',
  akId: '',
  akSecret: '',
});

const PROVIDERS = [
  { value: 'cloudflare', label: 'Cloudflare', short: 'CF' },
  { value: 'dnspod', label: 'DNSPod', short: 'DP' },
  { value: 'aliyun-esa', label: '阿里云 ESA', short: 'ESA' },
];
const badgeClass = (p) => (p === 'cloudflare' ? 'cf' : p === 'dnspod' ? 'dp' : 'esa');
const providerLabel = (p) => PROVIDERS.find((x) => x.value === p)?.label || p;
const providerShort = (p) => PROVIDERS.find((x) => x.value === p)?.short || p;

const isESA = computed(() => form.provider === 'aliyun-esa');

function resetForm() {
  form.provider = 'cloudflare';
  form.name = '';
  form.auth_type = 'token';
  form.token = '';
  form.email = '';
  form.akId = '';
  form.akSecret = '';
}

function startCreate() {
  resetForm();
  formError.value = '';
  editId.value = null;
  editing.value = true;
}

function startEdit(acc) {
  form.provider = acc.provider;
  form.name = acc.name;
  form.auth_type = acc.auth_type || 'token';
  form.token = '';
  form.email = acc.email || '';
  form.akId = '';
  form.akSecret = '';
  formError.value = '';
  editId.value = acc.id;
  editing.value = true;
}

function cancel() {
  editing.value = false;
}

async function submit() {
  if (!form.name.trim()) return;
  formError.value = '';

  if (form.provider === 'dnspod' && form.token) {
    const t = form.token.trim().replace(/，/g, ',').replace(/\s+/g, '');
    if (!/^\d+,[^,\s]+$/.test(t)) {
      formError.value = '格式必须是「数字ID,Token」，例如 123456,xxxxxxxx。现在缺前面的数字 ID。';
      return;
    }
  }

  let token = form.token;
  if (isESA.value) {
    const id = form.akId.trim().replace(/，/g, ',').replace(/\s+/g, '');
    const secret = form.akSecret.trim().replace(/，/g, ',').replace(/\s+/g, '');
    if (id && secret) token = `${id},${secret}`;
    else if (id || secret) {
      formError.value = 'AccessKeyId 与 AccessKeySecret 需要成对填写；编辑时留空两项表示不修改。';
      return;
    }
  }

  saving.value = true;
  const payload = {
    provider: form.provider,
    name: form.name.trim(),
    auth_type: form.provider === 'cloudflare' ? form.auth_type : 'token',
    email: form.email,
    token,
  };
  emit('save', {
    id: editId.value,
    payload,
    onDone: (ok) => {
      saving.value = false;
      if (ok) editing.value = false;
      else formError.value = '保存失败，请核对凭证后重试';
    },
  });
}

function remove(acc) {
  emit('delete', acc);
}

// ---------- 测试连接（U5）----------
// 状态按账户 id 分开存：多个账户可以同时测试，互不干扰
const testing = reactive({}); // id -> 是否测试中（控制按钮 loading/禁用）
const testResult = reactive({}); // id -> { ok: true }（短暂打勾）或 { error }（行内红字）

async function testAccount(acc) {
  if (testing[acc.id]) return; // 测试中不允许重复触发
  delete testResult[acc.id]; // 重测前先清掉上次结果，避免新旧信息混在一起
  testing[acc.id] = true;
  try {
    await api.testAccount(acc.id);
    testResult[acc.id] = { ok: true };
    // 成功不打断用户：按钮短暂打勾 2 秒后自动还原；期间仍可点击重测
    setTimeout(() => {
      if (testResult[acc.id]?.ok) delete testResult[acc.id];
    }, 2000);
  } catch (e) {
    // 失败保留错误文案直到下次重测，按钮恢复可点，方便修正凭证后立刻再试
    testResult[acc.id] = { error: e.message || '测试失败' };
  } finally {
    testing[acc.id] = false;
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal" style="width: 520px">
      <h3>账户管理</h3>

      <div v-if="!editing">
        <div v-if="accounts.length === 0" class="empty" style="padding: 24px">
          <div class="icon"><svg viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4"/><path d="M10.3 12.9 21 2m-5.5 1.5 4 4M14 8l2-2"/></svg></div>
          <div class="title">还没有账户</div>
          <div style="font-size: 13px">添加 Cloudflare / DNSPod / 阿里云 ESA 的 API 凭证开始管理</div>
        </div>

        <div v-for="acc in accounts" :key="acc.id" class="zone-item" style="border: 1px solid var(--border); margin-bottom: 8px">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0">
            <span class="provider-badge" :class="badgeClass(acc.provider)">{{ providerShort(acc.provider) }}</span>
            <div style="min-width: 0">
              <div style="font-weight: 500">{{ acc.name }}</div>
              <div class="muted" style="font-size: 12px">
                {{ acc.provider === 'aliyun-esa' ? 'AccessKey' : acc.auth_type === 'key' ? 'Global API Key' : 'API Token' }}
                <template v-if="acc.email"> · {{ acc.email }}</template>
                <div v-if="acc.tokenHint" style="color: var(--danger); margin-top: 4px">{{ acc.tokenHint }}</div>
                <!-- 测试连接失败文案：与上方 tokenHint 同款行内红字样式，保留至下次重测 -->
                <div v-if="testResult[acc.id]?.error" style="color: var(--danger); margin-top: 4px">
                  测试失败：{{ testResult[acc.id].error }}
                </div>
              </div>
            </div>
          </div>
          <div class="actions">
            <button
              class="ghost test-btn"
              :class="{ ok: testResult[acc.id]?.ok }"
              :disabled="testing[acc.id]"
              title="验证该账户的 API 凭证是否有效"
              @click="testAccount(acc)"
            >
              {{ testing[acc.id] ? '测试中…' : testResult[acc.id]?.ok ? '✓ 正常' : '测试连接' }}
            </button>
            <button class="icon-btn" title="编辑" @click="startEdit(acc)">
              <svg class="icon" viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5m-1.5-9.5a2.1 2.1 0 0 1 3 3L12 16l-4 1 1-4z"/></svg>
            </button>
            <button class="icon-btn danger" title="删除" @click="remove(acc)">
              <svg class="icon" viewBox="0 0 24 24"><path d="M4 7h16m-2 0-.7 12a2 2 0 0 1-2 1.9H8.7a2 2 0 0 1-2-1.9L6 7m4 0V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2m-5 4v6m4-6v6"/></svg>
            </button>
          </div>
        </div>

        <button class="primary" style="width: 100%" @click="startCreate">
          <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14m-7-7h14"/></svg>添加账户
        </button>
      </div>

      <div v-else>
        <div class="form-row">
          <label>服务商</label>
          <select v-model="form.provider" :disabled="editId !== null">
            <option v-for="p in PROVIDERS" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </div>

        <div class="form-row">
          <label>账户名称</label>
          <input v-model="form.name" placeholder="例如：公司主站" />
        </div>

        <div class="form-row" v-if="form.provider === 'cloudflare'">
          <label>认证方式</label>
          <select v-model="form.auth_type">
            <option value="token">API Token（推荐）</option>
            <option value="key">Global API Key</option>
          </select>
          <div class="hint">Token 需具备对应域名的 DNS 编辑权限</div>
        </div>

        <div class="form-row" v-if="form.provider === 'cloudflare' && form.auth_type === 'key'">
          <label>账号邮箱</label>
          <input v-model="form.email" placeholder="you@example.com" />
        </div>

        <template v-if="isESA">
          <div class="form-row">
            <label>AccessKey ID</label>
            <input v-model="form.akId" placeholder="例如 LTAI5tAbCdEfGhIjKlMnOpQrSt" autocomplete="off" spellcheck="false" />
          </div>
          <div class="form-row">
            <label>AccessKey Secret</label>
            <input v-model="form.akSecret" type="password" :placeholder="editId !== null ? '留空表示不修改' : ''" autocomplete="new-password" spellcheck="false" />
            <div class="hint">
              到阿里云控制台 → RAM 访问控制 → 创建 AccessKey；并授予 ESA 权限（如 AliyunESAFullAccess）。
              建议为 xDNS 单独创建 RAM 子账号，仅授予 ESA 权限。
            </div>
          </div>
        </template>

        <div class="form-row" v-else-if="form.provider !== 'aliyun-esa'">
          <label>{{ form.provider === 'cloudflare' ? 'API Token / Key' : 'DNSPod Token（ID,Token）' }}</label>
          <input
            v-model="form.token"
            type="text"
            :placeholder="editId !== null ? '留空表示不修改' : form.provider === 'dnspod' ? '例如 123456,xxxxxxxxxxxxxxxx' : ''"
            autocomplete="off"
            spellcheck="false"
          />
          <div class="hint" v-if="form.provider === 'dnspod'">
            必须带数字 ID。到 DNSPod 控制台 → 密钥管理 复制完整 Token，格式
            <code>123456,后面一串</code>，不要只填后半段，也不要用腾讯云 SecretId。
          </div>
        </div>

        <div v-if="formError" class="hint" style="color: var(--danger)">{{ formError }}</div>

        <div class="modal-foot">
          <button @click="cancel">取消</button>
          <button
            class="primary"
            :disabled="saving || (isESA ? (!form.akId.trim() || !form.akSecret.trim()) && editId === null : !form.token && editId === null)"
            @click="submit"
          >
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>

      <div class="modal-foot" style="margin-top: 8px">
        <button @click="$emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 账户行是 div 而非表格 tr：全局 .actions 的显示规则只覆盖 tr:hover（触屏设备另有 media 兜底常显），
   桌面端这里的操作按钮会一直 opacity:0 而不可见；补一条本组件的悬停显示规则，保证「测试连接/编辑/删除」可被发现 */
.zone-item:hover .actions {
  opacity: 1;
}
/* 行内小号 ghost 按钮：全局默认按钮内边距（7px 14px）在账户行里偏大，压到与图标按钮相近的体量 */
.test-btn {
  padding: 4px 10px;
  font-size: 12px;
}
/* 「✓ 正常」用绿色与中性文案区分 */
.test-btn.ok {
  color: var(--green);
}
</style>
