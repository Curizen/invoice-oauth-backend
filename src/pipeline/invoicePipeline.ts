import { pool, audit } from '../db.js';
import { logger } from '../logger.js';
import type { Provider } from '../providers.js';
import { extractInvoiceFields, type ExtractedInvoice } from './llm.js';
import { normalizeForSave } from './currency.js';
import * as graphMail from './graphMail.js';
import * as gmailMail from './gmailMail.js';
import { uploadToOneDrive, type GraphMessage } from './graphMail.js';
import { checkDuplicateViaN8n } from './duplicateCheck.js';
import { checkVendorIntel } from './vendorIntel.js';
import { sendAnomalyAlertEmail } from '../anomalyAlert.js';

// Mail access differs by provider (Microsoft Graph vs Gmail) but both modules
// expose the same list/listAttachments/download shape, so the pipeline is
// provider-agnostic. OneDrive upload is Microsoft-only and always goes through
// the user's chosen storage connection (see syncConnection).
function mailApi(provider: Provider) {
  return provider === 'google' ? gmailMail : graphMail;
}

// pdf-parse is CJS; importing the lib file avoids its debug-mode side effect.
// @ts-expect-error no types shipped
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const BASE_CURRENCY = process.env.BASE_CURRENCY ?? 'USD';

const log = logger.child({ component: 'pipeline' });

