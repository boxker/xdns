<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';

// 批量操作结果弹窗（U2：失败明细可见）
// 由父组件在批量删除 / 启停 / 加速等操作出现失败时打开，
// 展示成功/失败统计与逐条失败原因，避免只给一个 toast 汇总、失败原因完全不可见
const props = defineProps({
  title: { type: String, required: true },   // 弹窗标题，如「批量删除结果」
  ok: { type: Number, default: 0 },          // 成功条数
  fails: { type: Array, default: () => [] }, // 失败明细，每条格式「类型 主机名:原因」
});
const emit = defineEmits(['close']);

const copied = ref(false); // 复制成功后按钮文字短暂变为「已复制」，给出明确反馈
let copiedTimer = null;

async function copyFails() {
  try {
    await navigator.clipboard.writeText(props.fails.join('\n'));
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* 剪贴板权限被拒（如非安全上下文）时静默失败，用户仍可手动选中文本复制 */
  }
}

// Esc 关闭：与 ImportRecords 等现有弹窗的键盘行为保持一致
function onKeydown(e) {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal batch-result-modal">
      <h3>{{ title }}</h3>

      <!-- 成功 / 失败统计 -->
      <div class="stat-line">
        <span class="ok">成功 {{ ok }} 条</span>
        <span class="bad">失败 {{ fails.length }} 条</span>
      </div>

      <!-- 失败明细：条数可能很多，限高内部滚动 -->
      <div class="err-box scrollable">
        <div v-for="(f, i) in fails" :key="i">✕ {{ f }}</div>
      </div>

      <div class="modal-foot">
        <button class="ghost" @click="copyFails">{{ copied ? '已复制' : '复制失败明细' }}</button>
        <button class="primary" @click="$emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 尺寸与 ImportRecords 弹窗同一档位，保持视觉一致 */
.batch-result-modal { width: 480px; }
.stat-line { display: flex; gap: 14px; font-size: 13px; margin-bottom: 10px; }
.stat-line .ok { color: var(--green); font-weight: 500; }
.stat-line .bad { color: var(--danger); font-weight: 500; }
/* 与 ImportRecords 的 err-box 同风格：红底列表呈现失败原因 */
.err-box {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.7;
}
.err-box.scrollable { max-height: 200px; overflow: auto; }
</style>
