import type { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { pool } from './db.js';
import { logger } from './logger.js';

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
 * This middleware verifies the token with Supabase, then looks up the
 * matching row in OUR app_users table so the rest of the codebase keeps
 * working with internal user ids.
 *
 * This app is single-user: app_users is seeded exactly once by
 * `npm run db:seed-user` (src/scripts/seedSingleUser.ts). This middleware
 * only ever looks up that one row by auth_subject — it does NOT provision new
 * app_users rows, so any other Supabase-authenticated identity (e.g. someone
 * who signed up directly against Supabase, bypassing this app) is rejected.
 *
 * Production note: supabase.auth.getUser() makes a network call per request.
 * Fine to start; later, verify the JWT locally (project JWT keys) and cache.
 */
// Created lazily: this module is imported unconditionally by index.ts, but the
// middleware only runs when SUPABASE_URL is configured (index.ts refuses to
// start otherwise, or explicitly uses demoAuth in dev). Constructing the
// client at import time with an empty URL would crash before that guard can
// give its clear error.
let supabaseClient: ReturnType<typeof createClient> | null = null;
function supabase() {
  supabaseClient ??= createClient(
    config.supabase.url,
    config.supabase.anonKey,
    { auth: { persistSession: false } },
  );
  return supabaseClient;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export async function supabaseAuth(req: Request, res: Response, next: NextFunction) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  // CSRF defense: the sb_token cookie exists only for the browser-redirect
  // OAuth GETs (/connect, /callback), where a header is impossible. Cookies
  // are sent automatically cross-site, so accepting one on a mutating method
  // would let any page forge state-changing requests. Mutations must carry
  // the explicit Authorization: Bearer header (the frontend already does).
  // Note: SameSite=Strict is NOT an option here — the OAuth callback arrives
  // as a cross-site top-level redirect and would lose the cookie.
  const cookieToken = SAFE_METHODS.has(req.method)
    ? (req.cookies?.sb_token as string | undefined)
    : undefined;
  const token = bearer ?? cookieToken;
  if (!token) return res.status(401).json({ error: 'Not signed in' });

  try {
    const { data, error } = await supabase().auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired session' });

    const su = data.user;

    // Single-user lockdown: look up the one seeded app_users row by the
    // Supabase-vouched stable identity (auth_subject). No upsert — anyone
    // else who authenticates against Supabase (a second account created
    // directly there, bypassing this app) simply has no matching row here
    // and is rejected below.
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM app_users WHERE auth_provider = 'supabase' AND auth_subject = $1`,
      [su.id],
    );
    if (!result.rows[0]) return res.status(401).json({ error: 'Not authorized' });

    req.userId = result.rows[0].id;
    next();
  } catch (err) {
    // Never let an auth-path failure become an unhandled rejection that takes
    // down the whole server.
    logger.error({ err }, 'supabaseAuth failed');
    return res.status(500).json({ error: 'Auth check failed' });
  }
}
