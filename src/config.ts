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
    url: required('SUPABASE_URL'),
    anonKey: required('SUPABASE_ANON_KEY'),
  },
  // Forward-looking: no in-process pipeline consumes these yet (n8n is the
  // active pipeline). Validated now so config.ts is ready when it lands.
  enableSync,
  openaiApiKey: requiredIf(enableSync, 'OPENAI_API_KEY'),
  baseCurrency: process.env.BASE_CURRENCY ?? 'USD',
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
}
