import { Router, type Request, type Response } from 'express';
import { pool } from './db.js';
import { logger } from './logger.js';

// Lightweight subscriptions tracker (name, value, start date, status).

export const subscriptionRoutes = Router();

subscriptionRoutes.get('/subscriptions', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, amount, currency, started_on, status, created_at
       FROM subscriptions WHERE user_id = $1
       ORDER BY status = 'active' DESC, started_on DESC`,
      [req.userId!],
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'list subscriptions failed');
    res.status(500).json({ error: 'Failed to load subscriptions' });
  }
});

subscriptionRoutes.post('/subscriptions', async (req: Request, res: Response) => {
  const b = req.body as { name?: string; amount?: number | string; currency?: string; started_on?: string };
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  const amount = Number(b.amount ?? 0);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO subscriptions (user_id, name, amount, currency, started_on)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE))
       RETURNING id, name, amount, currency, started_on, status, created_at`,
      [req.userId!, b.name.trim(), amount, (b.currency || 'USD').toUpperCase(), b.started_on || null],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'create subscription failed');
    res.status(500).json({ error: 'Failed to add subscription' });
  }
});

// Toggle active/cancelled.
subscriptionRoutes.patch('/subscriptions/:id', async (req: Request, res: Response) => {
  const status = (req.body as { status?: string }).status;
  if (status !== 'active' && status !== 'cancelled') {
    return res.status(400).json({ error: 'status must be active or cancelled' });
  }
  try {
    const { rowCount } = await pool.query(
      `UPDATE subscriptions SET status = $3 WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId!, status],
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'update subscription failed');
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

subscriptionRoutes.delete('/subscriptions/:id', async (req: Request, res: Response) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM subscriptions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId!],
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    logger.error({ err }, 'delete subscription failed');
    res.status(500).json({ error: 'Failed to delete subscription' });
  }
});
