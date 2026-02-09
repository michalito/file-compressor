/**
 * Modal manager: open/close, focus trap, Escape key, backdrop click.
 */
import { $ } from '../lib/dom.js';

let activeModal = null;
let previousFocus = null;

/**
 * Open a modal by ID.
 * @param {string} modalId
 */
export function openModal(modalId) {
  const modal = $(`#${modalId}`);
  if (!modal) return;

  previousFocus = document.activeElement;
  activeModal = modal;

  modal.classList.add('is-open');
  document.body.style.overflow = 'hidden';

  // Focus the first focusable element
  requestAnimationFrame(() => {
    const focusable = modal.querySelector(
      'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable) focusable.focus();
  });
}

/**
 * Close the currently active modal (or a specific one).
 * @param {string} [modalId]
 */
export function closeModal(modalId) {
  const modal = modalId ? $(`#${modalId}`) : activeModal;
  if (!modal) return;

  modal.classList.remove('is-open');
  document.body.style.overflow = '';
  activeModal = null;

  if (previousFocus) {
    previousFocus.focus();
    previousFocus = null;
  }
}

// Global keyboard handler
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeModal) {
    closeModal();
  }

  // Focus trap
  if (e.key === 'Tab' && activeModal) {
    const focusableEls = activeModal.querySelectorAll(
      'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusableEls.length === 0) return;

    const firstEl = focusableEls[0];
    const lastEl = focusableEls[focusableEls.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      }
    } else {
      if (document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  }
});

// Backdrop click
document.addEventListener('click', (e) => {
  if (activeModal && e.target === activeModal) {
    closeModal();
  }
});
