import { test } from 'node:test';
import assert from 'node:assert/strict';

// 必须在导入被测模块前设置，主密钥由此派生
process.env.XDNS_SECRET = 'unit-test-master-key';
const { encrypt, decrypt } = await import('../src/crypto.js');

test('encrypt/decrypt 往返一致', () => {
  const cases = ['simple-token', '123456,AAAAAAAAAAAAAAAA', '中文令牌🔐', 'a'.repeat(500), ''];
  for (const c of cases) {
    const enc = encrypt(c);
    if (c === '') {
      assert.equal(enc, '');
      continue;
    }
    assert.ok(enc.startsWith('enc:v1:'), '密文应带版本前缀');
    assert.notEqual(enc, c);
    assert.equal(decrypt(enc), c);
  }
});

test('同一明文两次加密产生不同密文（随机 IV）', () => {
  assert.notEqual(encrypt('same'), encrypt('same'));
});

test('兼容历史明文：无前缀原样返回', () => {
  assert.equal(decrypt('legacy-plaintext-token'), 'legacy-plaintext-token');
});

test('密钥不匹配时返回空串而非抛错', async () => {
  const enc = encrypt('secret-value');
  // 换一个主密钥重新加载模块（ESM 缓存按 URL，用查询串绕开）
  process.env.XDNS_SECRET = 'another-key';
  const { decrypt: decryptOther } = await import('../src/crypto.js?rotated=1');
  assert.equal(decryptOther(enc), '');
  // 恢复原密钥供后续测试
  process.env.XDNS_SECRET = 'unit-test-master-key';
});
