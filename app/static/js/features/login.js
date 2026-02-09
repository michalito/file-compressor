/**
 * Login page — client-side validation, password show/hide.
 * Uses standard form POST (no AJAX anti-pattern).
 */
import { $ } from '../lib/dom.js';

export function initLogin() {
  const form = $('#login-form');
  if (!form) return;

  const passwordInput = $('#password');
  const toggleBtn = $('#password-toggle');

  // Password show/hide toggle
  if (toggleBtn && passwordInput) {
    toggleBtn.addEventListener('click', () => {
      const isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';

      // Toggle icon visibility
      const eyeIcon = toggleBtn.querySelector('.icon--eye');
      const eyeOffIcon = toggleBtn.querySelector('.icon--eye-off');
      if (eyeIcon) eyeIcon.style.display = isPassword ? 'none' : 'block';
      if (eyeOffIcon) eyeOffIcon.style.display = isPassword ? 'block' : 'none';

      toggleBtn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
    });
  }

  // Client-side validation
  form.addEventListener('submit', (e) => {
    if (!passwordInput.value.trim()) {
      e.preventDefault();
      passwordInput.classList.add('form-input--error');
      passwordInput.focus();
    }
  });

  // Clear error state on input
  if (passwordInput) {
    passwordInput.addEventListener('input', () => {
      passwordInput.classList.remove('form-input--error');
    });
  }
}
