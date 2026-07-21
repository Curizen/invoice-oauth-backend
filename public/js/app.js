import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mountSidebar } from '/sidebar.js';
import { esc, setSbCookie, clearSbCookie } from '/js/util.js';

const cfg = await fetch('/config').then((r) => r.json());
const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

const onboarding = document.getElementById('onboarding');
const dashboard = document.getElementById('dashboard');
const list = document.getElementById('list');
const output = document.getElementById('output');
const storageBox = document.getElementById('storage');
const storageSelect = document.getElementById('storage-select');
const storageSave = document.getElementById('storage-save');
const storageStatus = document.getElementById('storage-status');
const storageHint = document.getElementById('storage-hint');
const uploadBox = document.getElementById('uploadBox');
const uploadInput = document.getElementById('upload-input');
const uploadBtn = document.getElementById('upload-btn');
const uploadStatus = document.getElementById('upload-status');
const uploadWarning = document.getElementById('upload-warning');
const anomalyBox = document.getElementById('anomalyBox');
const anomalyList = document.getElementById('anomaly-list');
const cameraBtn = document.getElementById('camera-btn');
const cameraModal = document.getElementById('camera-modal');
const cameraVideo = document.getElementById('camera-video');
const cameraCanvas = document.getElementById('camera-canvas');
const cameraCapture = document.getElementById('camera-capture');
const cameraUse = document.getElementById('camera-use');
const cameraRetake = document.getElementById('camera-retake');
const cameraCancel = document.getElementById('camera-cancel');

function badgeClass(status) {
  if (status === 'active') return 'active';
  if (status === 'reauth_required') return 'reauth_required';
  return 'other';
}

