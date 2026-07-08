import { pool, audit } from '../db.js';
import { extractInvoiceFields, type ExtractedInvoice } from './llm.js';
import {
  listNewMessages, listAttachments, downloadAttachment, uploadToOneDrive,
  type GraphMessage,
} from './graphMail.js';

// pdf-parse is CJS; importing the lib file avoids its debug-mode side effect.
// @ts-expect-error no types shipped
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const BASE_CURRENCY = process.env.BASE_CURRENCY ?? 'USD';

/** Port of "currency normalization" webhook: convert to base currency.
 *  Uses a free daily-rates API; falls back to 1:1 on any failure.
 *  Returns both the normalized amount and the rate actually used, so the
 *  caller can persist exchange_rate / exchange_date. rate === 1 means no
 *  conversion was applied (same currency, missing rate, or fetch failure). */
let ratesCache: { at: number; rates: Record<string, number> } | null = null;
async function normalizeAmount(
  amount: number,
  currency: string,
): Promise<{ normalized: number; rate: number }> {
  if (!amount || currency === BASE_CURRENCY) return { normalized: amount, rate: 1 };
  try {
    if (!ratesCache || Date.now() - ratesCache.at > 12 * 3600_000) {
      const res = await fetch(`https://open.er-api.com/v6/latest/${BASE_CURRENCY}`);
      const data = (await res.json()) as { rates: Record<string, number> };
      ratesCache = { at: Date.now(), rates: data.rates };
    }
    const rate = ratesCache.rates[currency];
    if (!rate) return { normalized: amount, rate: 1 }; // fail open
    return { normalized: Math.round((amount / rate) * 100) / 100, rate };
  } catch {
    return { normalized: amount, rate: 1 }; // fail open: store original as normalized
  }
}

/** Port of the "Build OneDrive Path" Set node. */
function buildPath(inv: ExtractedInvoice): { folder: string; filename: string } {
  const vendorClean = inv.vendor.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Unknown Vendor';
  const date = inv.invoice_date ?? new Date().toISOString().slice(0, 10);
  return {
    folder: `Invoices/${vendorClean}`,
    filename: `${inv.invoice_number ?? 'invoice'}_${vendorClean}_${date}.pdf`,
  };
}

