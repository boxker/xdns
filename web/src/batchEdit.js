// 批量编辑的变更计算（纯函数，可被 Node 直接测试）
// edit 配置见 BatchEditRecords.vue；返回某条记录实际会发生的字段变更
export function computeChanges(edit, r, { provider = 'dnspod' } = {}) {
  const changes = {};
  // CF 与 ESA：无分线路，TTL=1 表示自动，走局部字段更新
  const zoned = provider === 'cloudflare' || provider === 'aliyun-esa';

  if (edit.contentEnabled) {
    const next = String(edit.contentNew || '').trim();
    if (next && next !== r.content) {
      if (edit.contentMode === 'all' || r.content === String(edit.contentOld || '').trim()) {
        changes.content = next;
      }
    }
  }

  if (edit.nameEnabled) {
    const find = String(edit.nameFind || '');
    if (find && r.name.includes(find)) {
      const next = r.name.split(find).join(edit.nameReplace);
      if (next && next !== r.name) changes.name = next;
    }
  }

  if (edit.ttlEnabled && Number(edit.ttl) !== r.ttl) changes.ttl = Number(edit.ttl);

  if (!zoned && edit.lineEnabled) {
    const next = String(edit.line || '').trim();
    if (next && next !== (r.line || '默认')) changes.line = next;
  }

  return changes;
}

export function isConfigValid(edit, { provider = 'dnspod' } = {}) {
  const zoned = provider === 'cloudflare' || provider === 'aliyun-esa';
  if (edit.contentEnabled) {
    if (!String(edit.contentNew || '').trim()) return false;
    if (edit.contentMode === 'exact' && !String(edit.contentOld || '').trim()) return false;
  }
  if (edit.nameEnabled && !String(edit.nameFind || '').trim()) return false;
  if (edit.ttlEnabled) {
    const n = Number(edit.ttl);
    if (!Number.isInteger(n) || n < 1 || n > 604800) return false;
  }
  if (!zoned && edit.lineEnabled && !String(edit.line || '').trim()) return false;
  return true;
}
