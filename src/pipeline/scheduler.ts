import { pool } from '../db.js';
import { syncConnection } from './invoicePipeline.js';

/**
 * Replaces the n8n "every minute" poll trigger. Iterates every ACTIVE
 * Microsoft connection and processes new mail, isolating failures per
 * connection so one user's bad mailbox never blocks the others.
 *
 * Upgrade path for scale: swap this loop for BullMQ (one job per
 * connection, Redis-backed, concurrency limits, retries with backoff) and
 * later replace polling entirely with Graph change-notification webhooks.
 */
let running = false;

export function startScheduler(): void {
  const interval = Number(process.env.SYNC_INTERVAL_SECONDS ?? 60) * 1000;
  console.log(`Invoice sync scheduler: every ${interval / 1000}s`);

  setInterval(async () => {
    if (running) return; // don't overlap runs
    running = true;
    try {
      const { rows } = await pool.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM connected_accounts
         WHERE status = 'active' AND provider = 'microsoft'`,
      );
      for (const conn of rows) {
        try {
          await syncConnection(conn.id, conn.user_id);
        } catch (err) {
          console.error(`sync failed for connection ${conn.id}:`, String(err).slice(0, 300));
        }
      }
    } catch (err) {
      console.error('scheduler tick failed:', err);
    } finally {
      running = false;
    }
  }, interval);
}
