import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(__dirname, '..', '..', 'db');

// Postgres error codes safe to skip on rerun: duplicate_object,
// duplicate_table, duplicate_column, undefined_object (e.g. REVOKE ...
// FROM anon, authenticated failing on a local DB that has no such roles),
// undefined_column (migration_008 relaxes plaintext columns that
// encryptSensitive.ts later drops — reruns after the drop are fine).
const BENIGN_CODES = new Set(['42710', '42P07', '42701', '42704', '42703']);

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)+$/.test(s));
}

async function applyFile(filename: string): Promise<void> {
  const sql = fs.readFileSync(path.join(dbDir, filename), 'utf8');
  const statements = splitStatements(sql);
  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && BENIGN_CODES.has(code)) {
        console.warn(`[migrate] ${filename}: skipping benign error (${code}): ${(err as Error).message}`);
        continue;
      }
      throw err;
    }
  }
  console.log(`[migrate] applied: ${filename}`);
}

async function main() {
  await applyFile('schema.sql');
  await applyFile('migration_002_invoices.sql');
  await applyFile('migration_003_fk_ondelete.sql');
  await applyFile('migration_004_invoice_store.sql');
  await applyFile('migration_005_subscriptions.sql');
  await applyFile('migration_006_employees.sql');
  await applyFile('migration_007_contract_type.sql');
  await applyFile('migration_008_encrypt_sensitive.sql');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
