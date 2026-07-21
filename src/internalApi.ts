import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { config, normalizeIp } from './config.js';
import { pool, audit } from './db.js';
import { getAccessToken } from './tokenService.js';
import { moderateLimiter } from './middleware/rateLimit.js';
import { logger } from './logger.js';
import { buildReport, reportHtml, type PeriodType } from './reports.js';
import { sendMailViaConnection } from './mailSend.js';
import type { Provider } from './providers.js';

export const internalApi = Router();

// PRODUCTION NOTE: /internal/* is guarded by the shared secret (timing-safe
// compare below), the optional INTERNAL_ALLOWED_IPS allowlist, and audit rows
// for every token mint / rejected attempt. At the platform level, private
// networking between n8n and this app removes the public exposure entirely —
// prefer it when both run on the same platform.

/**
 * Timing-safe shared-secret comparison. Hashing both sides first means
 * timingSafeEqual always gets equal-length inputs (it throws otherwise), and
 * the comparison time leaks nothing about how much of the key matched.
 */
function safeKeyEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

// Fire-and-forget audit write: never let a logging failure break the request.
function auditSafe(connectionId: string | null, event: string, detail?: object): void {
  audit(connectionId, event, detail).catch((err) => {
    logger.error({ err, event }, 'audit write failed');
  });
}

function requireInternalKey(req: Request, res: Response, next: NextFunction) {
  const ip = normalizeIp(req.ip ?? '');
  // Rejections below are audited; the moderateLimiter mounted upstream bounds
  // their write volume, so this is not a log-flooding vector — keep the audits.
  if (config.internalAllowedIps.length > 0 && !config.internalAllowedIps.includes(ip)) {
    auditSafe(null, 'internal_auth_rejected', { ip, path: req.path, reason: 'ip_not_allowed' });
    return res.status(403).json({ error: 'forbidden' });
  }
  const key = req.headers['x-internal-key'];
  if (typeof key !== 'string' || !safeKeyEqual(key, config.internalApiKey)) {
    auditSafe(null, 'internal_auth_rejected', { ip, path: req.path, reason: 'bad_key' });
    return res.status(401).json({ error: 'invalid internal key' });
  }
  next();
}

internalApi.use('/internal', moderateLimiter);
internalApi.use('/internal', requireInternalKey);

internalApi.get('/internal/connections', async (req: Request, res: Response) => {
  const provider = req.query.provider as string | undefined;
  const { rows } = await pool.query(
    `SELECT id, user_id, provider, provider_email
     FROM connected_accounts
     WHERE status = 'active' ${provider ? 'AND provider = $1' : ''}
     ORDER BY created_at`,
    provider ? [provider] : [],
  );
  res.json(rows);
});

internalApi.post('/internal/token', async (req: Request, res: Response) => {
  const { connectionId } = req.body as { connectionId?: string };
  const ip = normalizeIp(req.ip ?? '');
  if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
  try {
    const accessToken = await getAccessToken(connectionId);
    auditSafe(connectionId, 'internal_token_issued', { ip });
    res.json({ accessToken, tokenType: 'Bearer' });
  } catch (err) {
    logger.error({ err, connectionId }, 'internal token mint failed');
    // A valid-key request that fails here (unknown id, reauth_required, …) is
    // signal too — someone probing which connections are live. The audit FK
    // rejects ids that aren't real connections, so fall back to a null row.
    audit(connectionId, 'internal_token_denied', { ip, error: String(err).slice(0, 200) }).catch(() =>
      auditSafe(null, 'internal_token_denied', { ip, connectionId, error: String(err).slice(0, 200) }),
    );
    res.status(409).json({ error: 'Could not mint an access token for this connection' });
  }
});

// Scheduled financial report send: called by the n8n cron workflow. For every
// user with an active mailbox, build their report and email it from that mailbox
// (Microsoft preferred, else Google). Failures are per-user isolated.
internalApi.post('/internal/reports/run', async (req: Request, res: Response) => {
  const period = ((req.body as { period?: string }).period ?? 'monthly') as PeriodType;
  try {
    // One connection per user — prefer Microsoft (Graph sendMail is simplest).
    const { rows } = await pool.query<{ user_id: string; id: string; provider: Provider; provider_email: string }>(
      `SELECT DISTINCT ON (ca.user_id) ca.user_id, ca.id, ca.provider, ca.provider_email
       FROM connected_accounts ca
       WHERE ca.status = 'active'
       ORDER BY ca.user_id, (ca.provider = 'microsoft') DESC, ca.created_at`,
    );
    let sent = 0;
    const failures: { userId: string; error: string }[] = [];
    for (const c of rows) {
      try {
        const data = await buildReport(c.user_id, period);
        await sendMailViaConnection(c.id, c.provider, {
          to: c.provider_email,
          subject: `Your ${data.periodType} financial report — ${data.periodLabel}`,
          html: reportHtml(data),
        });
        sent += 1;
      } catch (err) {
        // Details stay in server logs; the caller (n8n) only needs to know who failed.
        logger.error({ err, userId: c.user_id }, 'scheduled report send failed for user');
        failures.push({ userId: c.user_id, error: 'send failed' });
      }
    }
    logger.info({ period, sent, failed: failures.length }, 'scheduled reports run complete');
    res.json({ ok: true, period, users: rows.length, sent, failures });
  } catch (err) {
    logger.error({ err }, 'scheduled reports run failed');
    res.status(500).json({ error: 'Failed to run reports' });
  }
});
