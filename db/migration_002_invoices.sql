-- Reconcile existing accounting schema with multi-tenant OAuth connections.
-- Additive only: no table recreation, no constraints that fight the
-- existing duplicate/anomaly design.

-- Multi-tenancy + email provenance on invoices
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES app_users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS connected_account_id uuid REFERENCES connected_accounts(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_subject text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_from text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_message_id text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS attachment_name text;

-- Don't reprocess the same email attachment for the same connection.
-- Partial index so legacy rows (nulls) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_message_dedupe
  ON invoices (connected_account_id, email_message_id, attachment_name)
  WHERE email_message_id IS NOT NULL;

-- Multi-tenancy on audit_log
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES app_users(id);

-- Per-connection sync cursor for the (currently disabled) code pipeline
CREATE TABLE IF NOT EXISTS invoice_sync_state (
  connected_account_id  uuid PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,
  last_received_at      timestamptz NOT NULL DEFAULT now() - INTERVAL '1 day',
  last_run_at           timestamptz,
  last_error            text
);
ALTER TABLE invoice_sync_state ENABLE ROW LEVEL SECURITY;
