import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const version = process.env.APP_VERSION ?? readVersion();

export async function healthzHandler(req: Request, res: Response): Promise<void> {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, uptime: process.uptime(), version });
  } catch {
    res.status(503).json({ ok: false, uptime: process.uptime(), version, error: 'db_unreachable' });
  }
}
