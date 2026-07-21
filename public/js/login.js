import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { setSbCookie } from '/js/util.js';

const cfg = await fetch('/config').then((r) => r.json());
const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

const signinForm = document.getElementById('signin-form');
const siEmail = document.getElementById('si-email');
const siPassword = document.getElementById('si-password');
const siEmailErr = document.getElementById('si-email-err');
const siPasswordErr = document.getElementById('si-password-err');
const siError = document.getElementById('si-error');
const siSubmit = document.getElementById('si-submit');

// Set the cookie the same way app.html does, then hand off to the dashboard.
function completeLogin(session) {
  setSbCookie(session.access_token);
  window.location.href = '/app';
}

// Already signed in? Skip straight to the app.
const { data: { session } } = await supabase.auth.getSession();
if (session) completeLogin(session);

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function clearErrors() {
  for (const el of document.querySelectorAll('.field-error, .form-error')) {
    el.textContent = '';
  }
  for (const el of document.querySelectorAll('input.invalid')) {
    el.classList.remove('invalid');
  }
}

function fieldError(input, errEl, message) {
  errEl.textContent = message;
  input.classList.add('invalid');
  input.focus();
}

signinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors();
  const email = siEmail.value.trim();
  const password = siPassword.value;

  if (!isValidEmail(email)) return fieldError(siEmail, siEmailErr, 'Enter a valid email address');
  if (!password) return fieldError(siPassword, siPasswordErr, 'Enter your password');

  siSubmit.disabled = true;
  siSubmit.textContent = 'Signing in…';
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  siSubmit.disabled = false;
  siSubmit.textContent = 'Sign in';

  if (error) {
    if (/invalid login credentials|invalid credentials/i.test(error.message)) {
      return fieldError(siPassword, siPasswordErr, 'Incorrect email or password');
    }
    siError.textContent = error.message;
    return;
  }

  completeLogin(data.session);
});
