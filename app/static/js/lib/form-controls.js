import { $ } from './dom.js';

export function initSegmentedControl(container, onChange) {
  const items = container.querySelectorAll('.segmented-control__item');

  items.forEach((item) => {
    item.addEventListener('click', () => {
      items.forEach((segmentedItem) => {
        segmentedItem.classList.remove('is-active');
        segmentedItem.setAttribute('aria-checked', 'false');
      });
      item.classList.add('is-active');
      item.setAttribute('aria-checked', 'true');

      onChange(item.dataset.value);
    });

    item.addEventListener('keydown', (event) => {
      const orderedItems = [...items];
      const currentIndex = orderedItems.indexOf(item);
      let nextItem = null;

      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextItem = orderedItems[(currentIndex + 1) % orderedItems.length];
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextItem = orderedItems[(currentIndex - 1 + orderedItems.length) % orderedItems.length];
      }

      if (!nextItem) return;

      event.preventDefault();
      nextItem.focus();
      nextItem.click();
    });
  });

  items.forEach((item) => {
    item.setAttribute('tabindex', item.classList.contains('is-active') ? '0' : '-1');
  });

  container.addEventListener('click', () => {
    items.forEach((item) => {
      item.setAttribute('tabindex', item.classList.contains('is-active') ? '0' : '-1');
    });
  });
}

export function setSegmentedValue(selector, value) {
  const container = $(selector);
  if (!container) return;

  const items = container.querySelectorAll('.segmented-control__item');
  items.forEach((item) => {
    const isMatch = item.dataset.value === value;
    item.classList.toggle('is-active', isMatch);
    item.setAttribute('aria-checked', String(isMatch));
    item.setAttribute('tabindex', isMatch ? '0' : '-1');
  });
}

export function setSegmentedDisabled(selector, disabled) {
  const container = $(selector);
  if (!container) return;

  container.classList.toggle('is-disabled', disabled);
  container.setAttribute('aria-disabled', String(disabled));

  const items = container.querySelectorAll('.segmented-control__item');
  items.forEach((item) => {
    item.disabled = disabled;
    item.setAttribute('aria-disabled', String(disabled));
    if (disabled) {
      item.setAttribute('tabindex', '-1');
    } else if (item.classList.contains('is-active')) {
      item.setAttribute('tabindex', '0');
    } else {
      item.setAttribute('tabindex', '-1');
    }
  });
}

export function toggleHidden(selector, hidden) {
  const el = $(selector);
  if (el) el.classList.toggle('is-hidden', hidden);
}
