import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeToken, isValidToken, parseCredentials, toCommon, fromCommon, parseCaaContent,
} from '../src/aliyun-esa.js';

test('ESA 凭证规范化与校验', () => {
  assert.equal(normalizeToken(' LTAI5t，secret '), 'LTAI5t,secret'); // 全角逗号 + 空白
  assert.ok(isValidToken('LTAI5tAbCdEfGhIjKlMnOpQrSt,abcDEF123xyz'));
  assert.ok(!isValidToken('LTAI5tAbCdEfGhIjKlMnOpQrSt')); // 缺 Secret
  assert.ok(!isValidToken(',secret')); // 缺 AccessKeyId
  assert.ok(!isValidToken('id,se,cret')); // 多余逗号
});

test('ESA parseCredentials 拆分', () => {
  const { accessKeyId, accessKeySecret } = parseCredentials('LTAI5tAbCdEfGhIjKlMnOpQrSt,s3cr3t');
  assert.equal(accessKeyId, 'LTAI5tAbCdEfGhIjKlMnOpQrSt');
  assert.equal(accessKeySecret, 's3cr3t');
  assert.deepEqual(parseCredentials('broken'), {});
});

test('ESA toCommon 字段映射（记录值在 Data.value）', () => {
  const r = toCommon({
    RecordId: 1234567890123,
    RecordType: 'A',
    RecordName: 'www.example.com',
    Ttl: 30,
    Proxied: true,
    Comment: '主站',
    Data: { Value: '1.2.3.4' },
  });
  assert.equal(r.id, '1234567890123');
  assert.equal(r.provider, 'aliyun-esa');
  assert.equal(r.type, 'A');
  assert.equal(r.name, 'www.example.com');
  assert.equal(r.content, '1.2.3.4');
  assert.equal(r.ttl, 30);
  assert.equal(r.proxied, true);
  assert.equal(r.status, 'enabled');
  assert.equal(r.remark, '主站');
  assert.equal(r.line, null);
});

test('ESA toCommon：TTL=1 表示自动，MX 优先级在 Data.priority', () => {
  const r = toCommon({
    RecordId: 1, RecordType: 'MX', RecordName: 'example.com',
    Ttl: 1, Data: { Value: 'mx1.mail.com', Priority: 15 },
  });
  assert.equal(r.ttl, 1);
  assert.equal(r.mx, 15);
  assert.equal(r.proxied, false);
});

test('ESA toCommon：CAA 从结构化 Data 还原为通用格式', () => {
  const r = toCommon({
    RecordId: 2, RecordType: 'CAA', RecordName: 'example.com',
    Data: { Value: 'letsencrypt.org', Flag: 0, Tag: 'issue' },
  });
  assert.equal(r.content, '0 issue "letsencrypt.org"');
});

test('ESA fromCommon：主机名展开为 FQDN', () => {
  const site = 'example.com';
  assert.equal(fromCommon({ type: 'A', name: 'www.example.com', content: '1.2.3.4' }, site).RecordName, 'www.example.com');
  assert.equal(fromCommon({ type: 'A', name: 'www', content: '1.2.3.4' }, site).RecordName, 'www.example.com');
  assert.equal(fromCommon({ type: 'A', name: '@', content: '1.2.3.4' }, site).RecordName, 'example.com');
  assert.equal(fromCommon({ type: 'A', name: 'example.com.', content: '1.2.3.4' }, site).RecordName, 'example.com'); // 尾点归一
  assert.equal(fromCommon({ type: 'A', name: '*.example.com', content: '1.2.3.4' }, site).RecordName, '*.example.com');
});

test('ESA fromCommon：记录值放在嵌套 Data.Value，不是顶层 Value', () => {
  const p = fromCommon({ type: 'A', name: 'www', content: '1.2.3.4' }, 'example.com');
  assert.deepEqual(p.Data, { Value: '1.2.3.4' });
  assert.equal(p.Value, undefined); // 顶层不存在 Value 参数
  assert.equal(p.Ttl, 1); // CreateRecord 的 Ttl 必填，缺省为自动
});

test('ESA fromCommon：TTL/代理/优先级/备注', () => {
  const p = fromCommon({ type: 'A', name: 'www', content: '1.2.3.4', ttl: 1, proxied: true, remark: '官网' }, 'example.com');
  assert.equal(p.Ttl, 1);
  assert.equal(p.Proxied, true);
  assert.equal(p.BizName, 'web'); // 开启加速必须带业务场景
  assert.equal(p.Comment, '官网');
  const mx = fromCommon({ type: 'MX', name: '@', content: 'mx.mail.com', mx: 20 }, 'example.com');
  assert.equal(mx.Data.Priority, 20); // 优先级也在 Data 内
  assert.equal(mx.Priority, undefined);
  assert.equal(mx.Proxied, undefined); // MX 不可代理
  assert.equal(mx.BizName, undefined);
});

test('ESA fromCommon：CAA 拆解为结构化 Data', () => {
  const p = fromCommon({ type: 'CAA', name: '@', content: '0 issue "letsencrypt.org"' }, 'example.com');
  assert.deepEqual(p.Data, { Flag: 0, Tag: 'issue', Value: 'letsencrypt.org' });
  assert.equal(p.Value, undefined);
});

test('ESA fromCommon：CAA 值后带分号注释仍能拆解', () => {
  const p = fromCommon({ type: 'CAA', name: '@', content: '128 issuewild "ca.com"; policy' }, 'example.com');
  assert.deepEqual(p.Data, { Flag: 128, Tag: 'issuewild', Value: 'ca.com' });
});

test('ESA parseCaaContent：非法格式返回 null', () => {
  assert.equal(parseCaaContent('not a caa value'), null);
  assert.deepEqual(parseCaaContent('0 issue "le.org"'), { Flag: 0, Tag: 'issue', Value: 'le.org' });
});

test('ESA toCommon：SRV/URI 的优先级也映射到 mx', () => {
  const srv = toCommon({
    RecordId: 3, RecordType: 'SRV', RecordName: '_sip._tcp.example.com',
    Data: { Value: 'sip.example.com', Priority: 5, Weight: 10, Port: 5060 },
  });
  assert.equal(srv.mx, 5);
});
