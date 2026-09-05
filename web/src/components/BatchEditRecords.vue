<script setup>
// 批量编辑弹窗：对选中记录做「记录值 / 主机名 / TTL / 线路」的任意组合修改
// 表单实时计算变更预览，确认后逐条回传父组件执行（复用 ImportRecords 的 emit 回调模式）
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { computeChanges as computeChangesFor, isConfigValid } from '../batchEdit.js';

const props = defineProps({
  provider: { type: String, required: true }, // cloudflare | aliyun-esa | dnspod
  domain: { type: String, default: '' },
  records: { type: Array, required: true }, // 选中的记录
});
const emit = defineEmits(['close', 'apply', 'done']);

const state = ref('edit'); // edit -> applying -> done
const progress = ref({ total: 0, done: 0, ok: 0, failed: 0, errors: [] });

// CF 与 ESA：无线路概念，TTL=1 表示自动，更新走局部字段
const zoned = computed(() => props.provider === 'cloudflare' || props.provider === 'aliyun-esa');
const selectable = computed(() => props.records.filter((r) => !r.locked));

const edit = reactive({
  contentEnabled: false,
  contentMode: 'exact', // exact: 精确匹配替换（服务器换 IP 场景）| all: 全部统一为新值
  contentOld: '',
  contentNew: '',
  nameEnabled: false,
  nameFind: '',
  nameReplace: '',
  ttlEnabled: false,
  ttl: 600,
  lineEnabled: false, // 仅 DNSPod
  line: '默认',
});

const LINE_OPTIONS = ['默认', '境内', '境外', '电信', '联通', '移动', '铁通', '教育网'];

const providerOpts = computed(() => ({ provider: props.provider }));

const planned = computed(() =>
  selectable.value
    .map((r) => ({ record: r, changes: computeChangesFor(edit, r, providerOpts.value) }))
    .filter((p) => Object.keys(p.changes).length > 0)
);
const previewList = computed(() => planned.value.slice(0, 8));
const unaffected = computed(() => selectable.value.length - planned.value.length);

const anyEnabled = computed(() =>
  edit.contentEnabled || edit.nameEnabled || edit.ttlEnabled || edit.lineEnabled
);

const ttlInvalid = computed(() => {
  if (!edit.ttlEnabled) return false;
  const n = Number(edit.ttl);
  return !Number.isInteger(n) || n < 1 || n > 604800;
});

const configInvalid = computed(() => !isConfigValid(edit, providerOpts.value));

// 预览行：[{ key, before, after }]
function diffFields(r, changes) {
  const fields = [];
  if (changes.name != null) fields.push({ key: '主机名', before: r.name, after: changes.name });
  if (changes.content != null) fields.push({ key: '记录值', before: r.content, after: changes.content });
  if (changes.ttl != null) fields.push({ key: 'TTL', before: r.ttl, after: changes.ttl });
  if (changes.line != null) fields.push({ key: '线路', before: r.line || '默认', after: changes.line });
  return fields;
}

async function doApply() {
  const list = planned.value;
  if (!list.length || configInvalid.value) return;
  state.value = 'applying';
  progress.value = { total: list.length, done: 0, ok: 0, failed: 0, errors: [] };
  for (const { record, changes } of list) {
    await new Promise((resolve) => setTimeout(resolve, 100)); // 轻微节流，避免请求过快
    try {
      await emitOne(record, changes);
      progress.value.ok++;
    } catch (e) {
      progress.value.failed++;
      progress.value.errors.push(`${record.type} ${record.name}: ${e.message}`);
    }
    progress.value.done++;
  }
  state.value = 'done';
}

// 逐条抛给父组件调用对应 API；父组件返回 Promise
function emitOne(record, changes) {
  return new Promise((resolve, reject) => {
    emit('apply', record, changes, resolve, reject);
  }).catch((e) => Promise.reject(e instanceof Error ? e : new Error(String(e))));
}

function finish() {
  emit('done', { ok: progress.value.ok, failed: progress.value.failed });
}

