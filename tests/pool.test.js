import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPool } from '../web/src/pool.js';

// 小工具：可控延时的 promise，用来制造"耗时不确定"的任务
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('并发峰值不超过 limit，且确实并发执行', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let running = 0; // 计数器：进入 worker 加一、完成减一，峰值即最大同时在跑的任务数
  let peak = 0;
  const results = await runPool(items, 4, async (x) => {
    running += 1;
    peak = Math.max(peak, running);
    await delay(10);
    running -= 1;
    return x * 2;
  });
  assert.ok(peak <= 4, `并发峰值 ${peak} 超过 limit 4`);
  assert.ok(peak > 1, '并发峰值为 1，说明退化为串行而非并发池');
  assert.deepEqual(results, items.map((x) => x * 2));
});

test('worker 抛错不影响其它任务，失败项结果为 {error}', async () => {
  const items = ['a', 'bad', 'c', 'd'];
  const seen = [];
  const results = await runPool(items, 2, async (x) => {
    seen.push(x);
    await delay(5);
    if (x === 'bad') throw new Error('boom');
    return x.toUpperCase();
  });
  // 抛错项之后的任务照常执行（没有被中断）
  assert.deepEqual([...seen].sort(), ['a', 'bad', 'c', 'd']);
  assert.equal(results[0], 'A');
  assert.equal(results[2], 'C');
  assert.equal(results[3], 'D');
  assert.ok(results[1].error instanceof Error);
  assert.equal(results[1].error.message, 'boom');
});

test('所有项都被执行，结果顺序与入参一致（乱序完成也不乱序返回）', async () => {
  // 让靠前的项最慢完成：若实现按完成顺序回填结果就会翻车
  const items = [30, 5, 20, 10];
  let executed = 0;
  const results = await runPool(items, 4, async (ms) => {
    await delay(ms);
    executed += 1;
    return `done-${ms}`;
  });
  assert.equal(executed, items.length);
  assert.deepEqual(results, ['done-30', 'done-5', 'done-20', 'done-10']);
});
