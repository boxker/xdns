import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommonRecord, isValidHostname } from '../src/validate.js';

const ok = (r, opts) => assert.doesNotThrow(() => validateCommonRecord(r, opts));

function fails(r, opts, needle) {
  assert.throws(
    () => validateCommonRecord(r, opts),
    (e) => e.status === 400 && (!needle || e.message.includes(needle))
  );
}

test('完整合法记录通过', () => {
  ok({ type: 'A', name: 'www.example.com', content: '1.2.3.4', ttl: 600 });
  ok({ type: 'AAAA', name: 'v6.example.com', content: '2606:4700::6810:84e5', ttl: 1 });
  ok({ type: 'CNAME', name: 'cdn.example.com', content: 'target.example.net.', ttl: 300 });
  ok({ type: 'MX', name: '@', content: 'mx.example.com', mx: 10, ttl: 600 });
  ok({ type: 'TXT', name: '_acme.example.com', content: 'v=spf1 include:example.com ~all', ttl: 600 });
  ok({ type: 'CAA', name: 'example.com', content: '0 issue "letsencrypt.org"', ttl: 3600 });
  ok({ type: 'A', name: '*.example.com', content: '1.1.1.1' });
});

test('A/AAAA 记录值必须是 IP', () => {
  fails({ type: 'A', name: 'a.com', content: 'not-an-ip' }, undefined, 'IPv4');
  fails({ type: 'A', name: 'a.com', content: '2606:4700::1' }, undefined, 'IPv4');
  fails({ type: 'AAAA', name: 'a.com', content: '1.2.3.4' }, undefined, 'IPv6');
});

test('CNAME/NS/MX 记录值必须是域名', () => {
  fails({ type: 'CNAME', name: 'c.com', content: '1.2.3.4' }, undefined, '域名'); // 不能是 IP
  fails({ type: 'MX', name: '@', content: '-bad.com' }, undefined, '域名');
  fails({ type: 'NS', name: 'c.com', content: 'bad..name' }, undefined, '域名');
});

test('CAA 格式校验', () => {
  fails({ type: 'CAA', name: 'x.com', content: 'letsencrypt.org' }, undefined, 'CAA');
  ok({ type: 'CAA', name: 'x.com', content: '0 issuewild ";"' });
});

test('主机名校验', () => {
  fails({ type: 'A', name: '-bad.example.com', content: '1.2.3.4' }, undefined, '主机名');
  fails({ type: 'A', name: 'a..b', content: '1.2.3.4' }, undefined, '主机名');
  assert.ok(isValidHostname('@'));
  assert.ok(isValidHostname('www.example.com.'));
  assert.ok(isValidHostname('www')); // DNSPod 单标签子域
  assert.ok(isValidHostname('*.example.com'));
  assert.ok(!isValidHostname(''));
  assert.ok(!isValidHostname('a'.repeat(64) + '.com'));
});

test('TTL 与 MX 范围', () => {
  fails({ type: 'A', name: 'a.com', content: '1.2.3.4', ttl: 0 }, undefined, 'TTL');
  fails({ type: 'A', name: 'a.com', content: '1.2.3.4', ttl: 700000 }, undefined, 'TTL');
  fails({ type: 'A', name: 'a.com', content: '1.2.3.4', ttl: 1.5 }, undefined, 'TTL');
  fails({ type: 'MX', name: '@', content: 'mx.x.com', mx: 70000 }, undefined, '优先级');
  ok({ type: 'MX', name: '@', content: 'mx.x.com', mx: 0 });
});

test('partial 模式允许部分字段（批量改 TTL 场景）', () => {
  ok({ ttl: 300 }, { partial: true });
  fails({ ttl: 'abc' }, { partial: true }, 'TTL');
  fails({ remark: 'x'.repeat(300) }, { partial: true }, '备注');
  // 非 partial 时必须齐全
  fails({ ttl: 300 }, undefined, '类型');
});

test('缺少必填字段', () => {
  fails({ type: 'A', name: 'a.com' }, undefined, '记录值');
  fails({ type: 'A', content: '1.2.3.4' }, undefined, '主机名');
});

test('类型与 proxied 格式', () => {
  fails({ type: 'not!a@type', name: 'a.com', content: '1.2.3.4' }, undefined, '类型');
  fails({ type: 'A', name: 'a.com', content: '1.2.3.4', proxied: 'yes' }, undefined, '布尔');
});

test('线路', () => {
  ok({ type: 'A', name: 'a.com', content: '1.2.3.4', line: '电信' });
  fails({ type: 'A', name: 'a.com', content: '1.2.3.4', line: '  ' }, undefined, '线路');
});