async function processMessage(
  connectionId: string,
  userId: string,
  msg: GraphMessage,
): Promise<void> {
  const attachments = await listAttachments(connectionId, msg.id);

  for (const att of attachments) {
    // Port of "Is PDF or Image?" IF node.
    const ct = (att.contentType ?? '').toLowerCase();
    if (!ct.includes('pdf') && !ct.includes('image')) continue;

    // Dedupe on (connection, message, attachment) — replaces trigger state.
    const seen = await pool.query(
      `SELECT 1 FROM invoices
       WHERE connected_account_id = $1 AND email_message_id = $2 AND attachment_name = $3`,
      [connectionId, msg.id, att.name],
    );
    if (seen.rowCount) continue;

    const fileBuf = await downloadAttachment(connectionId, msg.id, att.id);

    // Port of "Extract from File": PDFs get text; images pass empty text
    // (the LLM then works from email subject/body, matching old behavior
    // where image attachments skipped the PDF-text step).
    let pdfText = '';
    if (ct.includes('pdf')) {
      try {
        pdfText = ((await pdfParse(fileBuf)) as { text: string }).text ?? '';
      } catch {
        pdfText = '';
      }
    }

    const inv = await extractInvoiceFields(
      {
        subject: msg.subject ?? '',
        fromAddress: msg.from?.emailAddress?.address ?? '',
        fromName: msg.from?.emailAddress?.name ?? '',
        bodyPreview: msg.bodyPreview ?? '',
        receivedDateTime: msg.receivedDateTime,
        messageId: msg.id,
      },
      att.name,
      pdfText,
    );

    // Port of "smart duplicate detection": same user + vendor + invoice number.
    // Runs BEFORE the vendor upsert so a skipped duplicate never pollutes
    // vendor rolling stats. The per-attachment dedupe above already covers
    // the same email being re-fetched; this covers the same invoice arriving
    // as a different attachment/message.
    if (inv.invoice_number) {
      const dup = await pool.query<{ id: string }>(
        `SELECT id FROM invoices
         WHERE user_id = $1 AND vendor = $2 AND invoice_number = $3
         LIMIT 1`,
        [userId, inv.vendor, inv.invoice_number],
      );
      if (dup.rowCount) {
        await pool.query(
          `INSERT INTO duplicate_log
             (matched_invoice_id, vendor, amount, currency, is_duplicate, reason, action)
           VALUES ($1,$2,$3,$4,true,'vendor+invoice_number match','skipped')`,
          [dup.rows[0].id, inv.vendor, inv.amount, inv.currency],
        );
        await pool.query(
          `INSERT INTO audit_log (user_id, action, actor_name, actor_role,
             invoice_number, vendor, amount, currency, notes)
           VALUES ($1,'DUPLICATE_BLOCKED','Email Bot','accountant',$2,$3,$4,$5,$6)`,
          [userId, inv.invoice_number, inv.vendor, inv.amount, inv.currency,
           `Duplicate of invoice ${dup.rows[0].id}: ${inv.vendor} #${inv.invoice_number}`],
        );
        // Keep the existing connection-level audit event.
        await audit(connectionId, 'invoice_duplicate_skipped', {
          vendor: inv.vendor, invoice_number: inv.invoice_number,
        });
        continue;
      }
    }

    const { normalized, rate } = await normalizeAmount(inv.amount, inv.currency);
    const rateApplied = rate !== 1;
    const exchangeDate = rateApplied ? new Date().toISOString().slice(0, 10) : null;

    // VENDOR FIRST: upsert the vendor by name, then use its id on the invoice.
    // Numeric accumulators use COALESCE so pre-existing rows with NULLs (or
    // brand-new inserts) don't propagate NULL. typical_amount is left
    // untouched on update — it's the anomaly baseline maintained elsewhere.
    const vendorRes = await pool.query<{ id: string; typical_amount: string | null }>(
      `INSERT INTO vendors
         (name, invoice_count, total_spent, min_amount, max_amount, last_invoice_date)
       VALUES ($1, 1, $2, $2, $2, $3)
       ON CONFLICT (name) DO UPDATE SET
         invoice_count     = COALESCE(vendors.invoice_count, 0) + 1,
         total_spent       = COALESCE(vendors.total_spent, 0) + EXCLUDED.total_spent,
         min_amount        = LEAST(vendors.min_amount, EXCLUDED.min_amount),
         max_amount        = GREATEST(vendors.max_amount, EXCLUDED.max_amount),
         last_invoice_date = GREATEST(vendors.last_invoice_date, EXCLUDED.last_invoice_date)
       RETURNING id, typical_amount`,
      [inv.vendor, normalized, inv.invoice_date],
    );
    const vendorId = vendorRes.rows[0].id;
    const typicalAmount = vendorRes.rows[0].typical_amount != null
      ? Number(vendorRes.rows[0].typical_amount)
      : 0;

    const { folder, filename } = buildPath(inv);
    const uploaded = await uploadToOneDrive(
      connectionId, `${folder}/${filename}`, fileBuf, att.contentType || 'application/pdf',
    );

    // Save invoice. No (user,vendor,invoice_number) unique constraint exists
    // in the real schema — the checks above guard duplicates. The only
    // ON CONFLICT target is the invoices_message_dedupe partial unique index,
    // which also covers the rare race with the per-attachment dedupe SELECT.
    // Let DB defaults apply to status and anomaly_level.
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO invoices
        (user_id, connected_account_id, vendor, vendor_id, invoice_number,
         original_amount, original_currency, normalized_amount, base_currency,
         exchange_rate, exchange_date,
         invoice_date, due_date, category, description, tax_amount, source,
         email_subject, email_from, email_message_id, attachment_name,
         onedrive_url, onedrive_file_id, onedrive_folder)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               $18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT (connected_account_id, email_message_id, attachment_name)
         WHERE email_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        userId, connectionId, inv.vendor, vendorId, inv.invoice_number,
        inv.amount, inv.currency, normalized, BASE_CURRENCY,
        rate, exchangeDate,
        inv.invoice_date, inv.due_date, inv.category, inv.description, inv.tax_amount, 'email',
        msg.subject, msg.from?.emailAddress?.address ?? '', msg.id, att.name,
        uploaded.webUrl ?? null, uploaded.id, folder,
      ],
    );
    // Lost the race with a concurrent run that already saved this attachment.
    if (!inserted.rows[0]) continue;
    const invoiceId = inserted.rows[0].id;

    // Port of "vendor intelligence": flag amounts that deviate sharply from
    // the vendor's typical amount. Only run when a baseline exists.
    if (typicalAmount > 0) {
      const deviationPct = ((normalized - typicalAmount) / typicalAmount) * 100;
      if (Math.abs(deviationPct) >= 50) {
        // anomaly_log.anomaly_level is NOT NULL: abs 50–100% -> 'medium',
        // abs > 100% -> 'high' ('none'/'low' can't occur at this threshold).
        const anomalyLevel = Math.abs(deviationPct) > 100 ? 'high' : 'medium';
        const insight =
          `Amount ${normalized} ${BASE_CURRENCY} is ${deviationPct >= 0 ? 'up' : 'down'} ` +
          `${Math.abs(deviationPct).toFixed(0)}% vs typical ${typicalAmount} for ${inv.vendor}.`;
        await pool.query(
          `INSERT INTO anomaly_log
             (invoice_id, vendor, new_amount, typical_amount, deviation_pct, anomaly_level, insight)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [invoiceId, inv.vendor, normalized, typicalAmount, deviationPct, anomalyLevel, insight],
        );
        // Carry the level onto the invoice too (defaults to 'none' otherwise).
        await pool.query(
          `UPDATE invoices SET anomaly_level = $2, anomaly_insight = $3 WHERE id = $1`,
          [invoiceId, anomalyLevel, insight],
        );
        await pool.query(
          `INSERT INTO audit_log (user_id, action, actor_name, actor_role, invoice_id,
             invoice_number, vendor, amount, currency, notes)
           VALUES ($1,'ANOMALY_FLAGGED','Email Bot','accountant',$2,$3,$4,$5,$6,$7)`,
          [userId, invoiceId, inv.invoice_number, inv.vendor, inv.amount, inv.currency, insight],
        );
      }
    }

    // Port of "Log to Audit Trail". action/actor_role use the only known-good
    // enum members ('INVOICE_SAVED' / 'accountant').
    await pool.query(
      `INSERT INTO audit_log (user_id, action, actor_name, actor_role, invoice_id,
         invoice_number, vendor, amount, currency, notes)
       VALUES ($1,'INVOICE_SAVED','Email Bot','accountant',$2,$3,$4,$5,$6,$7)`,
      [userId, invoiceId, inv.invoice_number, inv.vendor, inv.amount, inv.currency,
       `Auto-extracted from Outlook: ${msg.subject} -> ${uploaded.webUrl ?? folder}`],
    );
  }
}

/** Process one connection: fetch new messages since cursor, handle each. */
export async function syncConnection(connectionId: string, userId: string): Promise<void> {
  const state = await pool.query(
    `INSERT INTO invoice_sync_state (connected_account_id)
     VALUES ($1) ON CONFLICT (connected_account_id) DO UPDATE SET last_run_at = now()
     RETURNING last_received_at`,
    [connectionId],
  );
  const since: Date = state.rows[0].last_received_at;

  const messages = await listNewMessages(connectionId, since.toISOString());
  for (const msg of messages) {
    try {
      await processMessage(connectionId, userId, msg);
      // Advance the cursor after EACH message so one bad email doesn't
      // block progress forever, but is retried at most until cursor passes.
      await pool.query(
        `UPDATE invoice_sync_state SET last_received_at = $2, last_error = NULL
         WHERE connected_account_id = $1`,
        [connectionId, msg.receivedDateTime],
      );
    } catch (err) {
      await pool.query(
        `UPDATE invoice_sync_state SET last_error = $2 WHERE connected_account_id = $1`,
        [connectionId, String(err).slice(0, 500)],
      );
      throw err; // stop this connection's run; scheduler isolates per connection
    }
  }
}
