import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { pool } from '../db.js';

// One-off admin script: this app is single-user. Run this ONCE (safe to
// rerun) to create/confirm the one login and hand it every pre-existing
// invoice/employee/subscription/audit_log row, regardless of who originally
// owned it. connected_accounts is deliberately left untouched — the seed
// user connects their own mailboxes fresh via the existing /connect flow.
//
// Requires SUPABASE_SERVICE_ROLE_KEY (Project Settings -> API -> service_role
// secret) — used ONLY here, never at app runtime, never sent to the browser.
//
// Run with: npm run db:seed-user

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const REASSIGN_TABLES = ['invoices', 'audit_log', 'employees', 'subscriptions'];

async function findExistingUserByEmail(
  admin: ReturnType<typeof createClient>['auth']['admin'],
  email: string,
): Promise<{ id: string } | null> {
  // No direct "get by email" in the Admin API — page through listUsers.
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return { id: match.id };
    if (data.users.length < 200) return null;
  }
}

async function main() {
  const supabaseUrl = required('SUPABASE_URL');
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const email = required('SEED_USER_EMAIL');
  const password = required('SEED_USER_PASSWORD');

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Create (or reuse + sync password on) the one Supabase Auth user.
  let supabaseUserId: string;
  const created = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) {
    const alreadyExists =
      created.error.code === 'email_exists' ||
      created.error.status === 422 ||
      /already (been )?registered|already exists/i.test(created.error.message);
    if (!alreadyExists) throw created.error;
    const existing = await findExistingUserByEmail(supabase.auth.admin, email);
    if (!existing) throw new Error(`${email} reported as already registered, but could not be found`);
    supabaseUserId = existing.id;
    const updated = await supabase.auth.admin.updateUserById(supabaseUserId, { password, email_confirm: true });
    if (updated.error) throw updated.error;
    console.log(`[seed-user] existing Supabase auth user found, password synced: ${supabaseUserId}`);
  } else {
    supabaseUserId = created.data.user.id;
    console.log(`[seed-user] created Supabase auth user: ${supabaseUserId}`);
  }

  // 2. Upsert the matching app_users row — same shape supabaseAuth.ts writes.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, auth_provider, auth_subject)
     VALUES ($1, 'supabase', $2)
     ON CONFLICT (auth_provider, auth_subject) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email, supabaseUserId],
  );
  const seedUserId = rows[0].id;
  console.log(`[seed-user] app_users.id = ${seedUserId}`);

  // 3. Reassign ownership of all pre-existing business data to this one user.
  //    connected_accounts is intentionally excluded (left for fresh /connect).
  for (const table of REASSIGN_TABLES) {
    const res = await pool.query(
      `UPDATE ${table} SET user_id = $1 WHERE user_id IS DISTINCT FROM $1`,
      [seedUserId],
    );
    console.log(`[seed-user] ${table}: reassigned ${res.rowCount} row(s) to the seed user`);
  }

  console.log('[seed-user] done. Old app_users rows (if any) were left in place, unreferenced.');
  await pool.end();
}

main().catch((err) => {
  console.error('[seed-user] failed:', err);
  process.exit(1);
});
