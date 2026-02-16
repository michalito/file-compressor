/**
 * Footer: scroll-to-top button and dynamic hint text.
 */
import { $ } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { state } from '../state/app-state.js';

const SCROLL_THRESHOLD = 300;
const DEFAULT_HINT = 'Drop files anywhere to compress';

export function initFooter() {
  const scrollBtn = $('#scroll-top-btn');
  const hintEl = $('#footer-hint');
  const scrollContainer = $('#main-content');

  if (!scrollBtn || !scrollContainer) return;

  // Scroll-to-top visibility (passive, rAF-throttled)
  let ticking = false;
  scrollContainer.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        scrollBtn.classList.toggle('is-hidden', scrollContainer.scrollTop <= SCROLL_THRESHOLD);
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });

  // Scroll-to-top click
  scrollBtn.addEventListener('click', () => {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Dynamic hint text (workspace page only)
  if (!hintEl || !$('.app-layout')) return;

  bus.on('files:countChanged', () => updateHint(hintEl));
  bus.on('file:updated', () => updateHint(hintEl));
  bus.on('files:cleared', () => { hintEl.textContent = DEFAULT_HINT; });
}

function updateHint(hintEl) {
  const entries = [...state.files.values()];
  const total = entries.length;
  if (total === 0) return;

  const done = entries.filter(e => e.status === 'done').length;
  const processing = entries.filter(e => e.status === 'processing').length;

  if (processing > 0) {
    hintEl.textContent = `${done} of ${total} processed\u2026`;
  } else if (done === total) {
    let totalSaved = 0;
    for (const entry of entries) {
      if (entry.processedData?.metadata) {
        const orig = entry.processedData.metadata.original_size || 0;
        const comp = entry.processedData.metadata.compressed_size || 0;
        totalSaved += (orig - comp);
      }
    }
    if (totalSaved > 0) {
      hintEl.textContent = `${total} file${total !== 1 ? 's' : ''} \u00b7 ${formatBytes(totalSaved)} saved`;
    } else {
      hintEl.textContent = `${total} file${total !== 1 ? 's' : ''} processed`;
    }
  } else {
    hintEl.textContent = `${total} file${total !== 1 ? 's' : ''} loaded`;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
