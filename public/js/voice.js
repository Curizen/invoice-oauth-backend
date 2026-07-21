import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mountSidebar } from '/sidebar.js';
import { clearSbCookie } from '/js/util.js';

const cfg = await fetch('/config').then((r) => r.json());
const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.href = '/login'; }

mountSidebar('voice', {
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

// Stable per-conversation id so the assistant keeps context across turns.
const sessionId = sessionStorage.getItem('voiceSession')
  ?? (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
sessionStorage.setItem('voiceSession', sessionId);

const chat = document.getElementById('chat');
const textInput = document.getElementById('text');
const sendBtn = document.getElementById('send');
const micBtn = document.getElementById('mic');
const cameraBtn = document.getElementById('camera');
const cameraModal = document.getElementById('camera-modal');
const cameraVideo = document.getElementById('camera-video');
const cameraCanvas = document.getElementById('camera-canvas');
const cameraCapture = document.getElementById('camera-capture');
const cameraUse = document.getElementById('camera-use');
const cameraRetake = document.getElementById('camera-retake');
const cameraCancel = document.getElementById('camera-cancel');

function bubble(kind, text) {
  const el = document.createElement('div');
  el.className = `bubble ${kind}`;
  el.textContent = text;
  chat.appendChild(el);
  window.scrollTo(0, document.body.scrollHeight);
  return el;
}

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7Z" /></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>';

function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// WhatsApp/Telegram-style playback bubble for a recorded voice note.
function voiceBubble(url) {
  const el = document.createElement('div');
  el.className = 'bubble user voice';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'voice-play';
  btn.innerHTML = PLAY_ICON;

  const progress = document.createElement('div');
  progress.className = 'voice-progress';
  const fill = document.createElement('div');
  fill.className = 'voice-progress-fill';
  progress.appendChild(fill);

  const time = document.createElement('span');
  time.className = 'voice-time';
  time.textContent = '0:00';

  el.append(btn, progress, time);
  chat.appendChild(el);
  window.scrollTo(0, document.body.scrollHeight);

  const audio = new Audio(url);
  audio.preload = 'metadata';

  btn.addEventListener('click', () => {
    if (audio.paused) audio.play();
    else audio.pause();
  });
  audio.addEventListener('play', () => { btn.innerHTML = PAUSE_ICON; });
  audio.addEventListener('pause', () => { btn.innerHTML = PLAY_ICON; });
  audio.addEventListener('ended', () => {
    btn.innerHTML = PLAY_ICON;
    fill.style.width = '0%';
    time.textContent = fmtTime(audio.duration);
  });
  audio.addEventListener('loadedmetadata', () => { time.textContent = fmtTime(audio.duration); });
  audio.addEventListener('timeupdate', () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    fill.style.width = `${pct}%`;
    time.textContent = fmtTime(audio.duration - audio.currentTime);
  });
  progress.addEventListener('click', (e) => {
    if (!audio.duration) return;
    const rect = progress.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
  });

  return el;
}

async function authedFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  return fetch(path, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  });
}

let busy = false;
function setBusy(b) {
  busy = b;
  sendBtn.disabled = b;
  micBtn.disabled = b && !recording;
  cameraBtn.disabled = b;
}

// Send one turn (text or audio) to the proxy and render the assistant's reply.
async function sendTurn({ text, audioBase64, audioMime, audioUrl }) {
  if (busy) return;
  if (text) bubble('user', text);
  else if (audioUrl) voiceBubble(audioUrl);
  else bubble('user', '(voice note)');
  const thinking = bubble('meta', '…');
  setBusy(true);
  try {
    const res = await authedFetch('/voice-invoice', {
      method: 'POST',
      body: JSON.stringify({ sessionId, text, audioBase64, audioMime }),
    });
    thinking.remove();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { bubble('err', data.error ?? 'Something went wrong.'); return; }

    if (data.transcript) bubble('meta', `heard: "${data.transcript}"`);
    const reply = data.reply ?? data.output?.reply ?? 'OK.';
    bubble('bot', reply);
    if (data.invoice || data.saved) {
      const inv = data.invoice ?? {};
      bubble('saved', `Saved${inv.vendor ? `: ${inv.vendor}` : ''}` +
        `${inv.amount != null ? ` — ${inv.amount} ${inv.currency ?? ''}` : ''}`);
    }
  } catch (err) {
    thinking.remove();
    bubble('err', 'Network error — please try again.');
  } finally {
    setBusy(false);
  }
}

// --- Text ---
function submitText() {
  const t = textInput.value.trim();
  if (!t) return;
  textInput.value = '';
  sendTurn({ text: t });
}
sendBtn.addEventListener('click', submitText);
textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitText(); });

// --- Voice ---
let recorder = null, chunks = [], recording = false;

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

micBtn.addEventListener('click', async () => {
  if (recording) { recorder?.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      recording = false;
      micBtn.classList.remove('recording');
      micBtn.textContent = '●';
      stream.getTracks().forEach((t) => t.stop());
      if (!chunks.length) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const b64 = await blobToBase64(blob);
      const audioUrl = URL.createObjectURL(blob);
      sendTurn({ audioBase64: b64, audioMime: blob.type, audioUrl });
    };
    recorder.start();
    recording = true;
    micBtn.classList.add('recording');
    micBtn.textContent = '■';
  } catch (err) {
    bubble('err', 'Could not access the microphone.');
  }
});

// --- Camera: photograph a receipt, show it in the chat, save via /upload-invoice ---
let cameraStream = null;

function photoBubble(dataUrl) {
  const el = document.createElement('div');
  el.className = 'bubble user photo';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = 'Receipt photo';
  el.appendChild(img);
  chat.appendChild(el);
  window.scrollTo(0, document.body.scrollHeight);
  return el;
}

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
  if (busy) return;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 } },
    });
  } catch (err) {
    bubble('err', 'Could not access the camera — check permissions.');
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
cameraUse.addEventListener('click', async () => {
  // data: URL keeps the bubble CSP-safe (img-src allows data:) and doubles as the upload payload.
  const dataUrl = cameraCanvas.toDataURL('image/jpeg', 0.92);
  closeCamera();
  photoBubble(dataUrl);
  const thinking = bubble('meta', '…');
  setBusy(true);
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const res = await authedFetch('/upload-invoice', {
      method: 'POST',
      body: JSON.stringify({
        filename: `receipt-${stamp}.jpg`,
        contentType: 'image/jpeg',
        dataBase64: dataUrl.split(',')[1],
      }),
    });
    thinking.remove();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { bubble('err', data.error ?? 'Could not save the photo.'); return; }
    if (data.status === 'duplicate') {
      bubble('bot', `Already have this one${data.vendor ? `: ${data.vendor}` : ''} (duplicate, not saved).`);
    } else {
      bubble('saved', `Saved${data.vendor ? `: ${data.vendor}` : ''}` +
        `${data.amount != null ? ` — ${data.amount} ${data.currency ?? ''}` : ''}`);
      if (data.anomaly) bubble('warn', `⚠ Anomaly (${data.anomaly.level}): ${data.anomaly.insight}`);
    }
  } catch (err) {
    thinking.remove();
    bubble('err', 'Network error — please try again.');
  } finally {
    setBusy(false);
  }
});

bubble('bot', "Hi! Record, type, or photograph an invoice and I'll save it for you.");
