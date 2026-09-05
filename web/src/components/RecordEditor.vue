<script setup>
import { ref, reactive, watch, computed } from 'vue';

const props = defineProps({
  provider: { type: String, required: true }, // cloudflare | aliyun-esa | dnspod
  domain: { type: String, default: '' }, // 当前域名/区域名
  record: { type: Object, default: null }, // null 表示新增
});
const emit = defineEmits(['save', 'close']);

// SRV/PTR 补进可选类型：recordIO 与服务端校验均早已支持，缺的只是编辑入口
const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'PTR', 'CAA'];
const CF_TTL_OPTIONS = [
  { label: '自动', value: 1 },
  { label: '60 秒', value: 60 },
  { label: '120 秒', value: 120 },
  { label: '300 秒', value: 300 },
  { label: '600 秒', value: 600 },
  { label: '3600 秒', value: 3600 },
  { label: '86400 秒', value: 86400 },
];

const form = reactive({
  type: 'A',
  name: '',
  content: '',
  ttl: 600,
  ttlAuto: false,
  line: '默认',
  mx: 10,
  proxied: false,
  remark: '',
});

// DNSPod 常用线路（免费套餐可用；付费线路仍可手动输入）
const LINE_OPTIONS = ['默认', '境内', '境外', '电信', '联通', '移动', '铁通', '教育网'];

// CF 与 ESA 同为区域型：TTL 支持「自动」（1），A/AAAA/CNAME 可开代理
const zoned = computed(() => props.provider === 'cloudflare' || props.provider === 'aliyun-esa');
const isESA = computed(() => props.provider === 'aliyun-esa');
const canProxy = computed(() => ['A', 'AAAA', 'CNAME'].includes(form.type));
// ESA 的备注上限比其它服务商低（错误码按 50 字符判定）
const remarkMax = computed(() => (isESA.value ? 50 : 200));

function init() {
  const r = props.record;
  form.type = r?.type || 'A';
  form.name = r?.name || props.domain || '';
  form.content = r?.content || '';
  form.line = r?.line || '默认';
  form.mx = r?.mx ?? 10;
  form.proxied = !!r?.proxied;
  form.remark = r?.remark || '';

  if (zoned.value) {
    form.ttlAuto = !r || r.ttl === 1 || r.ttl == null;
    form.ttl = r?.ttl && r.ttl !== 1 ? r.ttl : 1;
  } else {
    form.ttlAuto = false;
    form.ttl = r?.ttl || 600;
  }
}

init();

watch(
  () => props.record,
  () => init()
);

function submit() {
  if (!form.name.trim() || !form.content.trim()) return;
  const payload = {
    type: form.type,
    name: form.name.trim(),
    content: form.content.trim(),
    remark: form.remark.trim(),
  };
  if (zoned.value) {
    payload.ttl = form.ttlAuto ? 1 : Number(form.ttl) || 1;
    if (canProxy.value) payload.proxied = form.proxied;
    if (form.type === 'MX') payload.mx = Number(form.mx) || 10;
  } else {
    payload.ttl = Number(form.ttl) || 600;
    payload.line = form.line.trim() || '默认';
    if (form.type === 'MX') payload.mx = Number(form.mx) || 10;
  }
  emit('save', payload);
}
</script>

<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal">
      <h3>{{ record ? '编辑记录' : '添加记录' }}</h3>

      <div class="form-row">
        <label>类型</label>
        <select v-model="form.type">
          <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>

      <div class="form-row">
        <label>主机名</label>
        <input v-model="form.name" placeholder="例如 www.example.com" />
        <div class="hint">完整主机名；根域名直接填 {{ domain || '主域名' }}</div>
      </div>

      <div class="form-row">
        <label>记录值</label>
        <textarea v-if="form.type === 'TXT'" v-model="form.content" placeholder="记录内容"></textarea>
        <input v-else v-model="form.content" placeholder="记录值，如 IP 地址 / 目标域名" />
        <!-- SRV 是四段空格分隔的特殊格式，不给样例用户很难猜对，服务端也按此格式校验 -->
        <div v-if="form.type === 'SRV'" class="hint">格式：优先级 权重 端口 目标，如 0 5 5060 sip.example.com</div>
      </div>

      <div class="form-row" v-if="form.type === 'MX'">
        <label>优先级</label>
        <input v-model.number="form.mx" type="number" min="0" />
      </div>

      <div class="form-row" v-if="zoned">
        <label>TTL</label>
        <select v-model.number="form.ttl" :disabled="form.ttlAuto">
          <option v-for="o in CF_TTL_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <label style="margin-top: 8px; display: flex; align-items: center; gap: 8px; font-weight: 400; cursor: pointer">
          <span class="cdn-toggle" :class="{ on: form.ttlAuto }" @click.prevent="form.ttlAuto = !form.ttlAuto">
            <span class="switch"></span>
          </span>
          自动（跟随默认 TTL）
        </label>
      </div>

      <div class="form-row" v-else>
        <label>TTL（秒）</label>
        <input v-model.number="form.ttl" type="number" min="1" />
      </div>

      <div class="form-row" v-if="!zoned">
        <label>线路</label>
        <input v-model="form.line" list="line-options" placeholder="默认" />
        <datalist id="line-options">
          <option v-for="l in LINE_OPTIONS" :key="l" :value="l"></option>
        </datalist>
        <div class="hint">常用：默认、电信、联通、移动；付费套餐线路可手动输入</div>
      </div>

      <div class="form-row">
        <label>备注</label>
        <input v-model="form.remark" :maxlength="remarkMax" placeholder="可选，如「官网主站」" />
        <div class="hint" v-if="isESA">ESA 备注最长 {{ remarkMax }} 字符</div>
      </div>

      <div class="form-row" v-if="zoned && canProxy">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer">
          <span class="cdn-toggle" :class="{ on: form.proxied }" @click="form.proxied = !form.proxied">
            <span class="switch"></span>
          </span>
          <span>{{ isESA ? '启用边缘加速（ESA 代理）' : '启用 CDN（云朵代理）' }}</span>
        </label>
        <div class="hint">
          {{ isESA
            ? '开启后流量经由阿里云 ESA 边缘节点加速与防护；关闭则为纯 DNS 解析'
            : '开启后流量经由 Cloudflare 加速与防护；关闭则为纯 DNS 解析' }}
        </div>
      </div>

      <div class="modal-foot">
        <button @click="$emit('close')">取消</button>
        <button class="primary" :disabled="!form.name.trim() || !form.content.trim()" @click="submit">
          保存
        </button>
      </div>
    </div>
  </div>
</template>
