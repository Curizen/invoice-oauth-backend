-- Subscriptions tracker: recurring subscriptions the user wants to keep an eye
-- on (name, value, start date, status). Separate from invoices — this is a
-- lightweight running list, not extracted documents.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + IF NOT EXISTS index, safe to rerun.
CREATE TABLE IF NOT EXISTS subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'USD',
  started_on   DATE NOT NULL DEFAULT CURRENT_DATE,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id);
