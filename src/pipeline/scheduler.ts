import { pool } from '../db.js';
import { logger } from '../logger.js';
import type { Provider } from '../providers.js';
import { syncConnection, type SyncCounts } from './invoicePipeline.js';

/**
 * Replaces the n8n "every minute" poll trigger. Iterates every ACTIVE
 * Microsoft connection and processes new mail, isolating failures per
 * connection so one user's bad mailbox never blocks the others.
 *
 * Scale knobs (no external infra):
 *   SYNC_INTERVAL_SECONDS  poll cadence (default 60)
 *   SYNC_CONCURRENCY       how many connections to process in parallel (default 3)
 *
 * Upgrade path for true horizontal scale: swap this loop for BullMQ (one job
 * per connection, Redis-backed, concurrency limits, retries with backoff) and
 * later replace polling entirely with Graph change-notification webhooks. The
 * per-connection unit of work (syncConnection) is already isolated so it can
 * be lifted into a queue worker unchanged.
 */
const log = logger.child({ component: 'scheduler' });
let running = false;

/**
 * App-wide advisory-lock key for "the invoice sync scheduler". Any value works
 * as long as nothing else in the codebase reuses it.
 *
 * Scope: this lock only protects against multiple IN-PROCESS schedulers — a
 * second app instance, or a stray ENABLE_SYNC=true — turning them into loud
 * no-ops instead of silent double-processing. It does NOT protect against the
 * external n8n polling workflow, which never takes the lock; running both
 * still double-processes every mailbox. (Having n8n consult a
 * /internal/sync-lock endpoint would close that, but changes the frozen n8n
 * contract.)
 *
 * Advisory locks are session-scoped, so acquire and release must happen on the
 * SAME client — hence the dedicated pool.connect() per tick. This works
 * because DATABASE_URL uses Supabase's SESSION pooler (see .env.example); the
 * transaction pooler does not support advisory locks.
 */
const SYNC_LOCK_KEY = 727_431_001;

/** Run an async worker over items with a bounded number in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export function startScheduler(): void {
  const interval = Number(process.env.SYNC_INTERVAL_SECONDS ?? 60) * 1000;
  const concurrency = Math.max(1, Number(process.env.SYNC_CONCURRENCY ?? 3));
  log.info({ intervalSeconds: interval / 1000, concurrency }, 'invoice sync scheduler started');

  setInterval(async () => {
    if (running) {
      log.debug('previous tick still running; skipping this one');
      return;
    }
    running = true;
    const startedAt = Date.now();
    const totals: SyncCounts & { failed: number } = { saved: 0, duplicates: 0, skipped: 0, failed: 0 };

    // Cross-instance exclusivity (see SYNC_LOCK_KEY doc above). Per-tick
    // acquire/release self-heals across dropped connections and needs no
    // shutdown wiring.
    const lockClient = await pool.connect().catch((err) => {
      log.error({ err }, 'could not get a client for the sync lock; skipping tick');
      return null;
    });
    if (!lockClient) {
      running = false;
      return;
    }

    let locked = false;
    try {
      const lock = await lockClient.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [SYNC_LOCK_KEY],
      );
      locked = lock.rows[0].locked;
      if (!locked) {
        log.warn('another instance holds the sync lock; skipping tick');
        return;
      }
      // All active mailboxes, Gmail and Outlook. Each row carries the user's
      // chosen invoice storage connection (their OneDrive target); joined here
      // so the pipeline knows where to file, no matter the source provider.
      const { rows } = await pool.query<{
        id: string;
        user_id: string;
        provider: Provider;
        store_connection_id: string | null;
      }>(
        `SELECT ca.id, ca.user_id, ca.provider,
                u.invoice_store_connection_id AS store_connection_id
         FROM connected_accounts ca
         JOIN app_users u ON u.id = ca.user_id
         WHERE ca.status = 'active' AND ca.provider IN ('microsoft', 'google')`,
      );

      if (rows.length === 0) {
        log.debug('tick: no active mailbox connections');
        return;
      }
      log.info({ connections: rows.length }, 'tick: processing active mailbox connections');

      await mapWithConcurrency(rows, concurrency, async (conn) => {
        try {
          const c = await syncConnection(
            conn.id, conn.user_id, conn.provider, conn.store_connection_id,
          );
          totals.saved += c.saved;
          totals.duplicates += c.duplicates;
          totals.skipped += c.skipped;
        } catch (err) {
          totals.failed += 1;
          log.error({ connectionId: conn.id, err }, 'connection sync failed');
        }
      });

      log.info({ ...totals, ms: Date.now() - startedAt }, 'tick complete');
    } catch (err) {
      log.error({ err }, 'scheduler tick failed');
    } finally {
      if (locked) {
        await lockClient
          .query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK_KEY])
          .catch((err) => log.error({ err }, 'sync lock release failed'));
      }
      lockClient.release();
      running = false;
    }
  }, interval);
}
