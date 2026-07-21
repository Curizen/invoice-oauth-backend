import fs from 'node:fs';
import pg from 'pg';
import { config } from './config.js';
import { encrypt, decrypt, KEY_VERSION } from './crypto.js';
import { logger } from './logger.js';
import type { Provider } from './providers.js';

/**
 * Production TLS: verify the server certificate against Supabase's CA
 * (Dashboard → Settings → Database → SSL certificate), supplied as either
 * SUPABASE_CA_CERT (PEM, or base64 of the PEM — multiline env values are
 * fiddly in some deploy UIs) or SUPABASE_CA_CERT_FILE (path). If neither is
 * set, warn loudly and fall back to an unverified connection rather than
 * refusing to boot — but that fallback leaves queries (which carry decrypted
 * refresh tokens) open to a man-in-the-middle, so set the cert.
 */
function dbSsl(): { ca: string; rejectUnauthorized: true } | { rejectUnauthorized: false } | undefined {
  if (config.nodeEnv !== 'production') return undefined;
  let ca = process.env.SUPABASE_CA_CERT?.trim();
  if (ca && !ca.startsWith('-----BEGIN')) {
    ca = Buffer.from(ca, 'base64').toString('utf8');
  }
  if (!ca && process.env.SUPABASE_CA_CERT_FILE) {
    ca = fs.readFileSync(process.env.SUPABASE_CA_CERT_FILE, 'utf8');
  }
  if (ca) return { ca, rejectUnauthorized: true };
  logger.warn(
    'SUPABASE_CA_CERT / SUPABASE_CA_CERT_FILE not set — DB TLS certificate verification is DISABLED',
  );
  return { rejectUnauthorized: false };
}

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: dbSsl(),
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

/** The connection whose OneDrive receives ALL of this user's invoices. */
export async function getInvoiceStore(userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ invoice_store_connection_id: string | null }>(
    `SELECT invoice_store_connection_id FROM app_users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.invoice_store_connection_id ?? null;
}

/**
 * Point this user's invoice storage at one of their connections. Enforces, in
 * a single statement, that the connection exists, belongs to the user, and is
 * a Microsoft account (only Microsoft accounts have a OneDrive we can write to).
 * Returns false if that check fails so the caller can 400.
 */
export async function setInvoiceStore(userId: string, connectionId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE app_users SET invoice_store_connection_id = $2
     WHERE id = $1
       AND EXISTS (
         SELECT 1 FROM connected_accounts
         WHERE id = $2 AND user_id = $1 AND provider = 'microsoft'
       )`,
    [userId, connectionId],
  );
  return (rowCount ?? 0) > 0;
}

export async function audit(connectionId: string | null, event: string, detail?: object): Promise<void> {
  await pool.query(
    `INSERT INTO connection_audit_log (connected_account_id, event, detail) VALUES ($1,$2,$3)`,
    [connectionId, event, detail ? JSON.stringify(detail) : null],
  );
}
