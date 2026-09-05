// 固定并发池：逐个取出 items 交给 worker，任意时刻在跑的不超过 limit；
// worker 抛错不中断其它任务，结果数组按 items 原顺序对应（失败项为 {error}）
export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  // 共享游标：每条"泳道"循环取下一个未处理的下标，天然保证同一时刻至多 limit 个 worker 在跑
  let next = 0;
  // 泳道数取 min(limit, items.length)：任务比 limit 还少时不多开空转泳道；
  // 至少 1 条（limit <= 0 时兜底），否则任务永远无人处理
  const lanes = Math.max(1, Math.min(limit, items.length));
  const runners = [];
  for (let lane = 0; lane < lanes; lane += 1) {
    runners.push((async () => {
      while (true) {
        const i = next;
        if (i >= items.length) return;
        next += 1;
        try {
          // 错误就地捕获：单条失败只影响自己的结果槽位，不中断其它任务
          results[i] = await worker(items[i], i);
        } catch (e) {
          results[i] = { error: e };
        }
      }
    })());
  }
  await Promise.all(runners);
  return results;
}
