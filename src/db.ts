import pg from 'pg';
import { config } from './config.js';
import { encrypt, decrypt, KEY_VERSION } from './crypto.js';
import { logger } from './logger.js';
import type { Provider } from './providers.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // rejectUnauthorized: false skips certificate verification — acceptable
  // for Supabase's pooler today (it doesn't publish a cert Node trusts by
  // default), but this is a tradeoff, not the ideal setting. Should move to
  // sslmode=verify-full with Supabase's CA cert when that becomes practical.
  ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle Postgres client error');
});

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: Provider;
  provider_account_id: string;
  provider_email: string;
  scopes: string[];
  status: string;
}

export async function upsertConnection(opts: {
  userId: string;
  provider: Provider;
  accountId: string;
  email: string;
  scopes: string[];
  refreshToken: string;
}): Promise<ConnectionRow> {
  // Encrypt with a deterministic AAD derived from the natural key so the
  // ciphertext is bound to this (user, provider, account) identity.
  const aad = `${opts.userId}:${opts.provider}:${opts.accountId}`;
  const ct = encrypt(opts.refreshToken, aad);

  const { rows } = await pool.query<ConnectionRow>(
    `INSERT INTO connected_accounts
       (user_id, provider, provider_account_id, provider_email, scopes,
        refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
        encryption_key_version, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')
     ON CONFLICT (user_id, provider, provider_account_id) DO UPDATE SET
       provider_email = EXCLUDED.provider_email,
       scopes = EXCLUDED.scopes,
       refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
       refresh_token_iv = EXCLUDED.refresh_token_iv,
       refresh_token_tag = EXCLUDED.refresh_token_tag,
       encryption_key_version = EXCLUDED.encryption_key_version,
       status = 'active', last_error = NULL, updated_at = now()
     RETURNING id, user_id, provider, provider_account_id, provider_email, scopes, status`,
    [
      opts.userId, opts.provider, opts.accountId, opts.email, opts.scopes,
      ct.data, ct.iv, ct.tag, KEY_VERSION,
    ],
  );
  return rows[0];
}

export async function getConnection(id: string): Promise<(ConnectionRow & { refreshToken: string }) | null> {
  const { rows } = await pool.query(
    `SELECT id, user_id, provider, provider_account_id, provider_email, scopes, status,
            refresh_token_ciphertext, refresh_token_iv, refresh_token_tag
     FROM connected_accounts WHERE id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  const aad = `${r.user_id}:${r.provider}:${r.provider_account_id}`;
  const refreshToken = decrypt(
    { data: r.refresh_token_ciphertext, iv: r.refresh_token_iv, tag: r.refresh_token_tag },
    aad,
  );
  return { ...r, refreshToken };
}

export async function rotateRefreshToken(id: string, newToken: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT user_id, provider, provider_account_id FROM connected_accounts WHERE id = $1`,
    [id],
  );
  if (!rows[0]) return;
  const aad = `${rows[0].user_id}:${rows[0].provider}:${rows[0].provider_account_id}`;
  const ct = encrypt(newToken, aad);
  await pool.query(
    `UPDATE connected_accounts
     SET refresh_token_ciphertext=$2, refresh_token_iv=$3, refresh_token_tag=$4,
         encryption_key_version=$5, updated_at=now()
     WHERE id=$1`,
    [id, ct.data, ct.iv, ct.tag, KEY_VERSION],
  );
}

export async function setConnectionStatus(id: string, status: string, error?: string): Promise<void> {
  await pool.query(
    `UPDATE connected_accounts SET status=$2, last_error=$3, updated_at=now() WHERE id=$1`,
    [id, status, error ?? null],
  );
}

export async function listConnections(userId: string): Promise<ConnectionRow[]> {
  const { rows } = await pool.query<ConnectionRow>(
    `SELECT id, user_id, provider, provider_account_id, provider_email, scopes, status
     FROM connected_accounts WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows;
}

export async function deleteConnection(id: string, userId: string): Promise<void> {
  await pool.query(`DELETE FROM connected_accounts WHERE id=$1 AND user_id=$2`, [id, userId]);
}

export async function audit(connectionId: string | null, event: string, detail?: object): Promise<void> {
  await pool.query(
    `INSERT INTO connection_audit_log (connected_account_id, event, detail) VALUES ($1,$2,$3)`,
    [connectionId, event, detail ? JSON.stringify(detail) : null],
  );
}
