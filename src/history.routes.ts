import { Router, type Request, type Response } from 'express';
import { pool } from './db.js';
import { logger } from './logger.js';

// Invoice history: every invoice this user has ever logged, regardless of
// how it arrived (email sync, the voice assistant, the upload/camera button,
// or an n8n backfill import), newest-first by when it was actually saved
// (not the date printed on the document — a backdated invoice should still
// show up at the top).

export const historyRoutes = Router();

const SOURCES = new Set(['email', 'voice', 'upload', 'backfill']);
const PAGE_SIZE = 50;

historyRoutes.get('/invoices/history', async (req: Request, res: Response) => {
  try {
    const source = typeof req.query.source === 'string' && SOURCES.has(req.query.source)
      ? req.query.source
      : null;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const where: string[] = ['user_id = $1'];
    const params: unknown[] = [req.userId!];
    if (source) { params.push(source); where.push(`source = $${params.length}`); }
    if (search) { params.push(`%${search}%`); where.push(`vendor ILIKE $${params.length}`); }
    const whereSql = where.join(' AND ');

    params.push(PAGE_SIZE, offset);
    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id, vendor, invoice_number, normalized_amount, base_currency,
                invoice_date, category, source, onedrive_url, anomaly_level, created_at
         FROM invoices
         WHERE ${whereSql}
         ORDER BY created_at DESC NULLS LAST
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      ),
      pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM invoices WHERE ${whereSql}`, params.slice(0, -2)),
    ]);

    res.json({
      rows: rowsRes.rows,
      total: Number(countRes.rows[0]?.count ?? 0),
      offset,
      pageSize: PAGE_SIZE,
    });
  } catch (err) {
    logger.error({ err }, 'invoice history failed');
    res.status(500).json({ error: 'Failed to load invoice history' });
  }
});
