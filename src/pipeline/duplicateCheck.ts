import { config } from '../config.js';
import { logger } from '../logger.js';

// Calls the n8n "Smart Duplicate Detection" workflow, which fuzzy-matches a
// new invoice against the vendor's recent history via an LLM (same invoice
// number, close amount within days, or close amount within the same month).
// Shared by the manual-upload and email-sync pipelines. Fails open: returns
// null when the webhook isn't configured or errors, so the caller can fall
// back to the inline exact-match check.

const log = logger.child({ component: 'duplicate-check' });

export interface DuplicateCheckResult {
  blocked: boolean;
  reason: string;
  confidence: number;
}

export async function checkDuplicateViaN8n(opts: {
  vendor: string;
  amount: number;
  currency: string;
  invoiceNumber: string | null;
  date: string | null;
}): Promise<DuplicateCheckResult | null> {
  const url = config.n8nDuplicateCheckWebhookUrl;
  if (!url) return null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        db_url: `${config.supabase.url}/rest/v1`,
        vendor: opts.vendor,
        amount: opts.amount,
        currency: opts.currency,
        invoice_number: opts.invoiceNumber,
        date: opts.date,
        submitter_phone: '',
        submitter_role: '',
      }),
    });
    const data = (await res.json()) as {
      status?: string; blocked?: boolean; reason?: string; confidence?: number;
    };
    if (!res.ok) {
      log.warn({ status: res.status }, 'duplicate-check workflow error; falling back to inline check');
      return null;
    }
    return {
      blocked: data.status === 'duplicate' || data.blocked === true,
      reason: data.reason ?? '',
      confidence: data.confidence ?? 0,
    };
  } catch (err) {
    log.warn({ err }, 'duplicate-check workflow unreachable; falling back to inline check');
    return null;
  }
}
