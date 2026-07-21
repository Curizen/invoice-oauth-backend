import { pool } from '../db.js';
import { logger } from '../logger.js';
import { normalizeForSave } from './currency.js';

// Save an invoice that arrived WITHOUT a file — e.g. dictated through the voice
// assistant. Mirrors the email pipeline's DB writes (vendor upsert → invoices
// insert → audit_log) but with source='voice' and no attachment / OneDrive.

const BASE_CURRENCY = process.env.BASE_CURRENCY ?? 'USD';
const log = logger.child({ component: 'voice-invoice' });

export interface VoiceInvoiceFields {
  vendor: string;
  amount: number;
  currency?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  due_date?: string | null;
  category?: string | null;
  description?: string | null;
  tax_amount?: number | null;
}

export interface SavedVoiceInvoice {
  invoiceId: string;
  vendor: string;
  amount: number;
  currency: string;
  normalized: number;
  invoiceDate: string;
}

export async function saveVoiceInvoice(
  userId: string,
  actorName: string,
  f: VoiceInvoiceFields,
): Promise<SavedVoiceInvoice> {
  const currency = f.currency || BASE_CURRENCY;
  const invoiceDate = f.invoice_date || new Date().toISOString().slice(0, 10);
  const { normalized, rate, exchangeDate } = await normalizeForSave(f.amount, currency, invoiceDate);

  const vendorRes = await pool.query<{ id: string }>(
    `INSERT INTO vendors
       (name, invoice_count, total_spent, min_amount, max_amount, last_invoice_date)
     VALUES ($1, 1, $2, $2, $2, $3)
     ON CONFLICT (name) DO UPDATE SET
       invoice_count     = COALESCE(vendors.invoice_count, 0) + 1,
       total_spent       = COALESCE(vendors.total_spent, 0) + EXCLUDED.total_spent,
       min_amount        = LEAST(vendors.min_amount, EXCLUDED.min_amount),
       max_amount        = GREATEST(vendors.max_amount, EXCLUDED.max_amount),
       last_invoice_date = GREATEST(vendors.last_invoice_date, EXCLUDED.last_invoice_date)
     RETURNING id`,
    [f.vendor, normalized, invoiceDate],
  );
  const vendorId = vendorRes.rows[0].id;

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO invoices
      (user_id, vendor, vendor_id, invoice_number,
       original_amount, original_currency, normalized_amount, base_currency,
       exchange_rate, exchange_date,
       invoice_date, due_date, category, description, tax_amount, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'voice')
     RETURNING id`,
    [
      userId, f.vendor, vendorId, f.invoice_number ?? null,
      f.amount, currency, normalized, BASE_CURRENCY,
      rate, exchangeDate,
      invoiceDate, f.due_date ?? null, f.category ?? null, f.description ?? null, f.tax_amount ?? null,
    ],
  );
  const invoiceId = inserted.rows[0].id;

  await pool.query(
    `INSERT INTO audit_log (user_id, action, actor_name, actor_role, invoice_id,
       invoice_number, vendor, amount, currency, notes)
     VALUES ($1,'INVOICE_SAVED',$2,'accountant',$3,$4,$5,$6,$7,'Submitted via voice assistant')`,
    [userId, actorName || 'Voice Assistant', invoiceId,
     f.invoice_number ?? null, f.vendor, f.amount, currency],
  );

  log.info({ invoiceId, vendor: f.vendor, amount: f.amount, currency }, 'voice invoice saved');
  return { invoiceId, vendor: f.vendor, amount: f.amount, currency, normalized, invoiceDate };
}
