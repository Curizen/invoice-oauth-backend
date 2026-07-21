-- Central invoice storage target. Every invoice this app extracts — no matter
-- which mailbox (Gmail or Outlook) it arrived in — is filed into a single
-- OneDrive that the user picks in the UI. OneDrive uploads require a Microsoft
-- token, so this must point at one of the user's *microsoft* connections.
--
-- ON DELETE SET NULL: if that Microsoft account is disconnected, the pointer
-- clears (the user must pick another) rather than blocking the delete.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, safe to rerun.
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS invoice_store_connection_id UUID
  REFERENCES connected_accounts(id) ON DELETE SET NULL;
