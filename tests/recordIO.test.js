import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordsText, toCsvExport, parseCsvLine } from '../web/src/recordIO.js';

test('CSV 解析（含引号转义与 remark 列）', () => {
  const csv = 'type,name,content,ttl,proxied,line,mx,remark\nA,www,1.2.3.4,600,false,默认,,官网\nTXT,_d,"v=spf1 a, mx",600,false,默认,,\n';
  const { records, errors } = parseRecordsText(csv);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 2);
  assert.equal(records[0].remark, '官网');
  assert.equal(records[1].content, 'v=spf1 a, mx');
});

test('CSV 引号内双引号转义', () => {
  assert.deepEqual(parseCsvLine('a,"b""c",d'), ['a', 'b"c', 'd']);
});

test('JSON 解析（records 数组 / zones 格式）', () => {
  const a = parseRecordsText('[{"type":"A","name":"www","content":"1.1.1.1"}]');
  assert.equal(a.records.length, 1);
  const b = parseRecordsText('{"zones":{"a.com":[{"type":"A","name":"www","content":"1.1.1.1","remark":"r"}]}}');
  assert.equal(b.records.length, 1);
  assert.equal(b.records[0].remark, 'r');
});

test('重复检测：文件内重复与已有记录重复都标记 _dup', () => {
  const csv = 'type,name,content\nA,www,1.1.1.1\nA,www,1.1.1.1\n';
  const { records } = parseRecordsText(csv, [{ type: 'A', name: 'x', content: '2.2.2.2' }]);
  assert.equal(records[0]._dup, false);
  assert.equal(records[1]._dup, true);
});

test('非法类型 / 缺字段进入 errors', () => {
  const csv = 'type,name,content\nSOA,www,1.1.1.1\nA,,1.1.1.1\n';
  const { records, errors } = parseRecordsText(csv);
  assert.equal(records.length, 0);
  assert.equal(errors.length, 2);
});

test('导出 CSV 含 remark 列且可再导入（往返）', () => {
  const recs = [{ type: 'A', name: 'www', content: '1.1.1.1', ttl: 600, proxied: false, line: '默认', mx: null, remark: '官网' }];
  const csv = toCsvExport(recs);
  assert.ok(csv.startsWith('type,name,content,ttl,proxied,line,mx,remark'));
  const { records } = parseRecordsText(csv);
  assert.equal(records[0].remark, '官网');
});
