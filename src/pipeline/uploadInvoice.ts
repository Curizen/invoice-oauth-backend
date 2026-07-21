import path from 'node:path';
import { pool } from '../db.js';
import { logger } from '../logger.js';
import { extractInvoiceFields, extractInvoiceFromImage, type ExtractedInvoice } from './llm.js';
import { normalizeForSave } from './currency.js';
import { uploadToOneDrive } from './graphMail.js';
import { checkDuplicateViaN8n } from './duplicateCheck.js';
import { checkVendorIntel } from './vendorIntel.js';
import { sendAnomalyAlertEmail } from '../anomalyAlert.js';

// pdf-parse is CJS; importing the lib file avoids its debug-mode side effect.
// @ts-expect-error no types shipped
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

// Manual invoice upload: a user drops a PDF or image in the UI. We extract the
// fields (pdf-parse + LLM for PDFs, GPT-4o vision for images), file the file in
// the user's chosen OneDrive, and save to the invoices table (source='upload').
// Mirrors the email pipeline's DB writes but triggered by a direct upload.

const BASE_CURRENCY = process.env.BASE_CURRENCY ?? 'USD';
const log = logger.child({ component: 'upload-invoice' });

export interface UploadResult {
  status: 'saved' | 'duplicate';
  invoiceId?: string;
  matchedInvoiceId?: string;
  vendor: string;
  amount: number;
  currency: string;
  onedriveUrl?: string | null;
  anomaly?: { level: string; insight: string } | null;
}

function buildPath(inv: ExtractedInvoice, originalName: string): { folder: string; filename: string } {
  const vendorClean = inv.vendor.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Unknown Vendor';
  const date = inv.invoice_date ?? new Date().toISOString().slice(0, 10);
  const ext = path.extname(originalName) || '.pdf';
  return {
    folder: `Invoices/${vendorClean}`,
    filename: `${inv.invoice_number ?? 'invoice'}_${vendorClean}_${date}${ext}`,
  };
}

/** Just the field extraction, no side effects — used for the review-before-save flow. */
export async function extractUploadedInvoice(
  buffer: Buffer,
  contentType: string,
  filename: string,
): Promise<ExtractedInvoice> {
  const ct = (contentType || '').toLowerCase();
  const isPdf = ct.includes('pdf');
  const isImage = ct.includes('image');
  if (!isPdf && !isImage) throw new Error('Only PDF or image files are supported');

  const flog = log.child({ filename });

  // Extract fields: PDF text via pdf-parse + LLM, images via GPT-4o vision.
  let inv: ExtractedInvoice;
  if (isPdf) {
    let pdfText = '';
    try {
      pdfText = ((await pdfParse(buffer)) as { text: string }).text ?? '';
    } catch {
      flog.warn('PDF parse failed; extracting from filename only');
    }
    inv = await extractInvoiceFields(
      { subject: filename, fromAddress: '', fromName: '', bodyPreview: '', receivedDateTime: new Date().toISOString(), messageId: 'upload' },
      filename,
      pdfText,
    );
  } else {
    inv = await extractInvoiceFromImage(buffer.toString('base64'), contentType, filename);
  }
  flog.info({ vendor: inv.vendor, amount: inv.amount, currency: inv.currency }, 'extracted invoice fields');
  return inv;
}

