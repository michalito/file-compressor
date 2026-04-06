/**
 * Reusable confirmation dialog — Promise-based, uses existing modal system.
 */
import { createElement, icon } from '../lib/dom.js';
import { openModal, closeModal } from './modal.js';

let counter = 0;
let activeConfirm = false;

/**
 * Show a confirmation modal and return a Promise that resolves true/false.
 * @param {Object} options
 * @param {string} options.title
 * @param {string} [options.message]
 * @param {string} [options.confirmLabel='Confirm']
 * @param {string} [options.cancelLabel='Cancel']
 * @param {'danger'|'default'} [options.variant='default']
 * @returns {Promise<boolean>}
 */
export function showConfirm({
  title,
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
} = {}) {
  if (activeConfirm) return Promise.resolve(false);
  activeConfirm = true;

  const modalId = `confirm-modal-${counter++}`;
  const titleId = `${modalId}-title`;
  const messageId = `${modalId}-message`;
  const isDanger = variant === 'danger';

  return new Promise((resolve) => {
    let resolved = false;

    function finish(value) {
      if (resolved) return;
      resolved = true;
      activeConfirm = false;
      observer.disconnect();
      closeModal(modalId);
      setTimeout(() => modal.remove(), 250);
      resolve(value);
    }

    // Build DOM
    const iconName = isDanger ? 'alert-triangle' : 'info';
    const iconVariantClass = isDanger ? 'confirm__icon--danger' : 'confirm__icon--default';
    const confirmBtnClass = isDanger ? 'btn btn--danger' : 'btn btn--primary';

    const closeBtn = createElement('button', { class: 'modal__close', 'aria-label': 'Close' },
      icon('x', 20)
    );
    closeBtn.addEventListener('click', () => finish(false));

    const cancelBtn = createElement('button', { class: 'btn btn--ghost' }, cancelLabel);
    cancelBtn.addEventListener('click', () => finish(false));

    const confirmBtn = createElement('button', { class: confirmBtnClass }, confirmLabel);
    confirmBtn.addEventListener('click', () => finish(true));

    const modalAttrs = {
      class: 'modal',
      id: modalId,
      role: 'alertdialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    };
    if (message) modalAttrs['aria-describedby'] = messageId;

    const modal = createElement('div', modalAttrs,
      createElement('div', { class: 'modal__content' },
        createElement('div', { class: 'modal__header' },
          createElement('h2', { class: 'modal__title', id: titleId }, title),
          closeBtn
        ),
        createElement('div', { class: 'modal__body confirm__body' },
          createElement('div', { class: `confirm__icon ${iconVariantClass}` },
            icon(iconName, 32)
          ),
          message
            ? createElement('p', { class: 'confirm__message', id: messageId }, message)
            : ''
        ),
        createElement('div', { class: 'modal__footer' },
          cancelBtn,
          confirmBtn
        )
      )
    );

    // Catch external closes (Escape / backdrop) from modal.js
    const observer = new MutationObserver(() => {
      if (!modal.classList.contains('is-open') && !resolved) {
        finish(false);
      }
    });

    document.body.appendChild(modal);
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
    openModal(modalId);
  });
}
