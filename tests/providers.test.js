import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToken, isValidToken, toCommon, fromCommon } from '../src/dnspod.js';
import { toCommon as cfToCommon, fromCommon as cfFromCommon } from '../src/cloudflare.js';

test('DNSPod Token 规范化与校验', () => {
  assert.equal(normalizeToken('123456，TOKEN'), '123456,TOKEN'); // 全角逗号
  assert.equal(normalizeToken(' 123456 , token '), '123456,token');
  assert.ok(isValidToken('123456,abcdef'));
  assert.ok(!isValidToken('abcdef')); // 只有后半段
  assert.ok(!isValidToken('123456,a,b')); // 多余逗号
});

test('DNSPod fromCommon 子域名转换', () => {
  const domain = 'example.com';
  assert.equal(fromCommon({ name: 'www.example.com' }, domain).name, 'www');
  assert.equal(fromCommon({ name: '@' }, domain).name, '@');
  assert.equal(fromCommon({ name: 'example.com' }, domain).name, '@');
  assert.equal(fromCommon({ name: 'www.example.com.', }, domain).name, 'www.example.com.'); // 尾点不特殊处理
});

test('DNSPod toCommon 还原完整主机名', () => {
  const full = toCommon({ id: 1, name: 'www', value: '1.2.3.4', ttl: '600', status: 'enable', line: '默认', type: 'A' }, 'example.com');
  assert.equal(full.name, 'www.example.com');
  assert.equal(full.status, 'enabled');
  const root = toCommon({ id: 2, name: '@', value: '1.1.1.1', ttl: '600', status: 'pause', type: 'A' }, 'example.com');
  assert.equal(root.name, 'example.com');
  assert.equal(root.status, 'disabled');
});

test('DNSPod fromCommon 备注透传', () => {
  const r = fromCommon({ name: 'www', type: 'A', content: '1.2.3.4', remark: '官网' }, 'example.com');
  assert.equal(r.remark, '官网');
});

test('Cloudflare fromCommon 部分字段（批量改 TTL）', () => {
  assert.deepEqual(cfFromCommon({ ttl: 300 }), { ttl: 300 });
  assert.equal(cfFromCommon({ proxied: true }).proxied, true);
});

test('Cloudflare fromCommon 完整字段与备注', () => {
  const body = cfFromCommon({ type: 'CNAME', name: 'a.com', content: 'b.com', ttl: 600, proxied: false, remark: '测试' });
  assert.equal(body.comment, '测试');
  assert.equal(body.content, 'b.com');
  const mx = cfFromCommon({ type: 'MX', name: 'a.com', content: 'mx.b.com', mx: 20 });
  assert.equal(mx.priority, 20);
});

test('Cloudflare toCommon 字段映射', () => {
  const r = cfToCommon({ id: 'x', type: 'MX', name: 'a.com', content: 'mx.b.com', priority: 15, ttl: 1, comment: 'hi' });
  assert.equal(r.mx, 15);
  assert.equal(r.remark, 'hi');
  assert.equal(r.ttl, 1);
});
