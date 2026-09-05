import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChanges, isConfigValid } from '../web/src/batchEdit.js';

const rec = (over = {}) => ({
  type: 'A', name: 'www.example.com', content: '1.2.3.4', ttl: 600, line: '默认', ...over,
});

test('记录值精确替换：只命中完全相等的记录', () => {
  const edit = { contentEnabled: true, contentMode: 'exact', contentOld: '1.2.3.4', contentNew: '5.6.7.8' };
  assert.deepEqual(computeChanges(edit, rec()), { content: '5.6.7.8' });
  assert.deepEqual(computeChanges(edit, rec({ content: '9.9.9.9' })), {}); // 不匹配 → 跳过
  assert.deepEqual(computeChanges(edit, rec({ content: '5.6.7.8' })), {}); // 已是目标值 → 无变更
});

test('记录值统一设置：所有选中记录改为新值', () => {
  const edit = { contentEnabled: true, contentMode: 'all', contentOld: '', contentNew: '5.6.7.8' };
  assert.deepEqual(computeChanges(edit, rec({ content: '9.9.9.9' })), { content: '5.6.7.8' });
});

test('主机名查找替换', () => {
  const edit = { nameEnabled: true, nameFind: 'www', nameReplace: 'app' };
  assert.deepEqual(computeChanges(edit, rec()), { name: 'app.example.com' });
  // 子串出现在多处时全部替换
  assert.deepEqual(
    computeChanges(edit, rec({ name: 'www.www.example.com' })).name,
    'app.app.example.com'
  );
  // 不包含查找串 → 跳过
  assert.deepEqual(computeChanges(edit, rec({ name: 'api.example.com' })), {});
});

test('TTL / 线路（DNSPod）', () => {
  assert.deepEqual(computeChanges({ ttlEnabled: true, ttl: 300 }, rec()), { ttl: 300 });
  assert.deepEqual(computeChanges({ ttlEnabled: true, ttl: 600 }, rec()), {}); // 相同值无变更
  assert.deepEqual(computeChanges({ lineEnabled: true, line: '电信' }, rec()), { line: '电信' });
  // Cloudflare 无线路概念，即使开启也不生效
  assert.deepEqual(computeChanges({ lineEnabled: true, line: '电信' }, rec(), { provider: 'cloudflare' }), {});
});

test('多维度组合：只输出发生变化的字段', () => {
  const edit = {
    contentEnabled: true, contentMode: 'exact', contentOld: '1.2.3.4', contentNew: '5.6.7.8',
    ttlEnabled: true, ttl: 300,
  };
  assert.deepEqual(computeChanges(edit, rec()), { content: '5.6.7.8', ttl: 300 });
});

test('未启用任何维度 → 无变更', () => {
  assert.deepEqual(computeChanges({}, rec()), {});
});

test('配置校验', () => {
  assert.ok(isConfigValid({}));
  // 记录值：新值必填；精确模式旧值必填
  assert.ok(!isConfigValid({ contentEnabled: true, contentMode: 'exact', contentOld: '', contentNew: 'x' }));
  assert.ok(!isConfigValid({ contentEnabled: true, contentMode: 'exact', contentOld: 'a', contentNew: '' }));
  assert.ok(isConfigValid({ contentEnabled: true, contentMode: 'exact', contentOld: 'a', contentNew: 'x' }));
  // 主机名查找必填
  assert.ok(!isConfigValid({ nameEnabled: true, nameFind: ' ' }));
  // TTL 范围
  assert.ok(!isConfigValid({ ttlEnabled: true, ttl: 0 }));
  assert.ok(!isConfigValid({ ttlEnabled: true, ttl: 999999 }));
  assert.ok(isConfigValid({ ttlEnabled: true, ttl: 1 }));
  // DNSPod 线路必填；Cloudflare 忽略线路配置
  assert.ok(!isConfigValid({ lineEnabled: true, line: ' ' }));
  assert.ok(isConfigValid({ lineEnabled: true, line: ' ' }, { provider: 'cloudflare' }));
});
