import type { Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';

const jsonHandler = (_req: Request, res: Response) => {
  res.status(429).json({ error: 'Too many requests' });
};

const base = {
  windowMs: 60_000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler,
};

// /connect/:provider and /callback/:provider — OAuth entry points.
export const strictLimiter = rateLimit({ ...base, max: 20 });

// /internal/* — consumed by n8n, moderate ceiling for background workers.
export const moderateLimiter = rateLimit({ ...base, max: 120 });

// Global backstop applied to every request.
export const lightLimiter = rateLimit({ ...base, max: 300 });
