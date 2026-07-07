import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { config } from './config.js';

// DEV: single key from env. PROD: swap this for envelope encryption —
// generate a per-record or per-tenant DEK, encrypt the DEK with a KMS key
// (AWS KMS GenerateDataKey / GCP KMS / Vault Transit), and store the
// wrapped DEK alongside the ciphertext. Keep this module as the only
// place in the codebase that touches key material.
const masterKey = Buffer.from(config.masterKeyHex, 'hex');
if (masterKey.length !== 32) {
  throw new Error('MASTER_KEY_HEX must be 32 bytes (64 hex chars)');
}

export const KEY_VERSION = 1;

export interface Ciphertext {
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
}

/**
 * Encrypt with AES-256-GCM. `aad` (additional authenticated data) binds the
 * ciphertext to its context — we pass the connected_account id so a
 * ciphertext copied into another row fails to decrypt.
 */
export function encrypt(plaintext: string, aad: string): Ciphertext {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

export function decrypt(ct: Ciphertext, aad: string): string {
  const decipher = createDecipheriv('aes-256-gcm', masterKey, ct.iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(ct.tag);
  return Buffer.concat([decipher.update(ct.data), decipher.final()]).toString('utf8');
}

// --- Sealed cookies (for the short-lived OAuth state between redirect and callback) ---

export function seal(payload: object): string {
  const ct = encrypt(JSON.stringify(payload), 'cookie');
  return Buffer.concat([ct.iv, ct.tag, ct.data]).toString('base64url');
}

export function unseal<T>(sealed: string): T | null {
  try {
    const buf = Buffer.from(sealed, 'base64url');
    const ct: Ciphertext = {
      iv: buf.subarray(0, 12),
      tag: buf.subarray(12, 28),
      data: buf.subarray(28),
    };
    return JSON.parse(decrypt(ct, 'cookie')) as T;
  } catch {
    return null; // tampered or expired-key cookie: treat as absent
  }
}

// --- PKCE helpers ---

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(24).toString('base64url');
}
