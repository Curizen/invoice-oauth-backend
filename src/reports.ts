import { pool } from './db.js';

// Per-user financial report: totals, top vendors, category breakdown, and a
// prior-period comparison — ported from the n8n "Build Report" node but scoped
// to one user and computed in-process so the UI and the scheduled send share it.

export type PeriodType = 'monthly' | 'quarterly' | 'yearly' | 'all';

export interface RangeOpts {
  /** 1-4. Only used with period === 'quarterly'; defaults to the most recently completed quarter. */
  quarter?: number;
  /** Calendar year. Used with 'quarterly' (pairs with `quarter`) and ignored otherwise. */
  year?: number;
}

interface Ranges {
  label: string;
  curStart: string; curEnd: string;
  // null for 'all' (and any period with nothing to compare against) — no prior-period row is fetched.
  prevStart: string | null; prevEnd: string | null;
}

// NOT d.toISOString().slice(0, 10) — that converts to UTC, but every Date
// above is built with the local-time constructor (new Date(y, m, 1)). On a
// server whose local timezone is ahead of UTC, the UTC conversion rolls the
// date back a day, so every range silently starts/ends a day early.
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Current period = the most recently COMPLETED month/quarter/year, unless a
 * specific quarter/year was requested (the reports page's quarter picker).
 */
export function computeRanges(period: PeriodType, opts: RangeOpts = {}, now = new Date()): Ranges {
  const y = now.getFullYear();
  const m = now.getMonth();

  if (period === 'all') {
    // Comparing "all time" against a prior period doesn't mean anything.
    return { label: 'All time', curStart: '1970-01-01', curEnd: ymd(new Date(y + 1, 0, 1)), prevStart: null, prevEnd: null };
  }

  if (period === 'monthly') {
    const curStart = new Date(y, m - 1, 1);
    const curEnd = new Date(y, m, 1);
    return {
      label: curStart.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      curStart: ymd(curStart), curEnd: ymd(curEnd),
      prevStart: ymd(new Date(y, m - 2, 1)), prevEnd: ymd(curStart),
    };
  }

  if (period === 'quarterly') {
    // dateYear/curQStartMonth are the raw inputs to `new Date(...)` — month
    // can be negative (Date normalizes that into the prior year), so dateYear
    // must stay the UNADJUSTED base year and never the already-rolled-back
    // label year, or Q1 selections/rollovers land a year off.
    let dateYear: number;
    let curQStartMonth: number;
    let qNum: number;
    let qYear: number;
    if (opts.quarter && opts.quarter >= 1 && opts.quarter <= 4 && opts.year) {
      dateYear = opts.year;
      curQStartMonth = (opts.quarter - 1) * 3;
      qNum = opts.quarter;
      qYear = opts.year;
    } else {
      const q = Math.floor(m / 3);          // 0..3 of the CURRENT quarter
      dateYear = y;
      curQStartMonth = (q - 1) * 3;          // previous (most recently completed) quarter
      qNum = q === 0 ? 4 : q;
      qYear = q === 0 ? y - 1 : y;
    }
    const curStart = new Date(dateYear, curQStartMonth, 1);
    const curEnd = new Date(dateYear, curQStartMonth + 3, 1);
    const prevStart = new Date(dateYear, curQStartMonth - 3, 1);
    return {
      label: `Q${qNum} ${qYear}`,
      curStart: ymd(curStart), curEnd: ymd(curEnd),
      prevStart: ymd(prevStart), prevEnd: ymd(curStart),
    };
  }

  // yearly: last complete year
  return {
    label: String(y - 1),
    curStart: ymd(new Date(y - 1, 0, 1)), curEnd: ymd(new Date(y, 0, 1)),
    prevStart: ymd(new Date(y - 2, 0, 1)), prevEnd: ymd(new Date(y - 1, 0, 1)),
  };
}

interface Row { vendor: string; category: string; amount: number }

async function fetchPeriod(userId: string, start: string, end: string): Promise<Row[]> {
  const { rows } = await pool.query<{ vendor: string; category: string | null; normalized_amount: string | null }>(
    `SELECT vendor, category, normalized_amount
     FROM invoices
     WHERE user_id = $1 AND invoice_date >= $2 AND invoice_date < $3`,
    [userId, start, end],
  );
  return rows.map((r) => ({
    vendor: r.vendor || 'Unknown',
    category: r.category || 'other',
    amount: Number(r.normalized_amount) || 0,
  }));
}

export interface ReportData {
  periodType: PeriodType;
  periodLabel: string;
  total: number;
  prevTotal: number;
  pctChange: number;
  // False for 'all' (nothing to compare against) — the UI/email should hide
  // the "vs prior" row rather than show a misleading 0%.
  hasPrior: boolean;
  count: number;
  topVendors: { name: string; amount: number }[];
  byCategory: { name: string; amount: number }[];
  baseCurrency: string;
}

export async function buildReport(userId: string, period: PeriodType, opts: RangeOpts = {}): Promise<ReportData> {
  const r = computeRanges(period, opts);
  const [current, prior] = await Promise.all([
    fetchPeriod(userId, r.curStart, r.curEnd),
    r.prevStart && r.prevEnd ? fetchPeriod(userId, r.prevStart, r.prevEnd) : Promise.resolve([]),
  ]);

  const sum = (a: Row[]) => a.reduce((t, x) => t + x.amount, 0);
  const total = sum(current);
  const prevTotal = sum(prior);
  const hasPrior = r.prevStart !== null;
  const pctChange = hasPrior && prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0;

  const agg = (a: Row[], key: 'vendor' | 'category') => {
    const m: Record<string, number> = {};
    for (const x of a) m[x[key]] = (m[x[key]] || 0) + x.amount;
    return Object.entries(m).sort((p, q) => q[1] - p[1]).map(([name, amount]) => ({ name, amount }));
  };

  return {
    periodType: period,
    periodLabel: r.label,
    total, prevTotal, pctChange, hasPrior, count: current.length,
    topVendors: agg(current, 'vendor').slice(0, 10),
    byCategory: agg(current, 'category'),
    baseCurrency: process.env.BASE_CURRENCY ?? 'USD',
  };
}

const fmt = (n: number, cur: string) =>
  `${cur === 'USD' ? '$' : ''}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur === 'USD' ? '' : ' ' + cur}`;

// Vendor/category names come from LLM extraction over attacker-sent invoice
// emails — treat them as untrusted and escape before interpolating into HTML.
const escHtml = (s: string) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** HTML email body — mirrors the workflow's styled report. */
export function reportHtml(d: ReportData): string {
  const cur = d.baseCurrency;
  const arrow = d.pctChange > 0 ? '▲' : d.pctChange < 0 ? '▼' : '▬';
  const cap = d.periodType.charAt(0).toUpperCase() + d.periodType.slice(1);
  const rows = (items: { name: string; amount: number }[]) =>
    items.map((v, i) =>
      `<tr style="background:${i % 2 ? '#f8f9fa' : '#fff'}"><td style="padding:8px;border-bottom:1px solid #eee">${escHtml(v.name)}</td><td style="padding:8px;text-align:right;border-bottom:1px solid #eee">${fmt(v.amount, cur)}</td></tr>`).join('');
  const priorRow = d.hasPrior
    ? `<tr><td style="padding:8px">vs Prior (${fmt(d.prevTotal, cur)})</td><td style="padding:8px;text-align:right;font-weight:bold;color:${d.pctChange > 0 ? '#e74c3c' : '#27ae60'}">${arrow} ${Math.abs(d.pctChange).toFixed(1)}%</td></tr>`
    : '';
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a1a">
<h1 style="color:#2c3e50;border-bottom:3px solid #3498db;padding-bottom:8px">${cap} Financial Report</h1>
<p style="font-size:18px;color:#555"><strong>Period:</strong> ${escHtml(d.periodLabel)}</p>
<div style="background:#f8f9fa;border-radius:8px;padding:20px;margin:16px 0"><table style="width:100%;border-collapse:collapse">
<tr><td style="padding:8px;font-size:16px">Total Spend</td><td style="padding:8px;text-align:right;font-size:22px;font-weight:bold;color:#2c3e50">${fmt(d.total, cur)}</td></tr>
<tr><td style="padding:8px">Invoice Count</td><td style="padding:8px;text-align:right;font-weight:bold">${d.count}</td></tr>
${priorRow}
</table></div>
<h2 style="color:#2c3e50">Top Vendors</h2><table style="width:100%;border-collapse:collapse"><tr style="background:#3498db;color:#fff"><th style="padding:8px;text-align:left">Vendor</th><th style="padding:8px;text-align:right">Amount</th></tr>${rows(d.topVendors)}</table>
<h2 style="color:#2c3e50;margin-top:24px">By Category</h2><table style="width:100%;border-collapse:collapse"><tr style="background:#3498db;color:#fff"><th style="padding:8px;text-align:left">Category</th><th style="padding:8px;text-align:right">Amount</th></tr>${rows(d.byCategory)}</table>
<p style="margin-top:24px;color:#999;font-size:12px">Generated by your Invoice Assistant on ${new Date().toLocaleDateString()}</p></div>`;
}