async function authedFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  return fetch(path, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${session.access_token}`,
    },
  });
}

async function loadConnections() {
  const res = await authedFetch('/connections');
  const conns = await res.json();

  // Zero connections -> onboarding; otherwise the normal dashboard.
  if (!Array.isArray(conns) || conns.length === 0) {
    onboarding.style.display = '';
    dashboard.style.display = 'none';
    return;
  }

  onboarding.style.display = 'none';
  dashboard.style.display = '';
  uploadBox.style.display = '';
  loadAnomalies();
  await loadStorage(conns);
  list.innerHTML = '';
  for (const c of conns) {
    const row = document.createElement('div');
    row.className = 'conn';
    row.innerHTML = `
      <div class="conn-info">
        <span class="conn-provider">${esc(c.provider)}</span>
        <span class="conn-email">${esc(c.email ?? '')}</span>
        <span class="badge ${badgeClass(c.status)}">${esc(c.status)}</span>
      </div>
      <div class="conn-buttons">
        <button class="btn secondary test-btn">Test</button>
        <button class="btn secondary danger disconnect-btn">Disconnect</button>
      </div>
    `;
    row.querySelector('.test-btn').addEventListener('click', () => testConnection(c.id));
    row.querySelector('.disconnect-btn').addEventListener('click', () => disconnectConnection(c.id));
    list.appendChild(row);
  }
}

// Invoice storage: every invoice is filed into one OneDrive the user picks.
// Only Microsoft accounts have a OneDrive we can write to.
async function loadStorage(conns) {
  storageBox.style.display = '';
  storageStatus.textContent = '';
  const msAccounts = conns.filter((c) => c.provider === 'microsoft');

  if (msAccounts.length === 0) {
    storageSelect.style.display = 'none';
    storageSave.style.display = 'none';
    storageHint.textContent =
      'Connect an Outlook / Microsoft account to enable invoice filing — invoices are stored in OneDrive.';
    return;
  }

  const current = await authedFetch('/settings/invoice-store')
    .then((r) => r.json())
    .then((d) => d.connectionId)
    .catch(() => null);
  savedStorageId = current;

  storageSelect.style.display = '';
  storageSave.style.display = '';
  storageSelect.innerHTML = '<option value="">— choose a OneDrive —</option>';
  for (const c of msAccounts) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.email ?? c.id;
    if (c.id === current) opt.selected = true;
    storageSelect.appendChild(opt);
  }
  reflectStorageState();
}

// Reflect whether the current selection matches what's saved on the server.
let savedStorageId = null;
function reflectStorageState() {
  const selected = storageSelect.value;
  const isSaved = selected && selected === savedStorageId;
  // Disable Save when nothing chosen, or the choice is already saved.
  storageSave.disabled = !selected || isSaved;
  if (isSaved) {
    storageStatus.textContent = 'Saved ✓';
    storageHint.textContent = 'All invoices from every connected mailbox are filed here.';
  } else {
    storageStatus.textContent = selected ? 'Unsaved changes' : '';
    storageHint.textContent = savedStorageId
      ? 'All invoices from every connected mailbox are filed here.'
      : 'Pick where invoices should be filed — until you do, nothing is saved.';
  }
}

async function saveStorage() {
  const connectionId = storageSelect.value;
  if (!connectionId) return;
  storageSave.disabled = true;
  storageStatus.textContent = 'Saving…';
  const res = await authedFetch('/settings/invoice-store', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId }),
  });
  if (res.ok) {
    savedStorageId = connectionId;
    reflectStorageState();
  } else {
    const err = await res.json().catch(() => ({}));
    storageStatus.textContent = err.error ?? 'Could not save';
    storageSave.disabled = false;
  }
}
storageSelect.addEventListener('change', reflectStorageState);
storageSave.addEventListener('click', saveStorage);

// Manual invoice upload: read file -> base64 -> POST /upload-invoice.
function fileToBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}
// Recent anomalies panel: hidden until there is at least one flagged invoice.
async function loadAnomalies() {
  try {
    const res = await authedFetch('/api/anomalies');
    const rows = await res.json();
    if (!res.ok || !Array.isArray(rows) || rows.length === 0) return;
    anomalyList.innerHTML = '';
    for (const a of rows) {
      const row = document.createElement('div');
      row.className = 'anomaly-row';
      const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const level = String(a.anomaly_level || 'medium');
      const when = a.checked_at ? new Date(a.checked_at).toLocaleDateString() : (a.invoice_date ?? '');
      row.innerHTML = `
        <span class="sev"></span>
        <strong></strong>
        <span></span>
        <span class="when"></span>
        <span class="insight"></span>`;
      const [sev, vendor, amount, whenEl, insight] = row.children;
      sev.classList.add(level);
      sev.textContent = level;
      vendor.textContent = a.vendor;
      amount.textContent = `${money(a.new_amount)} ${a.base_currency ?? ''}` +
        (Number(a.typical_amount) > 0 ? ` (typical ${money(a.typical_amount)})` : '');
      whenEl.textContent = when;
      insight.textContent = a.insight ?? '';
      anomalyList.appendChild(row);
    }
    anomalyBox.style.display = '';
  } catch { /* panel is optional; leave hidden on failure */ }
}

async function uploadFile(blob, filename, contentType) {
  uploadBtn.disabled = true;
  cameraBtn.disabled = true;
  uploadStatus.textContent = 'Uploading & extracting…';
  uploadWarning.style.display = 'none';
  uploadWarning.textContent = '';
  try {
    const dataBase64 = await fileToBase64(blob);
    const res = await authedFetch('/upload-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, contentType, dataBase64 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      uploadStatus.textContent = data.error || 'Upload failed.';
    } else if (data.status === 'duplicate') {
      uploadStatus.textContent = `Already have this one: ${data.vendor} (duplicate, not saved).`;
    } else {
      uploadStatus.textContent = `✓ Saved: ${data.vendor} — ${data.amount} ${data.currency}`;
      uploadInput.value = '';
      if (data.anomaly) {
        uploadWarning.textContent = `⚠ Anomaly (${data.anomaly.level}): ${data.anomaly.insight}`;
        uploadWarning.style.display = '';
        loadAnomalies();
      }
    }
  } catch (err) {
    uploadStatus.textContent = 'Upload error — please try again.';
  } finally {
    uploadBtn.disabled = false;
    cameraBtn.disabled = false;
  }
}
uploadBtn.addEventListener('click', async () => {
  const file = uploadInput.files && uploadInput.files[0];
  if (!file) { uploadStatus.textContent = 'Choose a file first.'; return; }
  await uploadFile(file, file.name, file.type);
});

// Camera capture: live preview -> snap a frame -> same /upload-invoice flow.
let cameraStream = null;
function closeCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach((t) => t.stop()); cameraStream = null; }
  cameraVideo.srcObject = null;
  cameraModal.style.display = 'none';
}
function showLivePreview() {
  cameraVideo.style.display = '';
  cameraCanvas.style.display = 'none';
  cameraCapture.style.display = '';
  cameraUse.style.display = 'none';
  cameraRetake.style.display = 'none';
}
cameraBtn.addEventListener('click', async () => {
  uploadStatus.textContent = '';
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 } },
    });
  } catch (err) {
    uploadStatus.textContent = 'Camera unavailable — check permissions or use the file picker.';
    return;
  }
  cameraVideo.srcObject = cameraStream;
  showLivePreview();
  cameraModal.style.display = 'flex';
});
cameraCapture.addEventListener('click', () => {
  cameraCanvas.width = cameraVideo.videoWidth;
  cameraCanvas.height = cameraVideo.videoHeight;
  cameraCanvas.getContext('2d').drawImage(cameraVideo, 0, 0);
  cameraVideo.style.display = 'none';
  cameraCanvas.style.display = '';
  cameraCapture.style.display = 'none';
  cameraUse.style.display = '';
  cameraRetake.style.display = '';
});
cameraRetake.addEventListener('click', showLivePreview);
cameraCancel.addEventListener('click', closeCamera);
cameraUse.addEventListener('click', () => {
  cameraCanvas.toBlob(async (blob) => {
    closeCamera();
    if (!blob) { uploadStatus.textContent = 'Could not capture photo — please try again.'; return; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await uploadFile(blob, `receipt-${stamp}.jpg`, 'image/jpeg');
  }, 'image/jpeg', 0.92);
});

async function testConnection(id) {
  output.style.display = 'block';
  output.textContent = 'Loading…';
  const res = await authedFetch(`/test/${id}`);
  const data = await res.json();
  output.textContent = JSON.stringify(data, null, 2);
}

async function disconnectConnection(id) {
  await authedFetch(`/connections/${id}`, { method: 'DELETE' });
  await loadConnections();
}

const { data: { session } } = await supabase.auth.getSession();
if (!session) {
  window.location.href = '/login';
} else {
  // Cookie must be set before any /connect/* link is clickable — the
  // browser-redirect OAuth routes authenticate via this cookie.
  setSbCookie(session.access_token);

  mountSidebar('dashboard', {
    email: session.user?.email ?? '',
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

  supabase.auth.onAuthStateChange((_event, newSession) => {
    if (newSession) {
      setSbCookie(newSession.access_token);
    } else {
      clearSbCookie();
      window.location.href = '/login';
    }
  });

  // Connect buttons (both onboarding and dashboard) navigate to /connect/*.
  for (const btn of document.querySelectorAll('.connect-btn')) {
    btn.addEventListener('click', () => {
      window.location.href = '/connect/' + btn.dataset.provider;
    });
  }

  await loadConnections();
}
