// Curizen Portal — shared sidebar. Mounted by every authenticated page.
// mountSidebar(activeKey, { email, onSignOut, onChangePassword }) injects the
// nav into #sidebar-root and wires the account block's sign-out button and
// change-password panel.
//
// onChangePassword(newPassword) is provided by each page (it closes over that
// page's own supabase client, matching the existing per-page-client pattern)
// and must return a Promise resolving to { ok: true } or { ok: false, error }.

const ICONS = {
  dashboard:
    '<path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v9a1 1 0 0 0 1 1h3v-5h4v5h3a1 1 0 0 0 1-1v-9" />',
  voice:
    '<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /><path d="M8 21h8" />',
  subscriptions:
    '<path d="M7 3h8l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M15 3v4h4" /><path d="M9 12h6" /><path d="M9 16h6" />',
  reports:
    '<path d="M4 20V10" /><path d="M11 20V4" /><path d="M18 20v-7" /><path d="M3 20h18" />',
  employees:
    '<circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><circle cx="17" cy="9" r="2.4" /><path d="M15.5 12.2A4.5 4.5 0 0 1 20.5 16" />',
};

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', href: '/app', icon: 'dashboard' },
  { key: 'voice', label: 'invoice chat', href: '/voice', icon: 'voice' },
  { key: 'subscriptions', label: 'Subscriptions', href: '/subscriptions', icon: 'subscriptions' },
  { key: 'reports', label: 'Reports', href: '/reports', icon: 'reports' },
  { key: 'employees', label: 'Employees', href: '/employees', icon: 'employees' },
];

function svgIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

export function mountSidebar(activeKey, { email = '', onSignOut, onChangePassword } = {}) {
  const root = document.getElementById('sidebar-root');
  if (!root) return;

  root.innerHTML = `
    <aside class="sidebar">
      <div class="sidebar-brand">
        <span>Curizen Portal</span>
      </div>
      <nav class="sidebar-nav">
        ${NAV_ITEMS.map(
          (item) => `
          <a class="nav-item${item.key === activeKey ? ' active' : ''}" href="${item.href}">
            ${svgIcon(item.icon)}
            <span>${item.label}</span>
          </a>`,
        ).join('')}
      </nav>
      <div class="sidebar-account">
        <span class="avatar"></span>
        <div class="who">
          <div class="email"></div>
          <div class="who-links">
            <button class="change-pw" id="sidebar-change-pw" type="button">Change password</button>
            <button class="signout" id="sidebar-signout" type="button">Sign out</button>
          </div>
        </div>
      </div>
      <div class="password-panel hidden" id="sidebar-pw-panel">
        <p class="pw-title">Change password</p>
        <input id="sidebar-pw-new" type="password" placeholder="New password" autocomplete="new-password" />
        <input id="sidebar-pw-confirm" type="password" placeholder="Confirm password" autocomplete="new-password" />
        <p class="pw-msg" id="sidebar-pw-msg"></p>
        <div class="pw-actions">
          <button class="pw-save" id="sidebar-pw-save" type="button">Save</button>
          <button class="pw-cancel" id="sidebar-pw-cancel" type="button">Cancel</button>
        </div>
      </div>
    </aside>
  `;

  // Untrusted-ish text (the account email) goes in via textContent/property
  // assignment, never interpolated into the innerHTML template above.
  root.querySelector('.avatar').textContent = (email || '?').trim().charAt(0);
  const emailEl = root.querySelector('.who .email');
  emailEl.textContent = email || 'Account';
  emailEl.title = email;

  if (onSignOut) {
    document.getElementById('sidebar-signout').addEventListener('click', onSignOut);
  }

  if (onChangePassword) {
    const panel = document.getElementById('sidebar-pw-panel');
    const changePwBtn = document.getElementById('sidebar-change-pw');
    const newInput = document.getElementById('sidebar-pw-new');
    const confirmInput = document.getElementById('sidebar-pw-confirm');
    const saveBtn = document.getElementById('sidebar-pw-save');
    const cancelBtn = document.getElementById('sidebar-pw-cancel');
    const msgEl = document.getElementById('sidebar-pw-msg');

    function setMsg(text, kind) {
      msgEl.textContent = text;
      msgEl.className = `pw-msg${kind ? ` ${kind}` : ''}`;
    }

    function closePanel() {
      panel.classList.add('hidden');
      newInput.value = '';
      confirmInput.value = '';
      setMsg('');
    }

    changePwBtn.addEventListener('click', () => {
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) newInput.focus();
    });
    cancelBtn.addEventListener('click', closePanel);

    saveBtn.addEventListener('click', async () => {
      const password = newInput.value;
      const confirm = confirmInput.value;
      if (password.length < 8) return setMsg('Must be at least 8 characters.', 'error');
      if (password !== confirm) return setMsg("Passwords don't match.", 'error');

      saveBtn.disabled = true;
      setMsg('Saving…');
      const result = await onChangePassword(password);
      saveBtn.disabled = false;

      if (result?.ok) {
        setMsg('Password updated ✓', 'ok');
        newInput.value = '';
        confirmInput.value = '';
        setTimeout(closePanel, 1500);
      } else {
        setMsg(result?.error || 'Could not update password.', 'error');
      }
    });
  } else {
    document.getElementById('sidebar-change-pw')?.remove();
  }
}
