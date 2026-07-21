import { config } from '../config.js';
import { logger } from '../logger.js';

// pdf-parse is CJS; importing the lib file avoids its debug-mode side effect.
// @ts-expect-error no types shipped
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

// Employment-contract extraction: pdf-parse the uploaded PDF, send the text to
// the n8n "Contract Extractor via Webhook" workflow (which runs Claude), and
// normalize the returned JSON. The caller shows the result in a review form —
// nothing is applied to the employee until the user confirms.

const log = logger.child({ component: 'contract-extract' });

export interface ExtractedContract {
  employee_name: string | null;
  role: string | null;
  start_date: string | null;
  end_date: string | null;
  salary_amount: number | null;
  salary_currency: string | null;
  notice_period: string | null;
  probation_end: string | null;
  vacation_days: number | null;
  sick_days: number | null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? null : n;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Same defensive parse as the invoice pipeline: strip fences, find {...}. */
export function parseContractJson(raw: string): ExtractedContract {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  let parsed: Record<string, unknown> = {};
  if (start !== -1 && end !== -1) {
    try {
      parsed = JSON.parse(cleaned.substring(start, end + 1)) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  return {
    employee_name: str(parsed.employee_name),
    role: str(parsed.role),
    start_date: str(parsed.start_date),
    end_date: str(parsed.end_date),
    salary_amount: num(parsed.salary_amount),
    salary_currency: str(parsed.salary_currency)?.toUpperCase() ?? null,
    notice_period: str(parsed.notice_period),
    probation_end: str(parsed.probation_end),
    vacation_days: num(parsed.vacation_days),
    sick_days: num(parsed.sick_days),
  };
}

export async function pdfToText(buffer: Buffer): Promise<string> {
  try {
    return ((await pdfParse(buffer)) as { text: string }).text ?? '';
  } catch (err) {
    log.warn({ err }, 'contract PDF parse failed; sending empty text');
    return '';
  }
}

/**
 * Send contract text to the n8n webhook (Claude extraction). Returns null when
 * the webhook is not configured so the upload can still be stored.
 *
 * Scanned contracts have no text layer, so pdf-parse yields (almost) nothing.
 * In that case we ship the PDF itself (base64) and Claude reads it visually.
 */
export async function extractContractFields(
  filename: string,
  pdfText: string,
  pdfBase64?: string,
): Promise<ExtractedContract | null> {
  if (!config.n8nContractWebhookUrl) return null;

  const text = pdfText.trim();
  const isScanned = text.length < 200 && pdfBase64 != null;
  // n8n cloud rejects webhook payloads over ~16 MB; leave headroom for JSON.
  if (isScanned && pdfBase64!.length > 14 * 1024 * 1024) {
    throw new Error('Scanned PDF is too large for AI extraction (max ~10 MB)');
  }

  const upstream = await fetch(config.n8nContractWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename,
      pdf_text: text.slice(0, 15000),
      pdf_base64: isScanned ? pdfBase64 : null,
    }),
  });
  const raw = await upstream.text();
  if (!upstream.ok) {
    log.error({ status: upstream.status, raw: raw.slice(0, 500) }, 'n8n contract webhook error');
    throw new Error(`Contract extraction upstream error (${upstream.status})`);
  }

  // n8n may return the object directly, wrap it under `output`, or return a
  // string the model produced — parseContractJson handles all three.
  let payload = raw;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    payload = JSON.stringify(data.output ?? data);
  } catch {
    /* keep raw */
  }
  return parseContractJson(payload);
}
