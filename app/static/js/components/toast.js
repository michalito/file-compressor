/**
 * Toast notification manager.
 */
import { $, createElement, icon } from '../lib/dom.js';

const ICON_MAP = {
  success: 'check-circle',
  error: 'alert-circle',
  warning: 'alert-triangle',
  info: 'info',
};

const DURATION = 5000;

/**
 * Show a toast notification.
 * @param {Object} options
 * @param {string} options.message - Toast message
 * @param {'success'|'error'|'warning'|'info'} [options.type='info']
 * @param {number} [options.duration=5000] - Auto-dismiss ms (0 for persistent)
 */
export function showToast({ message, type = 'info', duration = DURATION }) {
  const container = $('#toast-container');
  if (!container) return;

  const iconEl = icon(ICON_MAP[type] || 'info', 20);
  iconEl.classList.add('toast__icon');

  const closeBtn = createElement('button', {
    class: 'toast__close',
    'aria-label': 'Dismiss',
  });
  const closeIcon = icon('x', 16);
  closeBtn.appendChild(closeIcon);

  const toast = createElement('div', { class: `toast toast--${type}`, role: 'alert' },
    iconEl,
    createElement('div', { class: 'toast__body' },
      createElement('p', { class: 'toast__message' }, message)
    ),
    closeBtn
  );

  container.appendChild(toast);

  const dismiss = () => {
    toast.classList.add('is-leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };

  closeBtn.addEventListener('click', dismiss);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}
