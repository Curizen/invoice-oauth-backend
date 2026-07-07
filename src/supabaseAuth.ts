import type { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { pool } from './db.js';

/**
 * Supabase Auth middleware.
 *
 * Your frontend signs users in with supabase-js (email magic link, password,
 * or social login) and sends the session's access token on every request:
 *
 *   fetch('/connections', {
 *     headers: { Authorization: `Bearer ${session.access_token}` }
 *   })
 *
 * For the browser-redirect OAuth routes (/connect, /callback) a header isn't
 * possible, so we also accept the token from an `sb_token` cookie that your
 * frontend sets after login:
 *
 *   document.cookie = `sb_token=${session.access_token}; path=/; SameSite=Lax`;
 *
 * This middleware verifies the token with Supabase, then maps the Supabase
 * user to a row in OUR users table (creating it on first sight) so the rest
 * of the codebase keeps working with internal user ids.
 *
 * Production note: supabase.auth.getUser() makes a network call per request.
 * Fine to start; later, verify the JWT locally (project JWT keys) and cache.
 */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
);

export async function supabaseAuth(req: Request, res: Response, next: NextFunction) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const token = bearer ?? (req.cookies?.sb_token as string | undefined);
  if (!token) return res.status(401).json({ error: 'Not signed in' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired session' });

  const su = data.user;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, auth_provider, auth_subject)
     VALUES ($1, 'supabase', $2)
     ON CONFLICT (auth_provider, auth_subject) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [su.email ?? `${su.id}@no-email.local`, su.id],
  );
  req.userId = rows[0].id;
  next();
}
