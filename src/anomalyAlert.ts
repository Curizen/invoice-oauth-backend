import { listConnections } from './db.js';
import { logger } from './logger.js';
import { sendMailViaConnection } from './mailSend.js';

// Email the user when an invoice is flagged as an anomaly. Sent from the
// user's first active connected mailbox to itself (same self-send model as
// /reports/send). Fire-and-forget: never throws — a failed alert must not
// fail the invoice save.

const log = logger.child({ component: 'anomaly-alert' });

export interface AnomalyAlertDetails {
  vendor: string;
  amount: number;
  currency: string;
  typicalAmount: number;
  level: string;
  insight: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  onedriveUrl?: string | null;
  source: string;
}

const LEVEL_COLORS: Record<string, string> = { high: '#c0392b', medium: '#b26a00', low: '#7a6a00' };

function alertHtml(d: AnomalyAlertDetails): string {
  const color = LEVEL_COLORS[d.level] ?? '#b26a00';
  const fmt = (n: number) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#555">${label}</td><td style="padding:6px 0;font-weight:600">${value}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
<h2 style="color:${color}">⚠ Invoice anomaly flagged (${d.level})</h2>
<p style="font-size:15px;line-height:1.5">${d.insight}</p>
<table style="border-collapse:collapse;font-size:14px">
${row('Vendor', d.vendor)}
${row('Amount', `${fmt(d.amount)} ${d.currency}`)}
${d.typicalAmount > 0 ? row('Typical amount', `${fmt(d.typicalAmount)} ${d.currency}`) : ''}
${d.invoiceNumber ? row('Invoice #', d.invoiceNumber) : ''}
${d.invoiceDate ? row('Invoice date', d.invoiceDate) : ''}
${row('Source', d.source)}
</table>
${d.onedriveUrl ? `<p><a href="${d.onedriveUrl}" style="color:#2c6bd9">View the invoice in OneDrive</a></p>` : ''}
<p style="margin-top:20px;color:#999;font-size:12px">The invoice was still saved — review it in your dashboard. Sent by your Invoice Assistant.</p></div>`;
}

export async function sendAnomalyAlertEmail(userId: string, details: AnomalyAlertDetails): Promise<void> {
  try {
    const conns = await listConnections(userId);
    const conn = conns.find((c) => c.status === 'active');
    if (!conn) {
      log.warn({ userId }, 'anomaly alert skipped: no active connection to send from');
      return;
    }
    await sendMailViaConnection(conn.id, conn.provider, {
      to: conn.provider_email,
      subject: `⚠ Anomaly: ${details.vendor} invoice ${details.level === 'high' ? 'well ' : ''}outside its usual range`,
      html: alertHtml(details),
    });
    log.info({ userId, vendor: details.vendor, level: details.level }, 'anomaly alert email sent');
  } catch (err) {
    log.warn({ err, userId, vendor: details.vendor }, 'anomaly alert email failed');
  }
}
