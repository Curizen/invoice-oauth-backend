-- Disconnecting a mailbox must not be blocked by (or destroy) the invoices
-- already extracted from it. Re-point the FK to ON DELETE SET NULL so deleting
-- a connected_account keeps the invoice rows (they still belong to the user via
-- user_id) but clears their connected_account_id.
--
-- Idempotent: DROP IF EXISTS then re-ADD, so reruns are safe.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_connected_account_id_fkey;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_connected_account_id_fkey
  FOREIGN KEY (connected_account_id) REFERENCES connected_accounts(id) ON DELETE SET NULL;
