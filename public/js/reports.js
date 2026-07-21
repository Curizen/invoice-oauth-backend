import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mountSidebar } from '/sidebar.js';
import { esc, clearSbCookie } from '/js/util.js';
const cfg = await fetch('/config').then((r) => r.json());
const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.href = '/login'; }

mountSidebar('reports', {
  email: session?.user?.email ?? '',
  onSignOut: async () => {
    await supabase.auth.signOut();
    clearSbCookie();
    window.location.href = '/login';
  },
  onChangePassword: async (password) => {
    const { error } = await supabase.auth.updateUser({ password });
    return error ? { ok: false, error: error.message } : { ok: true };
  },
});

async function authedFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  return fetch(path, { ...options, headers: { ...(options.headers ?? {}), Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' } });
}

const cardsEl = document.getElementById('cards');
const vendorsEl = document.getElementById('vendors');
const catsEl = document.getElementById('categories');
const labelEl = document.getElementById('period-label');
const acctEl = document.getElementById('acct');
const sendBtn = document.getElementById('send-btn');
const sendStatus = document.getElementById('send-status');
const quarterPicker = document.getElementById('quarter-picker');
const qQuarterEl = document.getElementById('q-quarter');
const qYearEl = document.getElementById('q-year');
let period = 'monthly';

// Quarter picker's year dropdown: this year back to 5 years ago.
const thisYear = new Date().getFullYear();
for (let y = thisYear; y >= thisYear - 5; y--) {
  const opt = document.createElement('option');
  opt.value = String(y);
  opt.textContent = String(y);
  qYearEl.appendChild(opt);
}
// Default to the most recently completed quarter, matching the tab's own default.
{
  const m = new Date().getMonth();
  const q = Math.floor(m / 3); // 0..3 of the CURRENT quarter
  const prevQ = q === 0 ? 4 : q;
  const prevQYear = q === 0 ? thisYear - 1 : thisYear;
  qQuarterEl.value = String(prevQ);
  qYearEl.value = String(prevQYear);
}

const money = (n, cur) => (cur === 'USD' ? '$' : '') + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (cur === 'USD' ? '' : ' ' + cur);

function rowsTable(items, cur) {
  if (!items.length) return '<p class="empty-row">No data for this period.</p>';
  // Vendor/category names come from LLM extraction over emailed invoices —
  // attacker-influenceable, so escape them.
  const body = items.map((v) => `<tr><td>${esc(v.name)}</td><td class="num">${money(v.amount, cur)}</td></tr>`).join('');
  return `<table class="data-table"><tr><th>Name</th><th class="num">Amount</th></tr>${body}</table>`;
}

function reportParams() {
  const params = new URLSearchParams({ period });
  if (period === 'quarterly') {
    params.set('quarter', qQuarterEl.value);
    params.set('year', qYearEl.value);
  }
  return params;
}

async function loadReport() {
  labelEl.textContent = 'Loading…';
  const res = await authedFetch(`/api/reports?${reportParams()}`);
  const d = await res.json();
  if (!res.ok) { labelEl.textContent = d.error || 'Failed to load.'; return; }
  labelEl.textContent = `Period: ${d.periodLabel}`;
  const dir = d.pctChange > 0 ? 'up' : d.pctChange < 0 ? 'down' : 'flat';
  const arrow = d.pctChange > 0 ? '▲' : d.pctChange < 0 ? '▼' : '▬';
  const priorCard = d.hasPrior
    ? `<div class="stat-card"><div class="label">vs prior (${money(d.prevTotal, d.baseCurrency)})</div><div class="value ${dir}">${arrow} ${Math.abs(d.pctChange).toFixed(1)}%</div></div>`
    : '';
  cardsEl.innerHTML = `
    <div class="stat-card"><div class="label">Total spend</div><div class="value">${money(d.total, d.baseCurrency)}</div></div>
    <div class="stat-card"><div class="label">Invoices</div><div class="value">${d.count}</div></div>
    ${priorCard}`;
  vendorsEl.innerHTML = rowsTable(d.topVendors, d.baseCurrency);
  catsEl.innerHTML = rowsTable(d.byCategory, d.baseCurrency);
}

async function loadAccounts() {
  const res = await authedFetch('/connections');
  const conns = await res.json();
  acctEl.innerHTML = '';
  for (const c of (Array.isArray(conns) ? conns : [])) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.email} (${c.provider})`;
    acctEl.appendChild(opt);
  }
  if (!acctEl.options.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No connected mailbox';
    opt.disabled = true; acctEl.appendChild(opt);
    sendBtn.disabled = true;
  }
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  period = btn.dataset.period;
  quarterPicker.style.display = period === 'quarterly' ? '' : 'none';
  loadReport();
});

qQuarterEl.addEventListener('change', loadReport);
qYearEl.addEventListener('change', loadReport);

sendBtn.addEventListener('click', async () => {
  const connectionId = acctEl.value;
  if (!connectionId) return;
  sendBtn.disabled = true; sendStatus.textContent = 'Sending…'; sendStatus.style.color = '';
  const body = { period, connectionId };
  if (period === 'quarterly') { body.quarter = Number(qQuarterEl.value); body.year = Number(qYearEl.value); }
  const res = await authedFetch('/api/reports/send', { method: 'POST', body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  sendBtn.disabled = false;
  if (res.ok) { sendStatus.textContent = `Sent to ${d.sentTo} ✓`; }
  else { sendStatus.style.color = '#b3261e'; sendStatus.textContent = d.error || 'Send failed.'; }
});

await Promise.all([loadReport(), loadAccounts()]);
