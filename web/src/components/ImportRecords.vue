<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { parseRecordsText, readFileText } from '../recordIO.js';

const props = defineProps({
  provider: { type: String, required: true }, // cloudflare | aliyun-esa | dnspod
  domain: { type: String, required: true },   // 当前域名（区域名）
  // 当前域已加载的记录列表：传入后查重才不会与线上记录脱节，
  // 否则重复导入会绕过 _dup 标记、真实建出重复记录
  existingRecords: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'import']);

const state = ref('pick'); // pick -> preview -> importing -> done
const fileName = ref('');
const records = ref([]);   // 解析结果（含 _dup 标记）
const errors = ref([]);
const progress = ref({ total: 0, done: 0, ok: 0, failed: 0, errors: [] });
const isDragging = ref(false);
const fileInput = ref(null);

const validCount = computed(() => records.value.filter((r) => !r._dup).length);
const dupCount = computed(() => records.value.length - validCount.value);
const allDup = computed(() => records.value.length > 0 && validCount.value === 0);

function reset() {
  state.value = 'pick';
  fileName.value = '';
  records.value = [];
  errors.value = [];
  progress.value = { total: 0, done: 0, ok: 0, failed: 0, errors: [] };
  isDragging.value = false;
}

// ---- 文件选取 ----
function onPick() {
  fileInput.value?.click();
}

function onFileChange(e) {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) handleFile(f);
}

function onDrop(e) {
  isDragging.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
}

async function handleFile(file) {
  const name = file.name.toLowerCase();
  if (!name.endsWith('.json') && !name.endsWith('.csv') && !name.endsWith('.txt')) {
    errors.value = ['仅支持 .json / .csv 文件'];
    records.value = [];
    return;
  }
  fileName.value = file.name;
  try {
    const text = await readFileText(file);
    // 把父组件传入的线上已有记录一并交给查重（dupKey 为 type|name|content，
    // common 记录数组可直接使用），避免重复导入真实建出重复记录
    const { records: recs, errors: errs } = parseRecordsText(text, props.existingRecords);
    records.value = recs;
    errors.value = errs;
    state.value = 'preview';
  } catch (e) {
    errors.value = [e.message];
    records.value = [];
    state.value = 'preview';
  }
}

// ---- 导入执行 ----
async function doImport() {
  const list = records.value.filter((r) => !r._dup);
  if (!list.length) return;
  state.value = 'importing';
  progress.value = { total: list.length, done: 0, ok: 0, failed: 0, errors: [] };
  for (const r of list) {
    try {
      await emitOne(r);
      progress.value.ok++;
    } catch (e) {
      progress.value.failed++;
      progress.value.errors.push(`${r.type} ${r.name}: ${e.message}`);
    }
    progress.value.done++;
  }
  state.value = 'done';
}

// 逐条抛给父组件调用对应 API；父组件返回 Promise
function emitOne(record) {
  return new Promise((resolve, reject) => {
    emit('import', record, resolve, reject);
  })
    .then(() => new Promise((r) => setTimeout(r, 120))) // 轻微节流，避免请求过快
    .catch((e) => Promise.reject(e instanceof Error ? e : new Error(String(e))));
}

