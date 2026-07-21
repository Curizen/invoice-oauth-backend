import { config } from '../config.js';
import { logger } from '../logger.js';

// Shared currency conversion used by BOTH the email pipeline and the voice
// save path, so invoices convert identically no matter how they arrive.

const BASE_CURRENCY = process.env.BASE_CURRENCY ?? 'USD';
const log = logger.child({ component: 'currency' });

export interface Normalized {
  normalized: number;
  rate: number;
  exchangeDate: string | null;
}

/** Inline converter: latest daily rates from a free API. Fails open to 1:1. */
let ratesCache: { at: number; rates: Record<string, number> } | null = null;
export async function normalizeAmount(
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

/**
 * Convert an amount to the base currency for storage. When the n8n
 * Multi-Currency Normalization workflow is configured, route through it (it
 * uses Frankfurter historical rates on the invoice date); otherwise, or if it
 * is unreachable, fall back to the inline converter. Same currency needs no
 * conversion.
 */
export async function normalizeForSave(
  amount: number,
  currency: string,
  invoiceDate: string,
): Promise<Normalized> {
  if (!amount || currency === BASE_CURRENCY) {
    return { normalized: amount, rate: 1, exchangeDate: null };
  }

  const url = config.n8nNormalizeCurrencyWebhookUrl;
  if (url) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, currency, base_currency: BASE_CURRENCY, date: invoiceDate }),
      });
      const data = (await res.json()) as {
        normalized_amount?: number; exchange_rate?: number; exchange_date?: string;
      };
      if (res.ok && data.normalized_amount != null) {
        log.info({ currency, rate: data.exchange_rate, via: 'workflow' }, 'currency normalized via workflow');
        return {
          normalized: Math.round(Number(data.normalized_amount) * 100) / 100,
          rate: Number(data.exchange_rate ?? 1),
          exchangeDate: data.exchange_date ?? invoiceDate,
        };
      }
      log.warn({ currency, status: res.status }, 'normalize workflow gave no rate; using inline');
    } catch (err) {
      log.warn({ err, currency }, 'normalize workflow failed; using inline converter');
    }
  }

  const { normalized, rate } = await normalizeAmount(amount, currency);
  return { normalized, rate, exchangeDate: rate !== 1 ? new Date().toISOString().slice(0, 10) : null };
}
