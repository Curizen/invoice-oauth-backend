import { Router, type Request, type Response } from 'express';
import { getConnection, pool } from './db.js';
import { logger } from './logger.js';
import { buildReport, reportHtml, type PeriodType, type RangeOpts } from './reports.js';
import { sendMailViaConnection } from './mailSend.js';

export const reportRoutes = Router();

function parsePeriod(v: unknown): PeriodType {
  return v === 'quarterly' || v === 'yearly' || v === 'all' ? v : 'monthly';
}

function parseRangeOpts(query: { quarter?: unknown; year?: unknown }): RangeOpts {
  const quarter = Number(query.quarter);
  const year = Number(query.year);
  return {
    quarter: Number.isInteger(quarter) && quarter >= 1 && quarter <= 4 ? quarter : undefined,
    year: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : undefined,
  };
}

// Report data for the UI.
reportRoutes.get('/reports', async (req: Request, res: Response) => {
  try {
    const data = await buildReport(req.userId!, parsePeriod(req.query.period), parseRangeOpts(req.query));
    res.json(data);
  } catch (err) {
    logger.error({ err }, 'build report failed');
    res.status(500).json({ error: 'Failed to build report' });
  }
});

// Recent flagged anomalies for the dashboard panel.
reportRoutes.get('/anomalies', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.vendor, a.new_amount, a.typical_amount, a.deviation_pct,
              a.anomaly_level, a.insight, a.checked_at,
              i.invoice_date, i.base_currency, i.onedrive_url
       FROM anomaly_log a
       JOIN invoices i ON i.id = a.invoice_id
       WHERE i.user_id = $1
       ORDER BY a.checked_at DESC NULLS LAST
       LIMIT 20`,
      [req.userId!],
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'list anomalies failed');
    res.status(500).json({ error: 'Failed to load anomalies' });
  }
});

// Email the report from one of the user's connected mailboxes (to itself).
reportRoutes.post('/reports/send', async (req: Request, res: Response) => {
  const body = req.body as { period?: string; connectionId?: string; quarter?: number; year?: number };
  if (!body.connectionId) return res.status(400).json({ error: 'connectionId required' });
  try {
    const conn = await getConnection(body.connectionId);
    if (!conn || conn.user_id !== req.userId) return res.status(404).json({ error: 'connection not found' });

    const period = parsePeriod(body.period);
    const data = await buildReport(req.userId!, period, parseRangeOpts(body));
    const subject = `Your ${data.periodType} financial report — ${data.periodLabel}`;
    try {
      await sendMailViaConnection(conn.id, conn.provider, {
        to: conn.provider_email, subject, html: reportHtml(data),
      });
    } catch (err) {
      const msg = String(err);
      // Missing send scope on a pre-existing connection.
      if (/\b403\b|insufficient|scope|ErrorAccessDenied/i.test(msg)) {
        return res.status(403).json({
          error: 'This account has not granted send permission. Disconnect and reconnect it to enable sending.',
        });
      }
      throw err;
    }
    res.json({ ok: true, sentTo: conn.provider_email, period: data.periodType, label: data.periodLabel });
  } catch (err) {
    logger.error({ err }, 'send report failed');
    res.status(500).json({ error: 'Failed to send report' });
  }
});
