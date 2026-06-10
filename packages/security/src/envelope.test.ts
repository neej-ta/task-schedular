import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CONDUCTOR_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.CONDUCTOR_MASTER_KEY_ID = 'test-v1';

const { encryptSecret, decryptSecret } = await import('./envelope.js');

test('round-trips a secret', () => {
  const secret = 'postgres://user:p@ssw0rd!@db:5432/app';
  assert.equal(decryptSecret(encryptSecret(secret)), secret);
});

test('ciphertext never contains the plaintext', () => {
  const secret = 'super-secret-value';
  const blob = encryptSecret(secret);
  assert.ok(!JSON.stringify(blob).includes(secret));
  assert.equal(blob.keyId, 'test-v1');
});

test('each encryption uses a fresh DEK + IV (distinct ciphertexts)', () => {
  const a = encryptSecret('same');
  const b = encryptSecret('same');
  assert.notDeepEqual(a.data, b.data);
  assert.notDeepEqual(a.wrappedDek, b.wrappedDek);
});

test('tampering with the ciphertext fails decryption', () => {
  const blob = encryptSecret('value');
  const tampered = { ...blob, data: { ...blob.data, ct: Buffer.from('zzzz').toString('base64') } };
  assert.throws(() => decryptSecret(tampered));
});
