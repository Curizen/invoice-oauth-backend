-- At-rest encryption of the high-sensitivity employee columns: salaries,
-- contract PDF bytes, extracted contract JSON, salary history amounts, and
-- bonus amounts. Each gets a packed BYTEA twin (iv||tag||data, AES-256-GCM —
-- see src/fieldCrypto.ts) plus a per-row key version for future rotation.
--
-- NOTE: no semicolons inside comments — migrate.ts splits statements on them.
-- The plaintext columns are only relaxed here (NOT NULL / DEFAULT dropped so
-- new code can stop writing them). They are DROPPED by
-- src/scripts/encryptSensitive.ts after the backfill verifies. Reruns after
-- that drop hit "column does not exist" (42703), which migrate.ts treats as
-- benign.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS everywhere.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary_enc BYTEA;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS encryption_key_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE employees ALTER COLUMN salary DROP NOT NULL;
ALTER TABLE employees ALTER COLUMN salary DROP DEFAULT;

ALTER TABLE employee_contracts ADD COLUMN IF NOT EXISTS file_data_enc BYTEA;
ALTER TABLE employee_contracts ADD COLUMN IF NOT EXISTS extracted_enc BYTEA;
ALTER TABLE employee_contracts ADD COLUMN IF NOT EXISTS encryption_key_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE employee_contracts ALTER COLUMN file_data DROP NOT NULL;

ALTER TABLE employee_salary_history ADD COLUMN IF NOT EXISTS old_amount_enc BYTEA;
ALTER TABLE employee_salary_history ADD COLUMN IF NOT EXISTS new_amount_enc BYTEA;
ALTER TABLE employee_salary_history ADD COLUMN IF NOT EXISTS encryption_key_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE employee_salary_history ALTER COLUMN new_amount DROP NOT NULL;

ALTER TABLE employee_bonuses ADD COLUMN IF NOT EXISTS amount_enc BYTEA;
ALTER TABLE employee_bonuses ADD COLUMN IF NOT EXISTS encryption_key_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE employee_bonuses ALTER COLUMN amount DROP NOT NULL;
