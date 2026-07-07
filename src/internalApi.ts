import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { getAccessToken } from './tokenService.js';
import { moderateLimiter } from './middleware/rateLimit.js';

export const internalApi = Router();

// PRODUCTION NOTE: this shared-secret check is the only guard on /internal/*.
// At the platform level (Railway/Render), also consider: (1) IP-allowlisting
// this path to n8n's egress IP(s), and/or (2) fronting it with a second
// platform-level shared secret / private networking, since a leaked
// INTERNAL_API_KEY alone currently grants full read + token-mint access.
function requireInternalKey(req: Request, res: Response, next: NextFunction) {
  if (req.headers['x-internal-key'] !== config.internalApiKey) {
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
  if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
  try {
    const accessToken = await getAccessToken(connectionId);
    res.json({ accessToken, tokenType: 'Bearer' });
  } catch (err) {
    res.status(409).json({ error: String(err) });
  }
});
