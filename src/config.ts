import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function requiredIf(cond: boolean, name: string): string | undefined {
  const v = process.env[name];
  if (cond && !v) {
    throw new Error(`Missing required env var: ${name} (required when ENABLE_SYNC=true)`);
  }
  return v;
}

const enableSync = process.env.ENABLE_SYNC === 'true';

/**
 * Behind a reverse proxy, req.ip is often IPv6-mapped ("::ffff:203.0.113.1"),
 * which would fail a naive string match against "203.0.113.1" and silently
 * reject legitimate traffic. Normalize both the configured list and incoming
 * values through this before comparing.
 */
export function normalizeIp(ip: string): string {
  return ip.trim().replace(/^::ffff:/i, '');
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',
  databaseUrl: required('DATABASE_URL'),
  masterKeyHex: required('MASTER_KEY_HEX'),
  internalApiKey: required('INTERNAL_API_KEY'),
  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
  },
  microsoft: {
    clientId: required('MS_CLIENT_ID'),
    clientSecret: required('MS_CLIENT_SECRET'),
  },
  supabase: {
    url: process.env.SUPABASE_URL ?? '',
    anonKey: process.env.SUPABASE_ANON_KEY ?? '',
  },
  // Explicit opt-in for the auth-less demoAuth fallback. Without this flag the
  // server refuses to start when SUPABASE_URL is unset (see index.ts) — an
  // accidentally missing env var must never silently authenticate everyone.
  allowDemoAuth: process.env.ALLOW_DEMO_AUTH === 'true',
  // Optional /internal/* source-IP allowlist (comma-separated). Empty = no IP
  // restriction (n8n cloud egress IPs aren't guaranteed static, so this must
  // stay opt-in).
  internalAllowedIps: (process.env.INTERNAL_ALLOWED_IPS ?? '')
    .split(',')
    .map((s) => normalizeIp(s))
    .filter((s) => s.length > 0),
  // Forward-looking: no in-process pipeline consumes these yet (n8n is the
  // active pipeline). Validated now so config.ts is ready when it lands.
  enableSync,
  openaiApiKey: requiredIf(enableSync, 'OPENAI_API_KEY'),
  baseCurrency: process.env.BASE_CURRENCY ?? 'USD',
  // n8n "Multi-Currency Normalization" endpoint. Optional: when set, non-base
  // currency invoices are converted via Frankfurter historical rates through
  // this workflow; otherwise the inline converter is used.
  n8nNormalizeCurrencyWebhookUrl: process.env.N8N_NORMALIZE_WEBHOOK_URL,
  // n8n "Contract Extractor via Webhook" endpoint. Optional: contract uploads
  // are stored either way; AI field extraction only runs when this is set.
  n8nContractWebhookUrl: process.env.N8N_CONTRACT_WEBHOOK_URL,
  // n8n "Smart Duplicate Detection" endpoint. Optional: falls back to the
  // inline exact vendor+invoice_number match when unset or unreachable.
  n8nDuplicateCheckWebhookUrl: process.env.N8N_DUPLICATE_CHECK_WEBHOOK_URL,
  // n8n "Vendor Intelligence" endpoint. Optional: falls back to the inline
  // typical_amount deviation-% check when unset or unreachable.
  n8nVendorIntelWebhookUrl: process.env.N8N_VENDOR_INTEL_WEBHOOK_URL,
};

// Production-only invariants. crypto.ts already throws on a wrong-length
// MASTER_KEY_HEX in every environment; this is a clearer, earlier error
// specific to production and does not replace that check.
if (config.nodeEnv === 'production') {
  if (!config.appUrl.startsWith('https://')) {
    throw new Error(`In production, APP_URL must be https (got: ${config.appUrl})`);
  }
  if (!/^[0-9a-f]{64}$/i.test(config.masterKeyHex)) {
    throw new Error('In production, MASTER_KEY_HEX must be present and exactly 64 hex chars (32 bytes)');
  }
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw new Error('In production, SUPABASE_URL and SUPABASE_ANON_KEY are required (demoAuth is dev-only)');
  }
  if (config.allowDemoAuth) {
    throw new Error('In production, ALLOW_DEMO_AUTH must not be set — demoAuth authenticates every request');
  }
}
