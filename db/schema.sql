CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS app_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  auth_provider TEXT NOT NULL DEFAULT 'demo',
  auth_subject  TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (auth_provider, auth_subject)
);

CREATE TABLE IF NOT EXISTS connected_accounts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  provider                  TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  provider_account_id       TEXT NOT NULL,
  provider_email            TEXT NOT NULL,
  scopes                    TEXT[] NOT NULL,
  refresh_token_ciphertext  BYTEA NOT NULL,
  refresh_token_iv          BYTEA NOT NULL,
  refresh_token_tag         BYTEA NOT NULL,
  encryption_key_version    INT NOT NULL DEFAULT 1,
  status                    TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','revoked','error','reauth_required')),
  last_synced_at            TIMESTAMPTZ,
  last_error                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, provider_account_id)
);

CREATE TABLE IF NOT EXISTS connection_audit_log (
  id                    BIGSERIAL PRIMARY KEY,
  connected_account_id  UUID REFERENCES connected_accounts(id) ON DELETE SET NULL,
  event                 TEXT NOT NULL,
  detail                JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Demo user so the starter works out of the box (replace with real auth).
INSERT INTO app_users (email) VALUES ('demo@example.com')
ON CONFLICT (email) DO NOTHING;

-- ============================================================
-- SUPABASE HARDENING (required when hosting this schema on Supabase)
-- ============================================================
-- Supabase exposes tables in the `public` schema through its auto-generated
-- PostgREST API. Your Express backend connects directly to Postgres and
-- BYPASSES RLS (it connects as the `postgres` role), so enabling RLS with
-- NO policies makes these tables deny-by-default for the anon/authenticated
-- API keys while your backend keeps full access.
ALTER TABLE app_users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_accounts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_audit_log ENABLE ROW LEVEL SECURITY;

-- Belt-and-braces: strip API-role grants from the token table entirely.
REVOKE ALL ON connected_accounts FROM anon, authenticated;
REVOKE ALL ON connection_audit_log FROM anon, authenticated;
