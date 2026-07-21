-- Employees section: employee records, uploaded contracts (PDF bytes +
-- Claude-extracted fields), vacation/sick leave entries, bonus log and a
-- salary-change history. No employee logins — these are rows owned by the
-- app user (the accountant/owner), like subscriptions.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + IF NOT EXISTS indexes, safe to rerun.

CREATE TABLE IF NOT EXISTS employees (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  role                  TEXT,
  salary                NUMERIC(14,2) NOT NULL DEFAULT 0,
  salary_currency       TEXT NOT NULL DEFAULT 'USD',
  contract_start        DATE,
  contract_end          DATE,
  probation_end         DATE,
  notice_period         TEXT,
  vacation_days_allowed INT NOT NULL DEFAULT 0,
  sick_days_allowed     INT NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','inactive')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employees_user_idx ON employees(user_id);

-- Uploaded contract PDFs. The bytes live here (BYTEA) so the original stays
-- downloadable without depending on a OneDrive connection. `extracted` keeps
-- the raw Claude output for audit. Latest row per employee is "the contract".
CREATE TABLE IF NOT EXISTS employee_contracts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/pdf',
  file_data    BYTEA NOT NULL,
  extracted    JSONB,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_contracts_employee_idx ON employee_contracts(employee_id);

-- Vacation and sick leave share one shape (date + days + optional note).
CREATE TABLE IF NOT EXISTS employee_leaves (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('vacation','sick')),
  on_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  days        NUMERIC(4,1) NOT NULL CHECK (days > 0),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_leaves_employee_idx ON employee_leaves(employee_id);

CREATE TABLE IF NOT EXISTS employee_bonuses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  on_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_bonuses_employee_idx ON employee_bonuses(employee_id);

-- One row per salary change. old_amount NULL marks the initial salary.
CREATE TABLE IF NOT EXISTS employee_salary_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  changed_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  old_amount  NUMERIC(14,2),
  new_amount  NUMERIC(14,2) NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_salary_history_employee_idx ON employee_salary_history(employee_id);

-- Same posture as the rest of the schema: the app connects as `postgres`
-- (bypasses RLS), so enabling RLS + revoking API-role grants keeps Supabase's
-- anon/authenticated roles out entirely.
ALTER TABLE employees               ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_contracts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_leaves         ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_bonuses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_salary_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON employees               FROM anon, authenticated;
REVOKE ALL ON employee_contracts      FROM anon, authenticated;
REVOKE ALL ON employee_leaves         FROM anon, authenticated;
REVOKE ALL ON employee_bonuses        FROM anon, authenticated;
REVOKE ALL ON employee_salary_history FROM anon, authenticated;
