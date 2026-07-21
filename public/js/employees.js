import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mountSidebar } from '/sidebar.js';
import { esc, clearSbCookie } from '/js/util.js';
const cfg = await fetch('/config').then((r) => r.json());
const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.href = '/login.html'; }

mountSidebar('employees', {
  email: session?.user?.email ?? '',
  onSignOut: async () => {
    await supabase.auth.signOut();
    clearSbCookie();
    window.location.href = '/login.html';
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

const nameEl = document.getElementById('e-name');
const roleEl = document.getElementById('e-role');
const salaryEl = document.getElementById('e-salary');
const currencyEl = document.getElementById('e-currency');
const startEl = document.getElementById('e-start');
const endEl = document.getElementById('e-end');
const indefEl = document.getElementById('e-indef');
indefEl.addEventListener('change', () => {
  endEl.disabled = indefEl.checked;
  if (indefEl.checked) endEl.value = '';
});
const addBtn = document.getElementById('e-add');
const errEl = document.getElementById('e-err');
const listEl = document.getElementById('e-list');
const alertsEl = document.getElementById('alerts');

function showErr(msg) { errEl.textContent = msg; errEl.style.display = msg ? 'block' : 'none'; }
function fmtDate(d) { return d ? String(d).slice(0, 10) : '—'; }

async function loadAlerts() {
  const res = await authedFetch('/employees/alerts');
  if (!res.ok) return;
  const alerts = await res.json();
  alertsEl.innerHTML = '';
  for (const a of alerts) {
    const div = document.createElement('div');
    const cls = a.type === 'contract_expired' ? 'danger' : a.type === 'no_contract' ? 'info' : 'warn';
    div.className = `alert-item ${cls}`;
    div.textContent = a.message;
    div.addEventListener('click', () => { window.location.href = `/employee.html?id=${a.employee_id}`; });
    alertsEl.appendChild(div);
  }
}

function contractBadge(e) {
  if (!e.contract_end) return '';
  if (e.contract_days_left < 0) return '<span class="badge red">expired</span>';
  if (e.contract_expiring) return `<span class="badge amber">${e.contract_days_left}d left</span>`;
  return '';
}

async function load() {
  const res = await authedFetch('/employees');
  const employees = await res.json();
  listEl.innerHTML = '';
  if (!Array.isArray(employees) || employees.length === 0) {
    listEl.innerHTML = '<p class="empty-row">No employees yet — add one above.</p>';
    return;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr><th>Name</th><th>Role</th><th>Salary</th><th>Contract</th><th>Status</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const e of employees) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(e.name)}</td>
      <td>${esc(e.role ?? '—')}</td>
      <td class="num">${Number(e.salary).toFixed(2)} ${esc(e.salary_currency)}</td>
      <td>${fmtDate(e.contract_start)} → ${e.contract_type === 'indefinite' ? '∞ Indefinite' : fmtDate(e.contract_end)} ${contractBadge(e)}</td>
      <td><span class="badge ${e.status === 'active' ? 'active' : 'inactive'}">${esc(e.status)}</span></td>`;
    tr.addEventListener('click', () => { window.location.href = `/employee.html?id=${e.id}`; });
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
  const res = await authedFetch('/employees', {
    method: 'POST',
    body: JSON.stringify({
      name,
      role: roleEl.value.trim() || null,
      salary: Number(salaryEl.value || 0),
      salary_currency: currencyEl.value || 'USD',
      contract_start: startEl.value || null,
      contract_end: indefEl.checked ? null : endEl.value || null,
      contract_type: indefEl.checked ? 'indefinite' : 'fixed',
    }),
  });
  addBtn.disabled = false;
  if (!res.ok) { const d = await res.json().catch(() => ({})); showErr(d.error || 'Failed to add.'); return; }
  nameEl.value = ''; roleEl.value = ''; salaryEl.value = ''; startEl.value = ''; endEl.value = '';
  indefEl.checked = false; endEl.disabled = false;
  await Promise.all([load(), loadAlerts()]);
}

// Upload a contract PDF → AI extracts the fields → employee is created
// automatically, then we jump to their page for review.
const fileEl = document.getElementById('c-file');
const uploadBtn = document.getElementById('c-upload');
const statusEl = document.getElementById('c-status');
const cErrEl = document.getElementById('c-err');
function showUploadErr(msg) { cErrEl.textContent = msg; cErrEl.style.display = msg ? 'block' : 'none'; }

uploadBtn.addEventListener('click', () => fileEl.click());
fileEl.addEventListener('change', async () => {
  const file = fileEl.files[0];
  fileEl.value = '';
  if (!file) return;
  showUploadErr('');
  if (!/pdf$/i.test(file.type || '') && !/\.pdf$/i.test(file.name)) {
    showUploadErr('Only PDF contracts are supported.');
    return;
  }
  uploadBtn.disabled = true;
  statusEl.textContent = 'Extracting contract fields…';
  try {
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const res = await authedFetch('/employees/from-contract', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/pdf', dataBase64 }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      statusEl.textContent = '';
      showUploadErr(d.error || 'Failed to create the employee from the contract.');
      return;
    }
    statusEl.textContent = `Created ${d.employee.name} — opening…`;
    window.location.href = `/employee.html?id=${d.employee.id}`;
  } catch {
    statusEl.textContent = '';
    showUploadErr('Upload failed — please try again.');
  } finally {
    uploadBtn.disabled = false;
  }
});

addBtn.addEventListener('click', add);
nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
await Promise.all([load(), loadAlerts()]);
