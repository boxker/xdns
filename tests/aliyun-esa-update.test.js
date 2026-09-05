// ESA 合并式更新的请求体测试：拦截 fetch，断言实际发给上游的参数
// 重点覆盖两类历史 bug：记录值必须放嵌套 Data、全量更新不能清掉源站配置
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { updateRecordFields, applyRecordPatch, setProxy } from '../src/aliyun-esa.js';

const account = { token: 'LTAI5tTestAccessKeyId,testAccessKeySecret' };
const realFetch = globalThis.fetch;

// 记录每次请求的 action 与参数，GetRecord 返回预设记录
let calls = [];
let currentRecord = {};

function mockFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    const action = opts.headers['x-acs-action'];
    const params = Object.fromEntries(new URLSearchParams(opts.body || new URL(url).search));
    calls.push({ action, params });
    const body =
      action === 'GetRecord'
        ? { RecordModel: currentRecord }
        : action === 'CreateRecord'
          ? { RecordId: 999 }
          : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

beforeEach(() => {
  calls = [];
  mockFetch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const updateCall = () => calls.find((c) => c.action === 'UpdateRecord');

test('合并更新：记录值写入嵌套 Data，顶层无 Value', async () => {
  currentRecord = {
    RecordId: 1, RecordType: 'A', RecordName: 'www.example.com',
    Ttl: 60, Proxied: false, Data: { Value: '1.1.1.1' },
  };
  await updateRecordFields(account, 1, { content: '2.2.2.2' });
  const { params } = updateCall();
  assert.equal(params.Value, undefined);
  assert.deepEqual(JSON.parse(params.Data), { Value: '2.2.2.2' });
  assert.equal(params.Ttl, '60'); // 未指定的字段保持原值
});

test('合并更新：只改 TTL 不会丢记录值', async () => {
  currentRecord = {
    RecordId: 1, RecordType: 'A', RecordName: 'www.example.com',
    Ttl: 1, Data: { Value: '1.1.1.1' },
  };
  await updateRecordFields(account, 1, { ttl: 300 });
  const { params } = updateCall();
  assert.equal(JSON.parse(params.Data).Value, '1.1.1.1');
  assert.equal(params.Ttl, '300');
});

test('开关加速：保留源站配置与鉴权，不被全量更新清掉', async () => {
  currentRecord = {
    RecordId: 1, RecordType: 'CNAME', RecordName: 'cdn.example.com',
    Ttl: 1, Proxied: false, Data: { Value: 'origin.example.com' },
    RecordSourceType: 'OSS', HostPolicy: 'follow_origin_domain',
    AuthConf: { AuthType: 'private_same_account' },
  };
  await setProxy(account, 1, true);
  const { params } = updateCall();
  assert.equal(params.Proxied, 'true');
  assert.equal(params.SourceType, 'OSS'); // 响应侧叫 RecordSourceType，请求侧叫 SourceType
  assert.equal(params.HostPolicy, 'follow_origin_domain');
  assert.deepEqual(JSON.parse(params.AuthConf), { AuthType: 'private_same_account' });
  assert.equal(params.BizName, 'web'); // 开启加速必须带业务场景
  assert.equal(JSON.parse(params.Data).Value, 'origin.example.com');
});

test('合并更新：CAA 的 Flag/Tag 不会在改 TTL 时丢失', async () => {
  currentRecord = {
    RecordId: 2, RecordType: 'CAA', RecordName: 'example.com',
    Ttl: 1, Data: { Value: 'letsencrypt.org', Flag: 128, Tag: 'issuewild' },
  };
  await updateRecordFields(account, 2, { ttl: 600 });
  const data = JSON.parse(updateCall().params.Data);
  assert.equal(data.Flag, 128);
  assert.equal(data.Tag, 'issuewild');
  assert.equal(data.Value, 'letsencrypt.org');
});

test('合并更新：改 CAA 记录值时重新拆解结构', async () => {
  currentRecord = {
    RecordId: 2, RecordType: 'CAA', RecordName: 'example.com',
    Ttl: 1, Data: { Value: 'old.org', Flag: 0, Tag: 'issue' },
  };
  await updateRecordFields(account, 2, { content: '128 issuewild "new.org"' });
  const data = JSON.parse(updateCall().params.Data);
  assert.deepEqual(data, { Flag: 128, Tag: 'issuewild', Value: 'new.org' });
});

test('合并更新：MX 优先级在 Data 内且保留原值', async () => {
  currentRecord = {
    RecordId: 3, RecordType: 'MX', RecordName: 'example.com',
    Ttl: 1, Data: { Value: 'mx.mail.com', Priority: 20 },
  };
  await updateRecordFields(account, 3, { content: 'mx2.mail.com' });
  const data = JSON.parse(updateCall().params.Data);
  assert.equal(data.Priority, 20);
  assert.equal(data.Value, 'mx2.mail.com');
  assert.equal(updateCall().params.Priority, undefined);
});

test('合并更新：类型改为不可代理时移除 Proxied 与 BizName', async () => {
  currentRecord = {
    RecordId: 4, RecordType: 'CNAME', RecordName: 'x.example.com',
    Ttl: 1, Proxied: true, BizName: 'web', Data: { Value: 'a.example.com' },
  };
  await updateRecordFields(account, 4, { type: 'TXT', content: 'hello' });
  const { params } = updateCall();
  assert.equal(params.Proxied, undefined);
  assert.equal(params.BizName, undefined);
  assert.deepEqual(JSON.parse(params.Data), { Value: 'hello' });
});

test('改名：UpdateRecord 不支持改名，走先建后删', async () => {
  currentRecord = {
    RecordId: 5, RecordType: 'A', RecordName: 'old.example.com',
    Ttl: 60, Proxied: false, Data: { Value: '1.2.3.4' },
  };
  await applyRecordPatch(account, {
    recordId: 5, siteId: 100, siteName: 'example.com', patch: { name: 'new.example.com' },
  });
  const actions = calls.map((c) => c.action);
  assert.ok(!actions.includes('UpdateRecord'));
  const create = calls.find((c) => c.action === 'CreateRecord');
  const del = calls.find((c) => c.action === 'DeleteRecord');
  assert.equal(create.params.RecordName, 'new.example.com');
  assert.equal(JSON.parse(create.params.Data).Value, '1.2.3.4'); // 原有记录值被带过去
  assert.equal(create.params.Ttl, '60');
  assert.equal(del.params.RecordId, '5');
  // 先建后删：中途失败不会出现解析空档
  assert.ok(actions.indexOf('CreateRecord') < actions.indexOf('DeleteRecord'));
});

test('改名：同时改记录值时新记录用新值', async () => {
  currentRecord = {
    RecordId: 6, RecordType: 'A', RecordName: 'old.example.com',
    Ttl: 1, Data: { Value: '1.1.1.1' },
  };
  await applyRecordPatch(account, {
    recordId: 6, siteId: 100, siteName: 'example.com',
    patch: { name: 'new', content: '9.9.9.9' },
  });
  const create = calls.find((c) => c.action === 'CreateRecord');
  assert.equal(create.params.RecordName, 'new.example.com'); // 短名展开为 FQDN
  assert.equal(JSON.parse(create.params.Data).Value, '9.9.9.9');
});

test('改名：名称等价（短名与 FQDN）时走普通更新，不重建', async () => {
  currentRecord = {
    RecordId: 7, RecordType: 'A', RecordName: 'www.example.com',
    Ttl: 1, Data: { Value: '1.1.1.1' },
  };
  await applyRecordPatch(account, {
    recordId: 7, siteId: 100, siteName: 'example.com',
    patch: { name: 'www', ttl: 300 },
  });
  const actions = calls.map((c) => c.action);
  assert.ok(actions.includes('UpdateRecord'));
  assert.ok(!actions.includes('CreateRecord'));
  assert.ok(!actions.includes('DeleteRecord'));
});
