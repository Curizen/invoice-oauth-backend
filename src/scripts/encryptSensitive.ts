import 'dotenv/config';
import { pool } from '../db.js';
import {
  fieldAad,
  encryptNumber,
  encryptBuffer,
  encryptJson,
  decryptNumber,
  decryptBuffer,
  decryptJson,
} from '../fieldCrypto.js';

// One-off (but rerunnable) backfill: encrypt every plaintext value of the
// sensitive employee columns into its *_enc twin, verify nothing was missed
// and that a sample decrypts, then DROP the plaintext columns. Run AFTER
// db:migrate has applied migration_008 and with the app STOPPED (old code
// still writes the plaintext columns).
//
// Run with: npm run db:encrypt-sensitive

type Kind = 'number' | 'bytes' | 'json';

interface Target {
  table: string;
  column: string;
  enc: string;
  kind: Kind;
}

const TARGETS: Target[] = [
  { table: 'employees', column: 'salary', enc: 'salary_enc', kind: 'number' },
  { table: 'employee_contracts', column: 'file_data', enc: 'file_data_enc', kind: 'bytes' },
  { table: 'employee_contracts', column: 'extracted', enc: 'extracted_enc', kind: 'json' },
  { table: 'employee_salary_history', column: 'old_amount', enc: 'old_amount_enc', kind: 'number' },
  { table: 'employee_salary_history', column: 'new_amount', enc: 'new_amount_enc', kind: 'number' },
  { table: 'employee_bonuses', column: 'amount', enc: 'amount_enc', kind: 'number' },
];

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

function encryptValue(kind: Kind, value: unknown, aad: string): Buffer {
  if (kind === 'bytes') return encryptBuffer(value as Buffer, aad);
  if (kind === 'json') return encryptJson(value, aad);
  return encryptNumber(value as string, aad);
}

function decryptValue(kind: Kind, packed: Buffer, aad: string): unknown {
  if (kind === 'bytes') return decryptBuffer(packed, aad);
  if (kind === 'json') return decryptJson(packed, aad);
  return decryptNumber(packed, aad);
}

async function backfill(t: Target): Promise<void> {
  if (!(await columnExists(t.table, t.column))) {
    console.log(`[encrypt] ${t.table}.${t.column}: plaintext column already dropped — nothing to do`);
    return;
  }

  const pending = await pool.query<{ id: string; value: unknown }>(
    `SELECT id, ${t.column} AS value FROM ${t.table}
     WHERE ${t.enc} IS NULL AND ${t.column} IS NOT NULL`,
  );
  for (const row of pending.rows) {
    const packed = encryptValue(t.kind, row.value, fieldAad(t.table, t.column, row.id));
    await pool.query(`UPDATE ${t.table} SET ${t.enc} = $2 WHERE id = $1`, [row.id, packed]);
  }
  console.log(`[encrypt] ${t.table}.${t.column}: encrypted ${pending.rows.length} row(s)`);

  // Verify: nothing left unencrypted, and one sample decrypts under its AAD.
  const remaining = await pool.query(
    `SELECT count(*)::int AS n FROM ${t.table} WHERE ${t.enc} IS NULL AND ${t.column} IS NOT NULL`,
  );
  if (remaining.rows[0].n !== 0) {
    throw new Error(`${t.table}.${t.column}: ${remaining.rows[0].n} row(s) still unencrypted`);
  }
  const sample = await pool.query<{ id: string; enc: Buffer }>(
    `SELECT id, ${t.enc} AS enc FROM ${t.table} WHERE ${t.enc} IS NOT NULL LIMIT 1`,
  );
  if (sample.rows[0]) {
    decryptValue(t.kind, sample.rows[0].enc, fieldAad(t.table, t.column, sample.rows[0].id));
    console.log(`[encrypt] ${t.table}.${t.column}: sample decrypt OK`);
  }
}

async function main() {
  for (const t of TARGETS) await backfill(t);

  // Only after every backfill verified: remove the plaintext.
  for (const t of TARGETS) {
    await pool.query(`ALTER TABLE ${t.table} DROP COLUMN IF EXISTS ${t.column}`);
    console.log(`[encrypt] dropped plaintext column ${t.table}.${t.column}`);
  }

  console.log('[encrypt] done — sensitive columns are encrypted at rest.');
  await pool.end();
}

main().catch((err) => {
  console.error('[encrypt] failed:', err);
  process.exit(1);
});
