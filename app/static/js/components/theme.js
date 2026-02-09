/**
 * Theme toggle: dark / light / system preference.
 */
import { $ } from '../lib/dom.js';
import * as storage from '../lib/storage.js';
import { postJSON } from '../lib/api.js';

const STORAGE_KEY = 'theme';

export function initTheme() {
  const savedTheme = storage.getItem(STORAGE_KEY);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (prefersDark ? 'dark' : 'light');

  applyTheme(theme);

  const toggleBtn = $('#theme-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', toggleTheme);
  }

  // Listen for system preference changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!storage.getItem(STORAGE_KEY)) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';

  applyTheme(next);
  storage.setItem(STORAGE_KEY, next);

  // Sync with server (fire-and-forget)
  postJSON('/theme', { theme: next }).catch(() => {});
}