export async function saveUploadedInvoice(opts: {
  userId: string;
  storeConnectionId: string;
  actorName: string;
  filename: string;
  contentType: string;
  buffer: Buffer;
  // Pre-extracted (and possibly user-corrected) fields, e.g. from the
  // review-before-save flow. When omitted, extraction runs here instead —
  // kept for the voice assistant's single-shot upload path.
  invoice?: ExtractedInvoice;
}): Promise<UploadResult> {
  const { userId, storeConnectionId, actorName, filename, contentType, buffer } = opts;
  const flog = log.child({ filename });

  const inv = opts.invoice ?? (await extractUploadedInvoice(buffer, contentType, filename));

  const invoiceDate = inv.invoice_date ?? new Date().toISOString().slice(0, 10);

  // Duplicate check: n8n "Smart Duplicate Detection" (fuzzy match on vendor
  // history) when configured, else exact match on vendor + invoice number.
  const n8nDup = await checkDuplicateViaN8n({
    vendor: inv.vendor, amount: inv.amount, currency: inv.currency,
    invoiceNumber: inv.invoice_number, date: invoiceDate,
  });
  if (n8nDup) {
    if (n8nDup.blocked) {
      // n8n already wrote its own duplicate_log row; keep our audit_log entry.
      await pool.query(
        `INSERT INTO audit_log (user_id, action, actor_name, actor_role, invoice_number, vendor, amount, currency, notes)
         VALUES ($1,'DUPLICATE_BLOCKED',$2,'accountant',$3,$4,$5,$6,$7)`,
        [userId, actorName || 'Upload', inv.invoice_number, inv.vendor, inv.amount, inv.currency,
         `Duplicate detected by Smart Duplicate Detection (confidence ${n8nDup.confidence}): ${n8nDup.reason}`],
      );
      flog.warn({ reason: n8nDup.reason, confidence: n8nDup.confidence }, 'duplicate blocked (n8n)');
      return { status: 'duplicate', vendor: inv.vendor, amount: inv.amount, currency: inv.currency };
    }
  } else if (inv.invoice_number) {
    const dup = await pool.query<{ id: string }>(
      `SELECT id FROM invoices WHERE user_id = $1 AND vendor = $2 AND invoice_number = $3 LIMIT 1`,
      [userId, inv.vendor, inv.invoice_number],
    );
    if (dup.rowCount) {
      await pool.query(
        `INSERT INTO duplicate_log (matched_invoice_id, vendor, amount, currency, is_duplicate, reason, action)
         VALUES ($1,$2,$3,$4,true,'vendor+invoice_number match','skipped')`,
        [dup.rows[0].id, inv.vendor, inv.amount, inv.currency],
      );
      await pool.query(
        `INSERT INTO audit_log (user_id, action, actor_name, actor_role, invoice_number, vendor, amount, currency, notes)
         VALUES ($1,'DUPLICATE_BLOCKED',$2,'accountant',$3,$4,$5,$6,$7)`,
        [userId, actorName || 'Upload', inv.invoice_number, inv.vendor, inv.amount, inv.currency,
         `Duplicate upload of invoice ${dup.rows[0].id}`],
      );
      flog.warn({ matchedInvoiceId: dup.rows[0].id }, 'duplicate blocked');
      return { status: 'duplicate', matchedInvoiceId: dup.rows[0].id, vendor: inv.vendor, amount: inv.amount, currency: inv.currency };
    }
  }

  const { normalized, rate, exchangeDate } = await normalizeForSave(inv.amount, inv.currency, invoiceDate);

  // Vendor intelligence: fetch AI-driven anomaly assessment BEFORE the vendor
  // upsert below, so the comparison baseline excludes this invoice.
  const vendorIntel = await checkVendorIntel({
    vendor: inv.vendor, amount: normalized, currency: BASE_CURRENCY,
    invoiceNumber: inv.invoice_number, date: invoiceDate,
  });

  const vendorRes = await pool.query<{ id: string; typical_amount: string | null }>(
    `INSERT INTO vendors (name, invoice_count, total_spent, min_amount, max_amount, last_invoice_date)
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
  const typicalAmount = vendorRes.rows[0].typical_amount != null ? Number(vendorRes.rows[0].typical_amount) : 0;

  const { folder, filename: storedName } = buildPath(inv, filename);
  flog.info({ path: `${folder}/${storedName}` }, 'uploading to OneDrive');
  const uploaded = await uploadToOneDrive(storeConnectionId, `${folder}/${storedName}`, buffer, contentType || 'application/pdf');

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO invoices
      (user_id, vendor, vendor_id, invoice_number,
       original_amount, original_currency, normalized_amount, base_currency,
       exchange_rate, exchange_date,
       invoice_date, due_date, category, description, tax_amount, source,
       attachment_name, onedrive_url, onedrive_file_id, onedrive_folder)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'upload',$16,$17,$18,$19)
     RETURNING id`,
    [
      userId, inv.vendor, vendorId, inv.invoice_number,
      inv.amount, inv.currency, normalized, BASE_CURRENCY,
      rate, exchangeDate,
      invoiceDate, inv.due_date, inv.category, inv.description, inv.tax_amount,
      filename, uploaded.webUrl ?? null, uploaded.id, folder,
    ],
  );
  const invoiceId = inserted.rows[0].id;

  // Anomaly check: n8n "Vendor Intelligence" result when available, else the
  // inline typical_amount deviation-% check.
  let anomaly: { level: string; insight: string } | null = null;
  if (vendorIntel) {
    anomaly = { level: vendorIntel.anomalyLevel, insight: vendorIntel.insight };
    await pool.query(
      `INSERT INTO anomaly_log (invoice_id, vendor, new_amount, typical_amount, deviation_pct, anomaly_level, insight)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [invoiceId, inv.vendor, normalized, typicalAmount, typicalAmount > 0 ? ((normalized - typicalAmount) / typicalAmount) * 100 : 0, vendorIntel.anomalyLevel, vendorIntel.insight],
    );
    await pool.query(`UPDATE invoices SET anomaly_level = $2, anomaly_insight = $3 WHERE id = $1`, [invoiceId, vendorIntel.anomalyLevel, vendorIntel.insight]);
    await pool.query(
      `INSERT INTO audit_log (user_id, action, actor_name, actor_role, invoice_id, invoice_number, vendor, amount, currency, notes)
       VALUES ($1,'ANOMALY_FLAGGED',$2,'accountant',$3,$4,$5,$6,$7,$8)`,
      [userId, actorName || 'Upload', invoiceId, inv.invoice_number, inv.vendor, inv.amount, inv.currency, vendorIntel.insight],
    );
    flog.warn({ invoiceId, anomalyLevel: vendorIntel.anomalyLevel, via: 'n8n' }, 'anomaly flagged');
  } else if (typicalAmount > 0) {
    const deviationPct = ((normalized - typicalAmount) / typicalAmount) * 100;
    if (Math.abs(deviationPct) >= 50) {
      const anomalyLevel = Math.abs(deviationPct) > 100 ? 'high' : 'medium';
      const insight = `Amount ${normalized} ${BASE_CURRENCY} is ${deviationPct >= 0 ? 'up' : 'down'} ${Math.abs(deviationPct).toFixed(0)}% vs typical ${typicalAmount} for ${inv.vendor}.`;
      anomaly = { level: anomalyLevel, insight };
      await pool.query(
        `INSERT INTO anomaly_log (invoice_id, vendor, new_amount, typical_amount, deviation_pct, anomaly_level, insight)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invoiceId, inv.vendor, normalized, typicalAmount, deviationPct, anomalyLevel, insight],
      );
      await pool.query(`UPDATE invoices SET anomaly_level = $2, anomaly_insight = $3 WHERE id = $1`, [invoiceId, anomalyLevel, insight]);
      await pool.query(
        `INSERT INTO audit_log (user_id, action, actor_name, actor_role, invoice_id, invoice_number, vendor, amount, currency, notes)
         VALUES ($1,'ANOMALY_FLAGGED',$2,'accountant',$3,$4,$5,$6,$7,$8)`,
        [userId, actorName || 'Upload', invoiceId, inv.invoice_number, inv.vendor, inv.amount, inv.currency, insight],
      );
      flog.warn({ invoiceId, deviationPct: Math.round(deviationPct), anomalyLevel }, 'anomaly flagged');
    }
  }

  if (anomaly) {
    // Fire-and-forget: a failed alert email must not fail (or delay) the save.
    void sendAnomalyAlertEmail(userId, {
      vendor: inv.vendor, amount: normalized, currency: BASE_CURRENCY, typicalAmount,
      level: anomaly.level, insight: anomaly.insight,
      invoiceNumber: inv.invoice_number, invoiceDate,
      onedriveUrl: uploaded.webUrl ?? null, source: 'manual upload',
    });
  }

  await pool.query(
    `INSERT INTO audit_log (user_id, action, actor_name, actor_role, invoice_id, invoice_number, vendor, amount, currency, notes)
     VALUES ($1,'INVOICE_SAVED',$2,'accountant',$3,$4,$5,$6,$7,$8)`,
    [userId, actorName || 'Upload', invoiceId, inv.invoice_number, inv.vendor, inv.amount, inv.currency,
     `Uploaded via UI: ${filename} -> ${uploaded.webUrl ?? folder}`],
  );
  flog.info({ invoiceId, vendor: inv.vendor, amount: inv.amount, onedriveUrl: uploaded.webUrl }, 'upload invoice saved');

  return { status: 'saved', invoiceId, vendor: inv.vendor, amount: inv.amount, currency: inv.currency, onedriveUrl: uploaded.webUrl ?? null, anomaly };
}
