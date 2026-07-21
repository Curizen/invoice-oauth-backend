import { config } from '../config.js';
import { logger } from '../logger.js';

// Calls the n8n "Vendor Intelligence" workflow, which analyzes a new invoice
// against the vendor's historical profile via an LLM and returns a 3-tier
// severity + human-readable insight. It also PATCHes the vendor's row with
// the pre-this-invoice baseline as a side effect, so it must be called
// BEFORE the caller's own vendor upsert (which is authoritative for
// total_spent/min/max/invoice_count and correctly overwrites the soft-touch
// values this call sets). Fails open: returns null when the webhook isn't
// configured, errors, or reports no anomaly, so the caller can fall back to
// the inline deviation-% check.

const log = logger.child({ component: 'vendor-intel' });

export interface VendorIntelResult {
  anomalyLevel: 'low' | 'medium' | 'high';
  insight: string;
}

export async function checkVendorIntel(opts: {
  vendor: string;
  amount: number;
  currency: string;
  invoiceNumber: string | null;
  date: string | null;
}): Promise<VendorIntelResult | null> {
  const url = config.n8nVendorIntelWebhookUrl;
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
      }),
    });
    const data = (await res.json()) as {
      status?: string; anomaly_level?: string; insight?: string;
    };
    if (!res.ok) {
      log.warn({ status: res.status }, 'vendor-intel workflow error; falling back to inline check');
      return null;
    }
    if (data.status !== 'flagged') return null;
    if (data.anomaly_level !== 'low' && data.anomaly_level !== 'medium' && data.anomaly_level !== 'high') {
      return null;
    }
    return { anomalyLevel: data.anomaly_level, insight: data.insight ?? '' };
  } catch (err) {
    log.warn({ err }, 'vendor-intel workflow unreachable; falling back to inline check');
    return null;
  }
}
