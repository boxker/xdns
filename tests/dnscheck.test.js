import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchValues, formatCaaRecords } from '../src/dnscheck.js';

// 只测纯函数：lookup 依赖公网递归解析，不在单测范围。

test('formatCaaRecords：单 tag（critical 0 + issue）', () => {
  assert.deepEqual(
    formatCaaRecords([{ critical: 0, issue: 'letsencrypt.org' }]),
    ['0 issue "letsencrypt.org"'],
  );
});

test('formatCaaRecords：同一记录多个 tag 同时存在都要输出', () => {
  assert.deepEqual(
    formatCaaRecords([{ critical: 0, issue: 'ca.com', iodef: 'mailto:sec@example.com' }]),
    ['0 issue "ca.com"', '0 iodef "mailto:sec@example.com"'],
  );
});

test('formatCaaRecords：critical=128 原样输出标志位', () => {
  assert.deepEqual(
    formatCaaRecords([{ critical: 128, issuewild: 'ca.com' }]),
    ['128 issuewild "ca.com"'],
  );
});

test('formatCaaRecords：多条记录扁平展开', () => {
  assert.deepEqual(
    formatCaaRecords([
      { critical: 0, issue: 'ca.com' },
      { critical: 0, iodef: 'mailto:sec@example.com' },
    ]),
    ['0 issue "ca.com"', '0 iodef "mailto:sec@example.com"'],
  );
});

test('formatCaaRecords：空数组与空入参返回空列表', () => {
  assert.deepEqual(formatCaaRecords([]), []);
  assert.deepEqual(formatCaaRecords(undefined), []);
});

test('formatCaaRecords：value 为数组时先拼接再输出（防御性）', () => {
  assert.deepEqual(
    formatCaaRecords([{ critical: 0, issue: ['ca', '.com'] }]),
    ['0 issue "ca.com"'],
  );
});

test('matchValues：CAA 配置值与解析值精确命中', () => {
  // resolved 是公网解析值数组（lookup 返回的 values），configured 是面板里的单条配置值
  assert.equal(matchValues('0 issue "ca.com"', ['0 issue "ca.com"']), true);
});

test('matchValues：值不同则不命中', () => {
  assert.equal(matchValues('0 issue "ca.com"', ['0 issue "other-ca.com"']), false);
  assert.equal(matchValues('1.2.3.4', ['5.6.7.8', '9.9.9.9']), false);
});

test('matchValues：大小写与尾点归一后命中', () => {
  assert.equal(matchValues('Example.COM.', ['example.com']), true);
});

test('matchValues：MX 带优先级前缀命中（endsWith 路径）', () => {
  assert.equal(matchValues('mxbiz1.qq.com', ['10 mxbiz1.qq.com.']), true);
});

test('matchValues：MX 优先级前缀不同但主机相同仍命中', () => {
  // 前缀是运营商可能调整的优先级数字，只比对主机名部分，避免误报"不一致"
  assert.equal(matchValues('mxdomain.qq.com', ['5 mxdomain.qq.com']), true);
});
