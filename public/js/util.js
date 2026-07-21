// Shared page helpers.

// HTML-escape untrusted text before interpolating into innerHTML templates.
export function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

// Session cookie for the browser-redirect OAuth routes (/connect, /callback) —
// the only place the server accepts it (GET/HEAD only; mutations require the
// Authorization header). Secure on https so it never travels in clear.
export function setSbCookie(accessToken) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `sb_token=${accessToken}; path=/; SameSite=Lax${secure}`;
}
export function clearSbCookie() {
  document.cookie = 'sb_token=; path=/; SameSite=Lax; Max-Age=0';
}