function onKeydown(e) {
  if (e.key === 'Escape' && state.value === 'edit') emit('close');
}
onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="modal-mask" @click.self="state === 'edit' && $emit('close')">
    <div class="modal batch-modal">
      <h3>批量编辑记录</h3>

      <!-- 编辑表单 + 实时预览 -->
      <template v-if="state === 'edit'">
        <div class="hint" style="margin-bottom: 12px">
          已选 {{ selectable.length }} 条记录。勾选要修改的维度，只应用勾选的字段；
          不满足条件的记录（如记录值不匹配）会自动跳过。
        </div>

        <!-- 记录值 -->
        <div class="edit-block">
          <label class="edit-head">
            <input type="checkbox" v-model="edit.contentEnabled" />
            <b>记录值</b>
          </label>
          <div class="edit-body" v-if="edit.contentEnabled">
            <div class="mode-row">
              <label><input type="radio" value="exact" v-model="edit.contentMode" /> 精确匹配替换</label>
              <label><input type="radio" value="all" v-model="edit.contentMode" /> 全部统一为新值</label>
            </div>
            <div class="form-row" v-if="edit.contentMode === 'exact'">
              <label>旧记录值</label>
              <input v-model="edit.contentOld" placeholder="如旧服务器 IP 1.2.3.4" />
              <div class="hint">仅修改记录值与此完全相等的记录（换 IP / 换源站场景）</div>
            </div>
            <div class="form-row">
              <label>新记录值</label>
              <input v-model="edit.contentNew" placeholder="如新服务器 IP 5.6.7.8" />
            </div>
          </div>
        </div>

        <!-- 主机名 -->
        <div class="edit-block">
          <label class="edit-head">
            <input type="checkbox" v-model="edit.nameEnabled" />
            <b>主机名</b>
          </label>
          <div class="edit-body" v-if="edit.nameEnabled">
            <div class="form-row">
              <label>查找</label>
              <input v-model="edit.nameFind" placeholder="如 www" />
            </div>
            <div class="form-row">
              <label>替换为</label>
              <input v-model="edit.nameReplace" placeholder="如 app（留空则删除该部分）" />
            </div>
            <div class="hint">对主机名做子串替换，例如 www.example.com → app.example.com</div>
          </div>
        </div>

        <!-- TTL / 线路 -->
        <div class="edit-grid">
          <div class="edit-block">
            <label class="edit-head">
              <input type="checkbox" v-model="edit.ttlEnabled" />
              <b>TTL</b>
            </label>
            <div class="edit-body" v-if="edit.ttlEnabled">
              <div class="form-row">
                <input v-model.number="edit.ttl" type="number" min="1" max="604800" />
                <div class="hint" v-if="ttlInvalid" style="color: var(--danger)">TTL 必须是 1~604800 的整数</div>
                <div class="hint" v-else>{{ zoned ? '秒，1 = 自动' : '秒（免费套餐最低 600）' }}</div>
              </div>
            </div>
          </div>

          <div class="edit-block" v-if="!zoned">
            <label class="edit-head">
              <input type="checkbox" v-model="edit.lineEnabled" />
              <b>线路</b>
            </label>
            <div class="edit-body" v-if="edit.lineEnabled">
              <div class="form-row">
                <input v-model="edit.line" list="batch-line-options" placeholder="默认" />
                <datalist id="batch-line-options">
                  <option v-for="l in LINE_OPTIONS" :key="l" :value="l"></option>
                </datalist>
              </div>
            </div>
          </div>
        </div>

        <!-- 预览 -->
        <div v-if="anyEnabled" class="preview-box">
          <template v-if="planned.length">
            <table class="preview-table">
              <thead>
                <tr><th>类型</th><th>主机名</th><th>变更内容</th></tr>
              </thead>
              <tbody>
                <tr v-for="(p, i) in previewList" :key="i">
                  <td><span class="type-badge" :class="'t-' + String(p.record.type).toLowerCase()">{{ p.record.type }}</span></td>
                  <td class="mono">{{ p.record.name }}</td>
                  <td>
                    <div v-for="(f, j) in diffFields(p.record, p.changes)" :key="j" class="diff-line">
                      <span class="diff-key">{{ f.key }}</span>
                      <span class="mono before">{{ f.before }}</span>
                      <span class="arrow">→</span>
                      <span class="mono after">{{ f.after }}</span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="more-hint" v-if="planned.length > 8">…另有 {{ planned.length - 8 }} 条，共 {{ planned.length }} 条</div>
          </template>
          <div v-else class="more-hint">按当前设置没有记录会被修改</div>
          <div class="more-hint" v-if="unaffected > 0 && planned.length">（{{ unaffected }} 条不满足条件，将跳过）</div>
        </div>

        <div class="modal-foot">
          <button @click="$emit('close')">取消</button>
          <button
            class="primary"
            :disabled="!planned.length || configInvalid"
            :title="configInvalid ? '请完整填写勾选的修改项' : undefined"
            @click="doApply"
          >
            应用修改（{{ planned.length }} 条）
          </button>
        </div>
      </template>

      <!-- 应用中 / 完成 -->
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
          <button v-if="state === 'done'" class="primary" @click="finish">完成</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.batch-modal { width: 640px; max-width: 94vw; }
.edit-block { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
.edit-head { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.edit-body { margin-top: 8px; padding-left: 4px; }
.edit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.mode-row { display: flex; gap: 16px; font-size: 13px; margin-bottom: 4px; }
.mode-row label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.preview-box { border: 1px solid var(--border); border-radius: 8px; margin-top: 12px; max-height: 240px; overflow: auto; }
.preview-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.preview-table th {
  position: sticky; top: 0; background: var(--bg-2, #f2f4f7);
  text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); font-weight: 500;
}
.preview-table td { padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.diff-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; line-height: 1.8; }
.diff-key { color: var(--text-3); flex-shrink: 0; }
.before { text-decoration: line-through; opacity: 0.55; word-break: break-all; }
.arrow { color: var(--text-3); }
.after { color: var(--green, #16a34a); font-weight: 500; word-break: break-all; }
.mono { font-family: var(--mono); font-size: 12px; }
.more-hint { padding: 8px; text-align: center; color: var(--text-3); font-size: 12px; }
.progress-line { display: flex; align-items: center; gap: 12px; margin: 16px 0 12px; }
.progress-bar { flex: 1; height: 8px; border-radius: 999px; background: #eef1f5; overflow: hidden; }
.progress-fill { height: 100%; background: var(--primary); border-radius: 999px; transition: width 0.2s; }
.progress-fill.done { background: var(--green, #16a34a); }
.progress-text { font-size: 13px; color: var(--text-2); min-width: 70px; text-align: right; }
.result-line { display: flex; gap: 14px; font-size: 13px; margin-bottom: 10px; }
.result-line .ok { color: var(--green, #16a34a); font-weight: 500; }
.result-line .bad { color: var(--danger, #dc2626); font-weight: 500; }
.err-box {
  background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;
  border-radius: 8px; padding: 8px 12px; font-size: 12px; margin-bottom: 10px; line-height: 1.7;
}
.err-box.scrollable { max-height: 160px; overflow: auto; }
@media (max-width: 640px) {
  .edit-grid { grid-template-columns: 1fr; }
}
</style>