function onKeydown(e) {
  if (e.key === 'Escape' && state.value !== 'importing') emit('close');
}
onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="modal-mask" @click.self="state !== 'importing' && $emit('close')">
    <div class="modal import-modal">
      <h3>导入记录到 {{ domain }}</h3>

      <!-- 选择文件 -->
      <template v-if="state === 'pick'">
        <div
          class="drop-zone"
          :class="{ drag: isDragging }"
          @click="onPick"
          @dragover.prevent="isDragging = true"
          @dragleave="isDragging = false"
          @drop.prevent="onDrop"
        >
          <div class="dz-icon"><svg viewBox="0 0 24 24" style="width:34px;height:34px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round"><path d="M12 16V4m0 0 4 4m-4-4L8 8M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></div>
          <div class="dz-title">点击选择或拖入文件</div>
          <div class="dz-hint">支持 .json / .csv（TXT 也按 CSV 解析）</div>
        </div>
        <div class="hint" style="margin-top: 12px">
          JSON 支持数组、<code>{records:[...]}</code> 或 xDNS 导出的
          <code>{zones:{...}}</code> 格式；CSV 需含 type / name / content 列。
        </div>
      </template>

      <!-- 预览 -->
      <template v-else-if="state === 'preview'">
        <div class="file-line">
          <span class="file-name">{{ fileName }}</span>
          <button class="ghost" @click="reset">重新选择</button>
        </div>

        <div class="stat-line">
          <span class="ok">可导入 {{ validCount }} 条</span>
          <span v-if="dupCount" class="dup">重复跳过 {{ dupCount }} 条</span>
          <span v-if="errors.length" class="bad">解析失败 {{ errors.length }} 行</span>
        </div>

        <div v-if="errors.length" class="err-box">
          <div v-for="(e, i) in errors.slice(0, 5)" :key="i">{{ e }}</div>
          <div v-if="errors.length > 5">…共 {{ errors.length }} 条</div>
        </div>

        <div class="preview-table">
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>主机名</th>
                <th>记录值</th>
                <th v-if="provider === 'dnspod'">线路</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in records.slice(0, 100)" :key="i" :class="{ dup: r._dup }">
                <td><span class="type-badge" :class="'t-' + String(r.type).toLowerCase()">{{ r.type }}</span></td>
                <td class="mono">{{ r.name }}</td>
                <td class="mono">{{ r.content }}</td>
                <td v-if="provider === 'dnspod'">{{ r.line }}</td>
                <td>
                  <span v-if="r._dup" class="dup-tag">重复</span>
                  <span v-else class="ok-tag">待导入</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="records.length > 100" class="more-hint">仅展示前 100 条，共 {{ records.length }} 条</div>
        </div>

        <div class="modal-foot">
          <button @click="reset">返回</button>
          <button class="primary" :disabled="!validCount || allDup" @click="doImport">
            导入 {{ validCount }} 条
          </button>
        </div>
      </template>

      <!-- 导入中 / 完成 -->
      <template v-else>
        <div class="progress-line">
          <div class="progress-bar">
            <div
              class="progress-fill"
              :class="{ done: state === 'done' }"
              :style="{ width: progress.total ? (progress.done / progress.total) * 100 + '%' : '0' }"
            ></div>
          </div>
          <span class="progress-text">{{ progress.done }} / {{ progress.total }}</span>
        </div>

        <div v-if="state === 'done'" class="result-line">
          <span class="ok">成功 {{ progress.ok }} 条</span>
          <span v-if="progress.failed" class="bad">失败 {{ progress.failed }} 条</span>
        </div>

        <div v-if="progress.errors.length" class="err-box scrollable">
          <div v-for="(e, i) in progress.errors.slice(0, 20)" :key="i">✕ {{ e }}</div>
          <div v-if="progress.errors.length > 20">…共 {{ progress.errors.length }} 条</div>
        </div>

        <div class="modal-foot">
          <button v-if="state === 'done'" class="primary" @click="$emit('close')">完成</button>
        </div>
      </template>

      <input ref="fileInput" type="file" accept=".json,.csv,.txt" style="display: none" @change="onFileChange" />
    </div>
  </div>
</template>

<style scoped>
.import-modal { width: 560px; }
.drop-zone {
  border: 2px dashed var(--border);
  border-radius: 12px;
  padding: 36px 20px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
  background: #fafbfc;
}
.drop-zone:hover, .drop-zone.drag { border-color: var(--primary); background: var(--primary-weak); }
.dz-icon { font-size: 34px; color: var(--text-3); }
.dz-title { font-weight: 500; margin-top: 8px; color: var(--text); }
.dz-hint { font-size: 12px; color: var(--text-3); margin-top: 4px; }
.file-line { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.file-name { font-weight: 500; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stat-line { display: flex; gap: 14px; font-size: 13px; margin-bottom: 10px; }
.stat-line .ok { color: var(--green); font-weight: 500; }
.stat-line .dup { color: var(--text-2); }
.stat-line .bad { color: var(--danger); font-weight: 500; }
.err-box {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  margin-bottom: 10px;
  line-height: 1.7;
}
.err-box.scrollable { max-height: 160px; overflow: auto; }
.preview-table {
  max-height: 300px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.preview-table table { box-shadow: none; border-radius: 0; }
.preview-table tr.dup td { opacity: 0.45; }
.more-hint { padding: 8px; text-align: center; color: var(--text-3); font-size: 12px; }
.mono { font-family: var(--mono); font-size: 12px; word-break: break-all; }
.dup-tag { color: var(--text-3); font-size: 12px; }
.ok-tag { color: var(--green); font-size: 12px; }
.progress-line { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.progress-bar { flex: 1; height: 8px; border-radius: 999px; background: #eef1f5; overflow: hidden; }
.progress-fill { height: 100%; background: var(--primary); border-radius: 999px; transition: width 0.2s; }
.progress-fill.done { background: var(--green); }
.progress-text { font-size: 13px; color: var(--text-2); min-width: 70px; text-align: right; }
.result-line { display: flex; gap: 14px; font-size: 13px; margin-bottom: 10px; }
.result-line .ok { color: var(--green); font-weight: 500; }
.result-line .bad { color: var(--danger); font-weight: 500; }
</style>
