import { randomUUID } from 'node:crypto';
import { encryptBytes, decryptBytes } from './crypto.js';

/**
 * At-rest field encryption for the high-sensitivity columns (employee
 * salaries, contract PDFs, extracted contract JSON). One packed BYTEA per
 * field: iv(12) || tag(16) || data — the same layout crypto.ts already uses
 * for sealed cookies.
 *
 * AAD binds a ciphertext to its exact cell: `${table}.${column}:${rowId}`.
 * A value copied into another row/column fails to decrypt. The AAD
 * deliberately does NOT include user_id: scripts/seedSingleUser.ts reassigns
 * employees.user_id wholesale, and a user_id-bound AAD would brick every
 * ciphertext it touches. Row ids are generated app-side (newRowId) and
 * inserted explicitly so the AAD is known before the INSERT.
 */

export function newRowId(): string {
  return randomUUID();
}

export function fieldAad(table: string, column: string, rowId: string): string {
  return `${table}.${column}:${rowId}`;
}

const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptBuffer(plain: Buffer, aad: string): Buffer {
  const ct = encryptBytes(plain, aad);
  return Buffer.concat([ct.iv, ct.tag, ct.data]);
}

export function decryptBuffer(packed: Buffer, aad: string): Buffer {
  return decryptBytes(
    {
      iv: packed.subarray(0, IV_LEN),
      tag: packed.subarray(IV_LEN, IV_LEN + TAG_LEN),
      data: packed.subarray(IV_LEN + TAG_LEN),
    },
    aad,
  );
}

export function encryptText(text: string, aad: string): Buffer {
  return encryptBuffer(Buffer.from(text, 'utf8'), aad);
}

export function decryptText(packed: Buffer, aad: string): string {
  return decryptBuffer(packed, aad).toString('utf8');
}

/**
 * NUMERIC values are stored as their exact string form (pg already returns
 * NUMERIC as string), so no float rounding sneaks in across a roundtrip.
 */
export function encryptNumber(n: number | string, aad: string): Buffer {
  return encryptText(String(n), aad);
}

export function decryptNumber(packed: Buffer, aad: string): string {
  return decryptText(packed, aad);
}

export function encryptJson(value: unknown, aad: string): Buffer {
  return encryptText(JSON.stringify(value), aad);
}

export function decryptJson<T>(packed: Buffer, aad: string): T {
  return JSON.parse(decryptText(packed, aad)) as T;
}
