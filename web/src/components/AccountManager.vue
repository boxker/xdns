<script setup>
import { ref, reactive, computed } from 'vue';

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
});

const providerLabel = (p) => (p === 'cloudflare' ? 'Cloudflare' : 'DNSPod');

function resetForm() {
  form.provider = 'cloudflare';
  form.name = '';
  form.auth_type = 'token';
  form.token = '';
  form.email = '';
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
  saving.value = true;
  const payload = {
    provider: form.provider,
    name: form.name.trim(),
    auth_type: form.provider === 'cloudflare' ? form.auth_type : 'token',
    email: form.email,
    token: form.token,
  };
  emit('save', {
    id: editId.value,
    payload,
    onDone: (ok) => {
      saving.value = false;
      if (ok) editing.value = false;
      else formError.value = '保存失败，请核对 Token 后重试';
    },
  });
}

function remove(acc) {
  emit('delete', acc);
}
</script>

<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal" style="width: 520px">
      <h3>账户管理</h3>

      <div v-if="!editing">
        <div v-if="accounts.length === 0" class="empty" style="padding: 24px">
          <div class="icon">🔑</div>
          <div class="title">还没有账户</div>
          <div style="font-size: 13px">添加 Cloudflare 或 DNSPod 的 API 凭证开始管理</div>
        </div>

        <div v-for="acc in accounts" :key="acc.id" class="zone-item" style="border: 1px solid var(--border); margin-bottom: 8px">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0">
            <span class="provider-badge" :class="acc.provider === 'cloudflare' ? 'cf' : 'dp'">
              {{ providerLabel(acc.provider) }}
            </span>
            <div style="min-width: 0">
              <div style="font-weight: 500">{{ acc.name }}</div>
              <div class="muted" style="font-size: 12px">
                {{ acc.auth_type === 'key' ? 'Global API Key' : 'API Token' }}
                <template v-if="acc.email"> · {{ acc.email }}</template>
                <div v-if="acc.tokenHint" style="color: var(--danger); margin-top: 4px">{{ acc.tokenHint }}</div>
              </div>
            </div>
          </div>
          <div class="actions">
            <button class="icon-btn" title="编辑" @click="startEdit(acc)">✏️</button>
            <button class="icon-btn danger" title="删除" @click="remove(acc)">🗑️</button>
          </div>
        </div>

        <button class="primary" style="width: 100%" @click="startCreate">+ 添加账户</button>
      </div>

      <div v-else>
        <div class="form-row">
          <label>服务商</label>
          <select v-model="form.provider" :disabled="editId !== null">
            <option value="cloudflare">Cloudflare</option>
            <option value="dnspod">DNSPod</option>
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

        <div class="form-row">
          <label>
            {{ form.provider === 'cloudflare' ? 'API Token / Key' : 'DNSPod Token（ID,Token）' }}
          </label>
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
          <div v-if="formError" class="hint" style="color: var(--danger)">{{ formError }}</div>
        </div>

        <div class="modal-foot">
          <button @click="cancel">取消</button>
          <button class="primary" :disabled="saving || (!form.token && editId === null)" @click="submit">
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
