import { pool } from '../db.js';
const { rows } = await pool.query(
  `SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name = 'app_users'
   ORDER BY ordinal_position`,
);
console.log('app_users columns:');
for (const r of rows) console.log(' -', r.column_name, `(${r.data_type})`);
const has = rows.some((r) => r.column_name === 'invoice_store_connection_id');
console.log(has ? '\n=> invoice_store_connection_id EXISTS' : '\n=> MISSING — migration 004 not applied');
await pool.end();