/** Per-run tallies, bubbled up so the scheduler can log a tick summary. */
export interface SyncCounts {
  saved: number;
  duplicates: number;
  skipped: number;
}
function emptyCounts(): SyncCounts {
  return { saved: 0, duplicates: 0, skipped: 0 };
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
  provider: Provider,
  storeConnectionId: string,
  msg: GraphMessage,
  parentLog: typeof log,
): Promise<SyncCounts> {
  const counts = emptyCounts();
  const api = mailApi(provider);
  const mlog = parentLog.child({ messageId: msg.id, subject: msg.subject ?? '' });

  const attachments = await api.listAttachments(connectionId, msg.id);
  mlog.info({ attachments: attachments.length }, 'message: listing attachments');

  for (const att of attachments) {
    const alog = mlog.child({ attachment: att.name });

    // Port of "Is PDF or Image?" IF node.
    const ct = (att.contentType ?? '').toLowerCase();
    if (!ct.includes('pdf') && !ct.includes('image')) {
      alog.debug({ contentType: att.contentType }, 'skip: not a PDF or image');
      counts.skipped += 1;
      continue;
    }

    // Dedupe on (connection, message, attachment) — replaces trigger state.
    const seen = await pool.query(
      `SELECT 1 FROM invoices
       WHERE connected_account_id = $1 AND email_message_id = $2 AND attachment_name = $3`,
      [connectionId, msg.id, att.name],
    );
    if (seen.rowCount) {
      alog.info('skip: attachment already processed');
      counts.skipped += 1;
      continue;
    }

    alog.info('downloading attachment');
    const fileBuf = await api.downloadAttachment(connectionId, msg.id, att.id);

    // Port of "Extract from File": PDFs get text; images pass empty text
    // (the LLM then works from email subject/body, matching old behavior
    // where image attachments skipped the PDF-text step).
    let pdfText = '';
    if (ct.includes('pdf')) {
      try {
        pdfText = ((await pdfParse(fileBuf)) as { text: string }).text ?? '';
        alog.debug({ pdfChars: pdfText.length }, 'parsed PDF text');
      } catch {
        pdfText = '';
        alog.warn('PDF parse failed; falling back to email text');
      }
    }

    alog.info('extracting invoice fields via LLM');
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
    alog.info(
      {
        vendor: inv.vendor,
        invoiceNumber: inv.invoice_number,
        amount: inv.amount,
        currency: inv.currency,
        category: inv.category,
      },
      'extracted invoice fields',
    );

    // Smart Duplicate Detection: n8n fuzzy match on vendor history when
    // configured, else exact match on vendor + invoice number. Runs BEFORE
    // the vendor upsert so a skipped duplicate never pollutes vendor rolling
    // stats. The per-attachment dedupe above already covers the same email
    // being re-fetched; this covers the same invoice arriving as a different
    // attachment/message.
    const invoiceDateForFx = inv.invoice_date ?? new Date().toISOString().slice(0, 10);
    const n8nDup = await checkDuplicateViaN8n({
      vendor: inv.vendor, amount: inv.amount, currency: inv.currency,
      invoiceNumber: inv.invoice_number, date: invoiceDateForFx,
    });
    if (n8nDup) {
      if (n8nDup.blocked) {
        // n8n already wrote its own duplicate_log row; keep our audit trail.
        await pool.query(
          `INSERT INTO audit_log (user_id, action, actor_name, actor_role,
             invoice_number, vendor, amount, currency, notes)
           VALUES ($1,'DUPLICATE_BLOCKED','Email Bot','accountant',$2,$3,$4,$5,$6)`,
          [userId, inv.invoice_number, inv.vendor, inv.amount, inv.currency,
           `Duplicate detected by Smart Duplicate Detection (confidence ${n8nDup.confidence}): ${n8nDup.reason}`],
        );
        await audit(connectionId, 'invoice_duplicate_skipped', {
          vendor: inv.vendor, invoice_number: inv.invoice_number,
        });
        alog.warn({ reason: n8nDup.reason, confidence: n8nDup.confidence }, 'duplicate blocked (n8n)');
        counts.duplicates += 1;
        continue;
      }
    } else if (inv.invoice_number) {
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
        alog.warn({ matchedInvoiceId: dup.rows[0].id }, 'duplicate blocked');
        counts.duplicates += 1;
        continue;
      }
    }

    // Convert via the shared helper (Multi-Currency Normalization workflow when
    // configured, inline converter as fallback) — same logic as the voice path.
    const { normalized, rate, exchangeDate } = await normalizeForSave(
      inv.amount, inv.currency, invoiceDateForFx,
    );
    if (rate !== 1) {
      alog.debug({ from: inv.currency, to: BASE_CURRENCY, rate, normalized }, 'normalized amount');
    }

    // Vendor Intelligence: fetch AI-driven anomaly assessment BEFORE the
    // vendor upsert below, so the comparison baseline excludes this invoice.
    const vendorIntel = await checkVendorIntel({
      vendor: inv.vendor, amount: normalized, currency: BASE_CURRENCY,
      invoiceNumber: inv.invoice_number, date: invoiceDateForFx,
    });

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
    alog.debug({ vendorId, vendor: inv.vendor }, 'vendor upserted');

    // Upload always targets the user's chosen Microsoft OneDrive (storeConnectionId),
    // NOT the receiving connection — that's how a Gmail invoice lands in OneDrive.
    const { folder, filename } = buildPath(inv);
    alog.info({ path: `${folder}/${filename}` }, 'uploading to OneDrive');
    const uploaded = await uploadToOneDrive(
      storeConnectionId, `${folder}/${filename}`, fileBuf, att.contentType || 'application/pdf',
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
    if (!inserted.rows[0]) {
      alog.info('skip: saved by a concurrent run');
      counts.skipped += 1;
      continue;
    }
    const invoiceId = inserted.rows[0].id;

    // Vendor Intelligence: use the n8n result when available, else fall back
    // to flagging amounts that deviate sharply from the vendor's typical
    // amount (only when a baseline exists).
    if (vendorIntel) {
      const deviationPct = typicalAmount > 0 ? ((normalized - typicalAmount) / typicalAmount) * 100 : 0;
      await pool.query(
        `INSERT INTO anomaly_log
           (invoice_id, vendor, new_amount, typical_amount, deviation_pct, anomaly_level, insight)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invoiceId, inv.vendor, normalized, typicalAmount, deviationPct, vendorIntel.anomalyLevel, vendorIntel.insight],
      );
      await pool.query(
        `UPDATE invoices SET anomaly_level = $2, anomaly_insight = $3 WHERE id = $1`,
        [invoiceId, vendorIntel.anomalyLevel, vendorIntel.insight],
      );
      await pool.query(
        `INSERT INTO audit_log (user_id, action, actor_name, actor_role, invoice_id,
           invoice_number, vendor, amount, currency, notes)
         VALUES ($1,'ANOMALY_FLAGGED','Email Bot','accountant',$2,$3,$4,$5,$6,$7)`,
        [userId, invoiceId, inv.invoice_number, inv.vendor, inv.amount, inv.currency, vendorIntel.insight],
      );
      alog.warn({ invoiceId, anomalyLevel: vendorIntel.anomalyLevel, via: 'n8n' }, 'anomaly flagged');
      // Fire-and-forget: a failed alert email must not fail the save.
      void sendAnomalyAlertEmail(userId, {
        vendor: inv.vendor, amount: normalized, currency: BASE_CURRENCY, typicalAmount,
        level: vendorIntel.anomalyLevel, insight: vendorIntel.insight,
        invoiceNumber: inv.invoice_number, invoiceDate: invoiceDateForFx,
        onedriveUrl: uploaded.webUrl ?? null, source: 'email',
      });
    } else if (typicalAmount > 0) {
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
        alog.warn({ invoiceId, deviationPct: Math.round(deviationPct), anomalyLevel }, 'anomaly flagged');
        void sendAnomalyAlertEmail(userId, {
          vendor: inv.vendor, amount: normalized, currency: BASE_CURRENCY, typicalAmount,
          level: anomalyLevel, insight,
          invoiceNumber: inv.invoice_number, invoiceDate: invoiceDateForFx,
          onedriveUrl: uploaded.webUrl ?? null, source: 'email',
        });
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
    alog.info(
      { invoiceId, vendor: inv.vendor, amount: inv.amount, currency: inv.currency, onedriveUrl: uploaded.webUrl },
      'invoice saved',
    );
    counts.saved += 1;
  }

  return counts;
}

/**
 * Process one connection: fetch new messages since cursor, handle each.
 * Every extracted invoice is filed into `storeConnectionId`'s OneDrive — the
 * user's chosen Microsoft account — regardless of which mailbox it came from.
 * If the user hasn't picked a storage account yet, skip (nothing can be filed).
 */
export async function syncConnection(
  connectionId: string,
  userId: string,
  provider: Provider,
  storeConnectionId: string | null,
): Promise<SyncCounts> {
  const clog = log.child({ connectionId, provider });
  const totals = emptyCounts();

  if (!storeConnectionId) {
    clog.warn('skip: no invoice storage account selected — pick a Microsoft mailbox in the app');
    return totals;
  }

  const state = await pool.query(
    `INSERT INTO invoice_sync_state (connected_account_id)
     VALUES ($1) ON CONFLICT (connected_account_id) DO UPDATE SET last_run_at = now()
     RETURNING last_received_at`,
    [connectionId],
  );
  const since: Date = state.rows[0].last_received_at;

  const messages = await mailApi(provider).listNewMessages(connectionId, since.toISOString());
  clog.info({ since: since.toISOString(), messages: messages.length }, 'connection: fetched new messages');

  for (const msg of messages) {
    try {
      const c = await processMessage(connectionId, userId, provider, storeConnectionId, msg, clog);
      totals.saved += c.saved;
      totals.duplicates += c.duplicates;
      totals.skipped += c.skipped;
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
      clog.error({ messageId: msg.id, err }, 'message processing failed; stopping this connection run');
      throw err; // stop this connection's run; scheduler isolates per connection
    }
  }

  if (messages.length) {
    clog.info({ ...totals }, 'connection: run complete');
  }
  return totals;
}
