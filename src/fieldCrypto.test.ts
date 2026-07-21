import test from 'node:test';
import assert from 'node:assert/strict';

// fieldCrypto → crypto → config, and config throws on missing env vars.
// Provide dummies (?? so a developer's real .env still wins) before the
// dynamic import below pulls the chain in.
process.env.MASTER_KEY_HEX ??= 'a'.repeat(64);
process.env.DATABASE_URL ??= 'postgres://localhost:5432/test';
process.env.INTERNAL_API_KEY ??= 'test-internal-key';
process.env.GOOGLE_CLIENT_ID ??= 'test';
process.env.GOOGLE_CLIENT_SECRET ??= 'test';
process.env.MS_CLIENT_ID ??= 'test';
process.env.MS_CLIENT_SECRET ??= 'test';

const {
  newRowId,
  fieldAad,
  encryptBuffer,
  decryptBuffer,
  encryptText,
  decryptText,
  encryptNumber,
  decryptNumber,
  encryptJson,
  decryptJson,
} = await import('./fieldCrypto.js');

test('text roundtrip', () => {
  const aad = fieldAad('employees', 'salary', newRowId());
  assert.equal(decryptText(encryptText('hello world', aad), aad), 'hello world');
});

test('number roundtrip preserves NUMERIC string form', () => {
  const aad = fieldAad('employee_bonuses', 'amount', newRowId());
  assert.equal(decryptNumber(encryptNumber('1234.50', aad), aad), '1234.50');
  assert.equal(decryptNumber(encryptNumber(99, aad), aad), '99');
});

test('json roundtrip', () => {
  const aad = fieldAad('employee_contracts', 'extracted', newRowId());
  const value = { employee_name: 'Sara', salary_amount: 1000, nested: { a: [1, 2, 3] } };
  assert.deepEqual(decryptJson(encryptJson(value, aad), aad), value);
});

test('buffer roundtrip is byte-identical', () => {
  const aad = fieldAad('employee_contracts', 'file_data', newRowId());
  const bytes = Buffer.from([0, 1, 2, 255, 254, 37, 0, 128]);
  assert.deepEqual(decryptBuffer(encryptBuffer(bytes, aad), aad), bytes);
});

test('wrong AAD (another row/column) fails to decrypt', () => {
  const packed = encryptText('secret', fieldAad('employees', 'salary', newRowId()));
  assert.throws(() => decryptText(packed, fieldAad('employees', 'salary', newRowId())));
  assert.throws(() => decryptText(packed, fieldAad('employee_bonuses', 'amount', newRowId())));
});

test('tampered ciphertext fails to decrypt', () => {
  const aad = fieldAad('employees', 'salary', newRowId());
  const packed = encryptText('secret', aad);
  const tampered = Buffer.from(packed);
  tampered[tampered.length - 1] ^= 0xff; // flip a data bit
  assert.throws(() => decryptText(tampered, aad));
  const badTag = Buffer.from(packed);
  badTag[12] ^= 0xff; // flip a tag bit
  assert.throws(() => decryptText(badTag, aad));
});
