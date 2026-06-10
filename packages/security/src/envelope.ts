import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type CipherGCMTypes,
} from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Envelope encryption for project DB secrets (spec §5.9, §7, §17). Shared by
// gateway-api (encrypt on write) and worker-core (decrypt to connect).
//
//   plaintext --(AES-256-GCM, random DEK)--> data ciphertext
//   DEK       --(AES-256-GCM, master KEK)--> wrapped DEK
//
// The master KEK is read from CONDUCTOR_MASTER_KEY (base64, 32 bytes) — an env
// var locally, a KMS-provided key in prod. Plaintext is decrypted in-memory
// only, never logged or returned.
// ─────────────────────────────────────────────────────────────────────────────

const ALGO: CipherGCMTypes = 'aes-256-gcm';
const IV_LEN = 12; // 96-bit nonce for GCM

interface GcmBlob {
  iv: string;
  ct: string;
  tag: string;
}

export interface EnvelopeCiphertext {
  v: 1;
  keyId: string;
  wrappedDek: GcmBlob;
  data: GcmBlob;
}

// Keyring supports KEK rotation (spec RUNBOOK): the CURRENT key encrypts; the
// stored blob's `keyId` selects the right key to decrypt, so a previous key can
// stay available while secrets are re-encrypted under the new one.
function decode(b64: string): Buffer {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('master key must decode to exactly 32 bytes (AES-256)');
  return k;
}

function currentKeyId(): string {
  return process.env.CONDUCTOR_MASTER_KEY_ID ?? 'dev-local-v1';
}

function keyring(): Map<string, Buffer> {
  const m = new Map<string, Buffer>();
  const curId = currentKeyId();
  if (process.env.CONDUCTOR_MASTER_KEY) m.set(curId, decode(process.env.CONDUCTOR_MASTER_KEY));
  // Optional previous key kept available during rotation. Must NOT overwrite the
  // current key if ids collide (review M13).
  const prevId = process.env.CONDUCTOR_MASTER_KEY_PREVIOUS_ID;
  if (process.env.CONDUCTOR_MASTER_KEY_PREVIOUS && prevId && prevId !== curId) {
    m.set(prevId, decode(process.env.CONDUCTOR_MASTER_KEY_PREVIOUS));
  }
  return m;
}

function currentKey(): { id: string; key: Buffer } {
  const id = currentKeyId();
  const key = keyring().get(id);
  if (!key) throw new Error('CONDUCTOR_MASTER_KEY is not set (32-byte base64 master key)');
  return { id, key };
}

function keyForId(id: string): Buffer {
  const key = keyring().get(id);
  if (!key) throw new Error(`no master key available for keyId '${id}' (rotation: keep the previous key set)`);
  return key;
}

function gcmEncrypt(key: Buffer, plaintext: Buffer): GcmBlob {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function gcmDecrypt(key: Buffer, blob: GcmBlob): Buffer {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]);
}

export function encryptSecret(plaintext: string): EnvelopeCiphertext {
  const { id, key } = currentKey();
  const dek = randomBytes(32);
  const data = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'));
  const wrappedDek = gcmEncrypt(key, dek);
  dek.fill(0);
  return { v: 1, keyId: id, wrappedDek, data };
}

export function decryptSecret(blob: EnvelopeCiphertext): string {
  const kek = keyForId(blob.keyId); // select by keyId — supports rotation
  const dek = gcmDecrypt(kek, blob.wrappedDek);
  try {
    return gcmDecrypt(dek, blob.data).toString('utf8');
  } finally {
    dek.fill(0);
  }
}
