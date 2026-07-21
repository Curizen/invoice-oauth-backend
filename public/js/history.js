import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mountSidebar } from '/sidebar.js';
import { esc, clearSbCookie } from '/js/util.js';
const cfg = await fetch('/config').then((r) => r.json());
const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.href = '/login'; }

mountSidebar('history', {
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
  return fetch(path, { ...options, headers: { ...(options.headers ?? {}), Authorization: `Bearer ${session.access_token}` } });
}

const sourceEl = document.getElementById('h-source');
const searchEl = document.getElementById('h-search');
const listEl = document.getElementById('h-list');
const countEl = document.getElementById('h-count');
const moreBtn = document.getElementById('h-more');

const SOURCE_LABEL = { email: 'Email', voice: 'Invoice chat', upload: 'Upload / camera', backfill: 'Backfill (n8n)' };

let rows = [];
let offset = 0;
let total = 0;
let searchTimer = null;

const money = (n, cur) => (cur === 'USD' ? '$' : '') + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (cur === 'USD' ? '' : ' ' + cur);

function render() {
  countEl.textContent = total === 0 ? 'No invoices logged yet.' : `Showing ${rows.length} of ${total}`;
  if (!rows.length) { listEl.innerHTML = ''; moreBtn.style.display = 'none'; return; }

  const body = rows.map((r) => {
    const source = r.source || 'upload';
    const badge = `<span class="badge ${esc(source)}">${esc(SOURCE_LABEL[source] || source)}</span>`;
    const link = r.onedrive_url
      ? `<a class="file-link" href="${esc(r.onedrive_url)}" target="_blank" rel="noopener">Open file</a>`
      : '';
    const anomaly = r.anomaly_level ? `<span class="badge red" style="margin-left:6px">${esc(r.anomaly_level)}</span>` : '';
    return `<tr>
      <td>${esc(r.invoice_date ?? '—')}</td>
      <td>${esc(r.vendor ?? 'Unknown')}${anomaly}</td>
      <td>${esc(r.invoice_number ?? '—')}</td>
      <td class="num">${money(r.normalized_amount ?? 0, r.base_currency ?? 'USD')}</td>
      <td>${esc(r.category ?? 'other')}</td>
      <td>${badge}</td>
      <td>${link}</td>
    </tr>`;
  }).join('');

  listEl.innerHTML = `<table class="data-table">
    <tr><th>Date</th><th>Vendor</th><th>Invoice #</th><th class="num">Amount</th><th>Category</th><th>Source</th><th></th></tr>
    ${body}
  </table>`;
  moreBtn.style.display = rows.length < total ? '' : 'none';
}

async function load(reset) {
  if (reset) { offset = 0; rows = []; }
  const params = new URLSearchParams({ offset: String(offset) });
  if (sourceEl.value) params.set('source', sourceEl.value);
  if (searchEl.value.trim()) params.set('search', searchEl.value.trim());

  countEl.textContent = 'Loading…';
  const res = await authedFetch(`/api/invoices/history?${params}`);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { countEl.textContent = d.error || 'Failed to load.'; return; }

  rows = reset ? d.rows : rows.concat(d.rows);
  total = d.total;
  offset = rows.length;
  render();
}

sourceEl.addEventListener('change', () => load(true));
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => load(true), 300);
});
moreBtn.addEventListener('click', () => load(false));

await load(true);
