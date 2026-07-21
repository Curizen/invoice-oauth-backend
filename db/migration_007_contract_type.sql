-- Indefinite-term contracts: contract_type distinguishes an open-ended
-- contract (no end date by design) from a fixed-term one, so a missing
-- contract_end can be rendered as "Indefinite" instead of unknown.
--
-- Idempotent: rerunning hits benign duplicate_column / duplicate_object codes
-- that migrate.ts skips.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS contract_type TEXT NOT NULL DEFAULT 'fixed';

ALTER TABLE employees ADD CONSTRAINT employees_contract_type_check
  CHECK (contract_type IN ('fixed', 'indefinite'));

-- Existing rows that have a contract start but no end were entered before the
-- flag existed. Product rule: no end date = indefinite-term.
-- (Note: migrate.ts splits statements on semicolons, comments included.)
UPDATE employees SET contract_type = 'indefinite'
 WHERE contract_end IS NULL AND contract_start IS NOT NULL AND contract_type = 'fixed';
