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
import { voiceRoutes } from './voice.routes.js';
import { uploadRoutes } from './uploads.routes.js';
import { subscriptionRoutes } from './subscriptions.routes.js';
import { reportRoutes } from './reports.routes.js';
import { employeeRoutes } from './employees.routes.js';
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
        // No 'unsafe-inline': all page scripts live in public/js/*.js, so a
        // stored-XSS payload that lands in the DOM cannot execute. esm.sh
        // stays for the supabase-js module import.
        scriptSrc: ["'self'", 'https://esm.sh'],
        scriptSrcElem: ["'self'", 'https://esm.sh'],
        // Inline style attributes are pervasive in the pages; with script
        // injection blocked they are a low-risk allowance.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        connectSrc: ["'self'", 'https://esm.sh', config.supabase.url],
        imgSrc: ["'self'", 'data:'],
        // Recorded voice notes are played back from an in-memory blob: URL
        // (see views/voice.ejs) — without this the browser silently
        // blocks playback under default-src 'self'.
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
  }),
);

app.use(pinoHttp({ logger }));
app.use(lightLimiter);

// Only the base64-upload routes need a big body (PDF/image up to ~20 MB →
// ~27 MB base64); everything else gets a tight default so a stray client
// can't post megabytes at ordinary endpoints. body-parser skips bodies a
// previous instance already parsed, so the global one is a no-op on these.
app.use(
  ['/upload-invoice', '/voice-invoice', '/employees/from-contract', '/employees/:id/contract'],
  express.json({ limit: '30mb' }),
);
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

app.get('/healthz', healthzHandler);

app.get('/config', (req, res) => {
  res.json({
    supabaseUrl: config.supabase.url,
    supabaseAnonKey: config.supabase.anonKey,
  });
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));

const PAGES: Record<string, string> = {
  '/app': 'app',
  '/login': 'login',
  '/employee': 'employee',
  '/employees': 'employees',
  '/reports': 'reports',
  '/subscriptions': 'subscriptions',
  '/voice': 'voice',
};
for (const [route, view] of Object.entries(PAGES)) {
  app.get(route, (req, res) => res.render(view));
}

// Old bookmarks/links pointed at the static .html paths — redirect them to
// the clean routes above instead of 404ing.
for (const route of Object.keys(PAGES)) {
  app.get(`${route}.html`, (req, res) => res.redirect(301, route + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));
}

app.get('/', (req, res) => res.redirect('/app'));

app.use(internalApi); // must come before supabaseAuth/demoAuth

// Auth selection is a hard gate: demoAuth authenticates EVERY request as the
// demo user, so it only ever runs in development with an explicit opt-in.
// A missing SUPABASE_URL in any other situation is a fatal misconfiguration,
// not a fallback.
if (config.supabase.url) {
  app.use(supabaseAuth);
} else if (config.nodeEnv === 'development' && config.allowDemoAuth) {
  logger.warn('demoAuth ACTIVE (ALLOW_DEMO_AUTH=true): every request is authenticated as the demo user');
  app.use(demoAuth);
} else {
  throw new Error(
    'SUPABASE_URL is not set. Refusing to start with auth-less demoAuth — set SUPABASE_URL, ' +
      'or (development only) set ALLOW_DEMO_AUTH=true to opt in explicitly.',
  );
}

app.use(connections);
app.use(voiceRoutes);
app.use(uploadRoutes);
app.use(subscriptionRoutes);
app.use(reportRoutes);
app.use(employeeRoutes);

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
    logger.error({ err, connectionId: req.params.connectionId }, 'smoke test failed');
    res.status(500).json({ error: 'Test failed — see server logs' });
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
import { startScheduler } from './pipeline/scheduler.js';
if (process.env.ENABLE_SYNC === 'true') {
       startScheduler();
     }