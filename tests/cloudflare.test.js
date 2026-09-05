// Cloudflare 请求层兜底测试：拦截 fetch，模拟断网 / 被墙返回 HTML / 上游业务错误
// 只覆盖 cfRequest 的错误包装与超时接线；toCommon/fromCommon 映射见 providers.test.js，不重复
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { listZones } from '../src/cloudflare.js';

const account = { token: 'cf-test-token' };
const realFetch = globalThis.fetch;

// 记录每次请求的参数，便于断言超时 signal 确实传给了 fetch
let calls = [];

function mockFetch(impl) {
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    return impl(url, opts);
  };
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  // 恢复真实 fetch，避免 mock 泄漏到后续测试
  globalThis.fetch = realFetch;
});

test('网络异常：包装为中文 502 提示', async () => {
  mockFetch(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.cloudflare.com')));
  await assert.rejects(listZones(account), (err) => {
    assert.equal(err.status, 502);
    assert.ok(err.message.includes('无法连接'));
    assert.ok(err.message.includes('getaddrinfo ENOTFOUND')); // 原始原因保留，便于排查
    return true;
  });
});

test('超时中断：TimeoutError 归一为「请求超时」', async () => {
  // 模拟 undici 超时抛出的 DOMException（name 为 TimeoutError），不必真等 10s
  const te = new Error('The operation was aborted due to timeout');
  te.name = 'TimeoutError';
  mockFetch(() => Promise.reject(te));
  await assert.rejects(listZones(account), (err) => {
    assert.equal(err.status, 502);
    assert.ok(err.message.includes('请求超时'));
    return true;
  });
});

test('被墙/代理返回 HTML：JSON 解析失败给中文 502', async () => {
  mockFetch(async () => ({
    ok: true,
    status: 502,
    text: async () => '<html>502 Bad Gateway</html>',
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); }, // 与真实 Response 行为一致
  }));
  await assert.rejects(listZones(account), (err) => {
    assert.equal(err.status, 502);
    assert.ok(err.message.includes('返回异常'));
    assert.ok(err.message.includes('502')); // 携带上游 HTTP 状态便于定位
    return true;
  });
});

test('上游 success:false：错误信息透传，状态码沿用 HTTP 状态', async () => {
  mockFetch(async () => ({
    ok: false,
    status: 400,
    json: async () => ({ success: false, errors: [{ message: 'Invalid API Token' }] }),
  }));
  await assert.rejects(listZones(account), (err) => {
    assert.equal(err.message, 'Invalid API Token');
    assert.equal(err.status, 400);
    return true;
  });
});

test('请求接线：fetch 收到超时 signal 与鉴权头', async () => {
  mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: [], result_info: { total_count: 0 } }),
  }));
  await listZones(account);
  const { opts } = calls[0];
  assert.ok(opts.signal instanceof AbortSignal); // 10s 超时保护已生效
  assert.equal(opts.headers.Authorization, 'Bearer cf-test-token');
});
