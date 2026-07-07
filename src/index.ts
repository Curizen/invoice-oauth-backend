import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { lightLimiter } from './middleware/rateLimit.js';
import { healthzHandler } from './healthz.js';
import { demoAuth } from './demoAuth.js';
import { supabaseAuth } from './supabaseAuth.js';
import { connections } from './connections.routes.js';
import { internalApi } from './internalApi.js';
import { listGmailInvoiceCandidates, listOutlookInvoiceCandidates } from './providerApis.js';
import { listConnections, pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Railway/Render sit behind a reverse proxy; needed for secure cookies and
// req.ip (which express-rate-limit relies on) to work correctly.
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // public/*.html import the Supabase JS client as an ES module from esm.sh.
        scriptSrcElem: ["'self'", 'https://esm.sh'],
        // public/*.html have inline <style> blocks in <head>.
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'https://esm.sh', config.supabase.url],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
  }),
);

app.use(pinoHttp({ logger }));
app.use(lightLimiter);

app.use(express.json());
app.use(cookieParser());

app.get('/healthz', healthzHandler);

app.get('/config', (req, res) => {
  res.json({
    supabaseUrl: config.supabase.url,
    supabaseAnonKey: config.supabase.anonKey,
  });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => res.redirect('/app.html'));

app.use(internalApi); // must come before supabaseAuth/demoAuth

app.use(config.supabase.url ? supabaseAuth : demoAuth);

app.use(connections);

// Smoke test: prove background-style API access works with stored tokens.
app.get('/test/:connectionId', async (req, res) => {
  try {
    const conns = await listConnections(req.userId!);
    const conn = conns.find((c) => c.id === req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'not found' });
    const data =
      conn.provider === 'google'
        ? await listGmailInvoiceCandidates(conn.id)
        : await listOutlookInvoiceCandidates(conn.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, `Listening on ${config.appUrl}`);
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    try {
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'pool.end failed');
    }
    process.exit(0);
  });
  // Force-exit if close hangs (e.g. long-lived connections not draining).
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
