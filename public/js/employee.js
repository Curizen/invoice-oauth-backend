import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mountSidebar } from '/sidebar.js';
import { esc, clearSbCookie } from '/js/util.js';
const cfg = await fetch('/config').then((r) => r.json());
const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.href = '/login'; }

mountSidebar('employees', {
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

const employeeId = new URLSearchParams(window.location.search).get('id');
if (!employeeId) { window.location.href = '/employees'; }

async function authedFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  return fetch(path, {
    ...options,
    headers: { ...(options.headers ?? {}), Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
  });
}

const $ = (id) => document.getElementById(id);
function fmtDate(d) { return d ? String(d).slice(0, 10) : '—'; }
function showMsg(el, msg) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }

let employee = null;

function renderEntriesTable(container, entries, cols, onDelete) {
  container.innerHTML = '';
  if (!entries.length) { container.innerHTML = '<p class="empty-row">No entries yet.</p>'; return; }
  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr>${cols.map((c) => `<th>${c.label}</th>`).join('')}<th></th></tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const entry of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.render(entry)}</td>`).join('') + '<td class="row-actions"></td>';
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', () => onDelete(entry.id));
    tr.querySelector('.row-actions').appendChild(del);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderContract(data) {
  const e = data.employee;
  $('c-start').textContent = fmtDate(e.contract_start);
  $('c-end').textContent = e.contract_type === 'indefinite' ? '∞ Indefinite' : fmtDate(e.contract_end);
  $('c-probation').textContent = fmtDate(e.probation_end);
  $('c-notice').textContent = e.notice_period ?? '—';
  const badge = $('c-badge');
  if (e.contract_type === 'indefinite') {
    badge.innerHTML = '<span class="badge green">indefinite-term</span>';
  } else if (e.contract_end == null) {
    badge.innerHTML = '<span class="muted-text">—</span>';
  } else if (data.contract_days_left < 0) {
    badge.innerHTML = '<span class="badge red">expired</span>';
  } else if (data.contract_days_left <= 60) {
    badge.innerHTML = `<span class="badge amber">expires in ${data.contract_days_left} days</span>`;
  } else {
    badge.innerHTML = `<span class="badge green">${data.contract_days_left} days left</span>`;
  }
  if (data.contract) {
    $('c-file').textContent = `${data.contract.filename} — uploaded ${fmtDate(data.contract.uploaded_at)}`;
    const dl = $('c-download');
    dl.style.display = '';
    dl.onclick = async (ev) => {
      ev.preventDefault();
      // fetch with the auth header, then hand the blob to the browser.
      const res = await authedFetch(`/employees/${employeeId}/contract`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = data.contract.filename;
      a.click();
      URL.revokeObjectURL(url);
    };
  }
}

function renderVacationAndSick(data) {
  const e = data.employee;
  const vac = data.leaves.filter((l) => l.kind === 'vacation');
  const sick = data.leaves.filter((l) => l.kind === 'sick');
  const sum = (list) => list.reduce((t, l) => t + Number(l.days), 0);

  $('v-allowed').textContent = e.vacation_days_allowed;
  $('v-taken').textContent = sum(vac);
  $('v-remaining').textContent = e.vacation_days_allowed - sum(vac);
  $('s-allowed').textContent = e.sick_days_allowed;
  $('s-taken').textContent = sum(sick);
  $('s-remaining').textContent = e.sick_days_allowed - sum(sick);

  const cols = [
    { label: 'Date', render: (l) => fmtDate(l.on_date) },
    { label: 'Days', num: true, render: (l) => Number(l.days) },
    { label: 'Note', render: (l) => esc(l.note ?? '') },
  ];
  renderEntriesTable($('v-list'), vac, cols, deleteLeave);
  renderEntriesTable($('s-list'), sick, cols, deleteLeave);
}

function renderBonuses(data) {
  const year = new Date().getFullYear();
  const total = data.bonuses
    .filter((b) => String(b.on_date).slice(0, 4) === String(year))
    .reduce((t, b) => t + Number(b.amount), 0);
  $('b-total').innerHTML = `<strong>${total.toFixed(2)} ${esc(data.employee.salary_currency)}</strong> in bonuses this year (${year})`;
  renderEntriesTable($('b-list'), data.bonuses, [
    { label: 'Date', render: (b) => fmtDate(b.on_date) },
    { label: 'Amount', num: true, render: (b) => `${Number(b.amount).toFixed(2)} ${esc(data.employee.salary_currency)}` },
    { label: 'Note', render: (b) => esc(b.note ?? '') },
  ], deleteBonus);
}

function renderSalary(data) {
  const e = data.employee;
  $('p-current').textContent = `${Number(e.salary).toFixed(2)} ${e.salary_currency}`;
  const listEl = $('p-list');
  listEl.innerHTML = '';
  if (!data.salary_history.length) { listEl.innerHTML = '<p class="empty-row">No changes recorded yet.</p>'; return; }
  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr><th>Date</th><th>Change</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const h of data.salary_history) {
    const from = h.old_amount == null ? 'initial' : `${Number(h.old_amount).toFixed(2)}`;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(h.changed_on)}</td><td class="num">${from} → ${Number(h.new_amount).toFixed(2)} ${esc(h.currency)}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  listEl.appendChild(table);
}

async function load() {
  const res = await authedFetch(`/employees/${employeeId}`);
  if (!res.ok) { window.location.href = '/employees'; return; }
  const data = await res.json();
  employee = data.employee;
  $('title').textContent = `${employee.name}${employee.role ? ' — ' + employee.role : ''}`;
  renderContract(data);
  renderVacationAndSick(data);
  renderBonuses(data);
  renderSalary(data);
}

// ── Contract upload + review ─────────────────────────────────────────────
$('c-upload').addEventListener('click', async () => {
  showMsg($('c-err'), ''); showMsg($('c-ok'), '');
  const file = $('c-input').files?.[0];
  if (!file) { showMsg($('c-err'), 'Choose a PDF first.'); return; }
  $('c-upload').disabled = true;
  $('c-upload').textContent = 'Uploading & extracting…';
  try {
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const res = await authedFetch(`/employees/${employeeId}/contract`, {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/pdf', dataBase64 }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { showMsg($('c-err'), d.error || 'Upload failed.'); return; }
    showMsg($('c-ok'), 'Contract uploaded.');
    if (d.extracted) {
      showReview(d.extracted);
    } else if (d.extractError) {
      showMsg($('c-err'), d.extractError);
    }
    await load();
  } finally {
    $('c-upload').disabled = false;
    $('c-upload').textContent = 'Upload contract (PDF)';
  }
});

function showReview(x) {
  $('r-name').value = x.employee_name ?? employee.name;
  $('r-role').value = x.role ?? employee.role ?? '';
  $('r-salary').value = x.salary_amount ?? '';
  $('r-currency').value = x.salary_currency ?? employee.salary_currency ?? 'USD';
  $('r-notice').value = x.notice_period ?? '';
  $('r-start').value = x.start_date ?? '';
  $('r-end').value = x.end_date ?? '';
  // No end date found in the contract → suggest indefinite-term.
  $('r-indef').checked = !x.end_date;
  $('r-end').disabled = !x.end_date;
  $('r-probation').value = x.probation_end ?? '';
  $('r-vacation').value = x.vacation_days ?? '';
  $('r-sick').value = x.sick_days ?? '';
  $('review').style.display = '';
  $('review').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('r-cancel').addEventListener('click', () => { $('review').style.display = 'none'; });

$('r-indef').addEventListener('change', () => {
  $('r-end').disabled = $('r-indef').checked;
  if ($('r-indef').checked) $('r-end').value = '';
});

$('r-confirm').addEventListener('click', async () => {
  showMsg($('r-err'), '');
  $('r-confirm').disabled = true;
  const body = {
    name: $('r-name').value.trim() || employee.name,
    role: $('r-role').value.trim() || null,
    salary_currency: $('r-currency').value.trim() || 'USD',
    notice_period: $('r-notice').value.trim() || null,
    contract_start: $('r-start').value || null,
    contract_end: $('r-indef').checked ? null : $('r-end').value || null,
    contract_type: $('r-indef').checked ? 'indefinite' : 'fixed',
    probation_end: $('r-probation').value || null,
    vacation_days_allowed: Number($('r-vacation').value || 0),
    sick_days_allowed: Number($('r-sick').value || 0),
  };
  if ($('r-salary').value !== '') body.salary = Number($('r-salary').value);
  const res = await authedFetch(`/employees/${employeeId}`, { method: 'PATCH', body: JSON.stringify(body) });
  $('r-confirm').disabled = false;
  if (!res.ok) { const d = await res.json().catch(() => ({})); showMsg($('r-err'), d.error || 'Failed to save.'); return; }
  $('review').style.display = 'none';
  await load();
});

// ── Leaves ───────────────────────────────────────────────────────────────
async function addLeave(kind, dateEl, daysEl, errEl) {
  showMsg(errEl, '');
  const days = Number(daysEl.value);
  if (!days || days <= 0) { showMsg(errEl, 'Enter the number of days.'); return; }
  const res = await authedFetch(`/employees/${employeeId}/leaves`, {
    method: 'POST',
    body: JSON.stringify({ kind, on_date: dateEl.value || null, days }),
  });
  if (!res.ok) { const d = await res.json().catch(() => ({})); showMsg(errEl, d.error || 'Failed to add.'); return; }
  dateEl.value = ''; daysEl.value = '';
  await load();
}
async function deleteLeave(id) {
  await authedFetch(`/employees/${employeeId}/leaves/${id}`, { method: 'DELETE' });
  await load();
}
$('v-add').addEventListener('click', () => addLeave('vacation', $('v-date'), $('v-days'), $('v-err')));
$('s-add').addEventListener('click', () => addLeave('sick', $('s-date'), $('s-days'), $('s-err')));

// ── Bonuses ──────────────────────────────────────────────────────────────
$('b-add').addEventListener('click', async () => {
  showMsg($('b-err'), '');
  const amount = Number($('b-amount').value);
  if (!Number.isFinite(amount) || amount <= 0) { showMsg($('b-err'), 'Enter a bonus amount.'); return; }
  const res = await authedFetch(`/employees/${employeeId}/bonuses`, {
    method: 'POST',
    body: JSON.stringify({ on_date: $('b-date').value || null, amount, note: $('b-note').value.trim() || null }),
  });
  if (!res.ok) { const d = await res.json().catch(() => ({})); showMsg($('b-err'), d.error || 'Failed to add.'); return; }
  $('b-date').value = ''; $('b-amount').value = ''; $('b-note').value = '';
  await load();
});
async function deleteBonus(id) {
  await authedFetch(`/employees/${employeeId}/bonuses/${id}`, { method: 'DELETE' });
  await load();
}

// ── Salary ───────────────────────────────────────────────────────────────
$('p-save').addEventListener('click', async () => {
  showMsg($('p-err'), '');
  const salary = Number($('p-new').value);
  if (!Number.isFinite(salary) || salary < 0) { showMsg($('p-err'), 'Enter a valid salary.'); return; }
  const res = await authedFetch(`/employees/${employeeId}`, { method: 'PATCH', body: JSON.stringify({ salary }) });
  if (!res.ok) { const d = await res.json().catch(() => ({})); showMsg($('p-err'), d.error || 'Failed to update.'); return; }
  $('p-new').value = '';
  await load();
});

await load();
