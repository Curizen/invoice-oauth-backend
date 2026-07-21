import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mountSidebar } from '/sidebar.js';
import { esc, clearSbCookie } from '/js/util.js';
const cfg = await fetch('/config').then((r) => r.json());
const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.href = '/login'; }

mountSidebar('subscriptions', {
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
  return fetch(path, {
    ...options,
    headers: { ...(options.headers ?? {}), Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
  });
}

const nameEl = document.getElementById('s-name');
const amountEl = document.getElementById('s-amount');
const currencyEl = document.getElementById('s-currency');
const dateEl = document.getElementById('s-date');
const addBtn = document.getElementById('s-add');
const errEl = document.getElementById('s-err');
const listEl = document.getElementById('s-list');
const summaryEl = document.getElementById('s-summary');

function showErr(msg) { errEl.textContent = msg; errEl.style.display = msg ? 'block' : 'none'; }
function fmtDate(d) { return d ? String(d).slice(0, 10) : ''; }
// Status doubles as a CSS class — whitelist it so a stored value can never
// smuggle extra classes (or break out of the attribute).
function badgeClass(status) { return status === 'active' ? 'active' : 'cancelled'; }

async function load() {
  const res = await authedFetch('/subscriptions');
  const subs = await res.json();
  listEl.innerHTML = '';
  if (!Array.isArray(subs) || subs.length === 0) {
    listEl.innerHTML = '<p class="empty-row">No subscriptions yet — add one above.</p>';
    summaryEl.textContent = '';
    return;
  }
  // Summarize active spend by currency.
  const totals = {};
  for (const s of subs) if (s.status === 'active') totals[s.currency] = (totals[s.currency] || 0) + Number(s.amount);
  const parts = Object.entries(totals).map(([c, v]) => `${v.toFixed(2)} ${esc(c)}`);
  const activeCount = subs.filter((s) => s.status === 'active').length;
  summaryEl.innerHTML = `<strong>${activeCount}</strong> active${parts.length ? ` · <strong>${parts.join(' + ')}</strong> recurring` : ''}`;

  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr><th>Name</th><th>Value</th><th>Start date</th><th>Status</th><th></th></tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const s of subs) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(s.name)}</td>
      <td class="num">${Number(s.amount).toFixed(2)} ${esc(s.currency)}</td>
      <td>${fmtDate(s.started_on)}</td>
      <td><span class="badge ${badgeClass(s.status)}">${esc(s.status)}</span></td>
      <td class="row-actions"></td>`;
    const actions = tr.querySelector('.row-actions');
    const toggle = document.createElement('button');
    toggle.textContent = s.status === 'active' ? 'Cancel' : 'Reactivate';
    toggle.addEventListener('click', () => setStatus(s.id, s.status === 'active' ? 'cancelled' : 'active'));
    const del = document.createElement('button');
    del.textContent = 'Delete'; del.className = 'del';
    del.addEventListener('click', () => remove(s.id));
    actions.append(toggle, del);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  listEl.appendChild(table);
}

async function add() {
  showErr('');
  const name = nameEl.value.trim();
  if (!name) { showErr('Name is required.'); return; }
  addBtn.disabled = true;
  const res = await authedFetch('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ name, amount: Number(amountEl.value || 0), currency: currencyEl.value || 'USD', started_on: dateEl.value || null }),
  });
  addBtn.disabled = false;
  if (!res.ok) { const d = await res.json().catch(() => ({})); showErr(d.error || 'Failed to add.'); return; }
  nameEl.value = ''; amountEl.value = ''; dateEl.value = '';
  await load();
}

async function setStatus(id, status) {
  await authedFetch(`/subscriptions/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  await load();
}
async function remove(id) {
  await authedFetch(`/subscriptions/${id}`, { method: 'DELETE' });
  await load();
}

addBtn.addEventListener('click', add);
nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
await load();
