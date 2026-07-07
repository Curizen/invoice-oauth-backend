import type { Request, Response, NextFunction } from 'express';
import { pool } from './db.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * DEMO ONLY: every request runs as the seeded demo user.
 * Replace with real session auth (Clerk/Auth0 middleware, or your own):
 * verify the session, then set req.userId to your internal users.id.
 */
export async function demoAuth(req: Request, _res: Response, next: NextFunction) {
  const { rows } = await pool.query(`SELECT id FROM app_users WHERE email = 'demo@example.com'`);
  req.userId = rows[0]?.id;
  next();
}
