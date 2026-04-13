/**
 * Settings: right-side sidebar with accordion sections, segmented controls,
 * quality sliders, and immediate apply. Desktop: persistent drawer.
 * Mobile: bottom sheet with backdrop and focus trap.
 */
import { $, $$ } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import * as storage from '../lib/storage.js';
import {
  state,
  updateSettings,
  getSettings,
  getEffectiveWatermarkState,
  getProcessingSnapshot,
} from '../state/app-state.js';
import {
  initSegmentedControl,
  setSegmentedValue,
  setSegmentedDisabled,
  toggleHidden,
} from '../lib/form-controls.js';
import {
  initWatermarkEditor,
  syncWatermarkEditor,
  appendWatermarkSettings,
  flushPendingWatermarkEditorUpdates,
} from './watermark-editor.js';

/* ── Constants ────────────────────────────────────────────────────── */

const SIDEBAR_OPEN_KEY = 'compressify_sidebar_open';
const LEGACY_PANEL_EXPANDED_KEY = 'compressify_panel_expanded';
const SIDEBAR_TRANSITION_DISABLED_CLASS = 'is-sidebar-transition-disabled';
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const MOBILE_MQ = window.matchMedia('(max-width: 640px)');
let resizeAspectRatio = null;

const MODE_HINTS = {
  lossless: 'Highest quality, preserves original format (HEIC outputs as PNG)',
  web: 'Great quality, ~40\u201370% smaller files',
  high: 'Smallest files, noticeable quality loss',
};

const MODE_LABELS = {
  lossless: 'Lossless',
  web: 'Balanced',
  high: 'Maximum',
};

const FORMAT_LABELS = {
  auto: 'Auto',
  png: 'PNG',
  webp: 'WebP',
  jpeg: 'JPEG',
};

const QUALITY_DEFAULTS = {
  web:  { auto: 80, webp: 75, jpeg: 85 },
  high: { auto: 50, webp: 40, jpeg: 60 },
};

const BACKGROUND_REMOVAL_HINT = 'Subject isolation with rembg. Outputs a transparent PNG.';
const LOCKED_COMPRESSION_HINT = 'Background removal forces lossless transparent PNG output.';

/* ── Initialization ───────────────────────────────────────────────── */

export function initSettings() {
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;

  initSidebar();
  initSectionAccordions();
  initCompressionMode();
  initQualitySlider();
  initFormatControl();
  initResizeMode();
  initPresets();
  initAspectRatio();
  initBackground();
  initWatermarkEditor();

  // Apply persisted state to controls
  syncControlsFromState();

  // Listen for external state changes
  bus.on('settings:changed', () => {
    syncCompressionControls();
    updateSummary();
  });
  bus.on('watermark:logoChanged', () => updateSummary());
  bus.on('watermark:qrChanged', () => updateSummary());
}

/* ── Sidebar management ──────────────────────────────────────────── */

function initSidebar() {
  const appLayout = $('.app-layout');
  const toggleBtn = $('#sidebar-toggle');
  const closeBtn = $('#sidebar-close');
  const backdrop = $('#sidebar-backdrop');
  const sidebar = $('#settings-sidebar');

  if (!appLayout || !sidebar) return;

  migrateLegacySidebarPreference();
  setSidebarClosedState(true);

  // Restore persisted state — default open on desktop, closed on mobile
  const isMobile = MOBILE_MQ.matches;
  const savedOpen = storage.getItem(SIDEBAR_OPEN_KEY);

  if (!isMobile && savedOpen !== false) {
    runWithoutSidebarTransitions(appLayout, () => {
      openSidebar({ persist: false });
    });
  }

  // Toggle button in header
  toggleBtn?.addEventListener('click', () => toggleSidebar());

  // Close button inside sidebar
  closeBtn?.addEventListener('click', () => closeSidebar());

  // Backdrop click (mobile)
  backdrop?.addEventListener('click', () => closeSidebar());

  // Escape key closes on mobile
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isSidebarOpen() && MOBILE_MQ.matches) {
      closeSidebar();
    }
  });

  // Auto-close on mobile when first files arrive
  let hadFiles = false;
  bus.on('files:countChanged', ({ total }) => {
    const hasFiles = total > 0;
    if (hasFiles && !hadFiles && MOBILE_MQ.matches) {
      closeSidebar({ persist: false, restoreFocus: false });
    }
    hadFiles = hasFiles;
  });

  // Handle viewport resize between desktop/mobile modes
  MOBILE_MQ.addEventListener('change', (e) => {
    if (e.matches) {
      // Switched to mobile — close sidebar without overwriting desktop preference
      if (isSidebarOpen()) closeSidebar({ persist: false, restoreFocus: false });
    } else {
      // Switched to desktop — clean up mobile ARIA and restore saved state
      sidebar?.removeAttribute('role');
      sidebar?.removeAttribute('aria-modal');
      document.body.style.overflow = '';
      sidebar?.removeEventListener('keydown', trapFocus);
      // Restore desktop sidebar from persisted preference
      const savedOpen = storage.getItem(SIDEBAR_OPEN_KEY);
      if (savedOpen !== false) openSidebar({ persist: false });
    }
  });
}

function migrateLegacySidebarPreference() {
  const legacyValue = storage.getItem(LEGACY_PANEL_EXPANDED_KEY);
  if (legacyValue === null) return;

  if (storage.getItem(SIDEBAR_OPEN_KEY) === null) {
    storage.setItem(SIDEBAR_OPEN_KEY, legacyValue);
  }

  storage.removeItem(LEGACY_PANEL_EXPANDED_KEY);
}

function runWithoutSidebarTransitions(appLayout, callback) {
  appLayout.classList.add(SIDEBAR_TRANSITION_DISABLED_CLASS);
  callback();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      appLayout.classList.remove(SIDEBAR_TRANSITION_DISABLED_CLASS);
    });
  });
}

function initSectionAccordions() {
  $$('.sidebar__section[data-section]').forEach((section) => {
    const header = section.querySelector('.sidebar__section-header');
    // Only wire up accordion on button headers (not static toggle headers)
    if (!header || header.classList.contains('sidebar__section-header--static')) return;

    header.addEventListener('click', () => {
      const isOpen = section.classList.toggle('is-open');
      header.setAttribute('aria-expanded', String(isOpen));
    });
  });
}

function toggleSidebar() {
  if (isSidebarOpen()) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

function openSidebar({ persist = shouldPersistSidebarState() } = {}) {
  const appLayout = $('.app-layout');
  const toggleBtn = $('#sidebar-toggle');
  const sidebar = $('#settings-sidebar');

  setSidebarClosedState(false);
  appLayout?.classList.add('is-sidebar-open');
  toggleBtn?.setAttribute('aria-expanded', 'true');

  if (MOBILE_MQ.matches) {
    document.body.style.overflow = 'hidden';
    sidebar?.setAttribute('role', 'dialog');
    sidebar?.setAttribute('aria-modal', 'true');
    // Focus first focusable element
    requestAnimationFrame(() => {
      const firstFocusable = sidebar?.querySelector(FOCUSABLE_SELECTOR);
      firstFocusable?.focus();
    });
    sidebar?.addEventListener('keydown', trapFocus);
  } else {
    document.body.style.overflow = '';
    sidebar?.removeAttribute('role');
    sidebar?.removeAttribute('aria-modal');
    sidebar?.removeEventListener('keydown', trapFocus);
  }

  if (persist) storage.setItem(SIDEBAR_OPEN_KEY, true);
}

function closeSidebar({
  persist = shouldPersistSidebarState(),
  restoreFocus = MOBILE_MQ.matches || isFocusInsideSidebar(),
} = {}) {
  const appLayout = $('.app-layout');
  const toggleBtn = $('#sidebar-toggle');
  const sidebar = $('#settings-sidebar');

  appLayout?.classList.remove('is-sidebar-open');
  toggleBtn?.setAttribute('aria-expanded', 'false');
  setSidebarClosedState(true);

  if (MOBILE_MQ.matches) {
    document.body.style.overflow = '';
    sidebar?.removeAttribute('role');
    sidebar?.removeAttribute('aria-modal');
    sidebar?.removeEventListener('keydown', trapFocus);
  }

  if (restoreFocus) toggleBtn?.focus();
  if (persist) storage.setItem(SIDEBAR_OPEN_KEY, false);
}

function isSidebarOpen() {
  return $('.app-layout')?.classList.contains('is-sidebar-open') ?? false;
}

function shouldPersistSidebarState() {
  return !MOBILE_MQ.matches;
}

function setSidebarClosedState(closed) {
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;

  sidebar.toggleAttribute('inert', closed);
  sidebar.setAttribute('aria-hidden', String(closed));
}

function isFocusInsideSidebar() {
  const sidebar = $('#settings-sidebar');
  return !!sidebar && sidebar.contains(document.activeElement);
}

function trapFocus(e) {
  if (e.key !== 'Tab') return;

  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;

  const focusable = [...sidebar.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (el) => !el.disabled && el.offsetParent !== null
  );

  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/* ── Compression mode segmented control ───────────────────────────── */

function initCompressionMode() {
  const control = $('#compression-mode-control');
  if (!control) return;

  initSegmentedControl(control, (value) => {
    const format = state.settings.compress.outputFormat || 'auto';
    const quality = getDefaultQuality(value, format);
    updateSettings('compress', { mode: value, quality });

    // Show/hide quality slider (hidden for lossless OR PNG)
    const hideQuality = value === 'lossless' || format === 'png';
    toggleHidden('#quality-slider-group', hideQuality);

    // Update hint
    const hint = $('#compression-hint');
    if (hint) hint.textContent = MODE_HINTS[value] || '';

    // Sync quality slider
    if (!hideQuality) {
      syncSliderValue(quality);
    }
  });
}

/* ── Quality slider ───────────────────────────────────────────────── */

function initQualitySlider() {
  const slider = $('#quality-slider');
  const output = $('#quality-value');
  if (!slider || !output) return;

  // Live visual feedback during drag
  slider.addEventListener('input', () => {
    output.textContent = slider.value;
  });

  // Commit on release
  slider.addEventListener('change', () => {
    updateSettings('compress', { quality: parseInt(slider.value, 10) });
  });
}

/* ── Format segmented control ─────────────────────────────────────── */

function initFormatControl() {
  const control = $('#format-control');
  if (!control) return;

  initSegmentedControl(control, (value) => {
    const mode = state.settings.compress.mode;
    const quality = getDefaultQuality(mode, value);
    updateSettings('compress', { outputFormat: value, quality });

    const hideQuality = mode === 'lossless' || value === 'png';
    toggleHidden('#quality-slider-group', hideQuality);
    if (!hideQuality) syncSliderValue(quality);
  });
}

/* ── Resize mode segmented control ────────────────────────────────── */

function initResizeMode() {
  const control = $('#resize-mode-control');
  if (!control) return;

  initSegmentedControl(control, (value) => {
    toggleHidden('#custom-size-section', value !== 'custom');

    if (value === 'original') {
      resizeAspectRatio = null;
      updateSettings('resize', { mode: value, width: null, height: null });
    } else {
      const w = parseInt($('#custom-width')?.value, 10) || null;
      const h = parseInt($('#custom-height')?.value, 10) || null;
      updateSettings('resize', { mode: value, width: w, height: h });
    }
  });
}

/* ── Size presets ─────────────────────────────────────────────────── */

function initPresets() {
  $$('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const w = parseInt(btn.dataset.width, 10);
      const h = parseInt(btn.dataset.height, 10);

      const widthInput = $('#custom-width');
      const heightInput = $('#custom-height');
      if (widthInput) widthInput.value = w;
      if (heightInput) heightInput.value = h;
      resizeAspectRatio = w / h;

      // Ensure custom mode is active
      setSegmentedValue('#resize-mode-control', 'custom');
      toggleHidden('#custom-size-section', false);

      updateSettings('resize', { mode: 'custom', width: w, height: h });
    });
  });
}

/* ── Dimension inputs with aspect ratio ───────────────────────────── */

function initAspectRatio() {
  const widthInput = $('#custom-width');
  const heightInput = $('#custom-height');
  if (!widthInput || !heightInput) return;

  let updating = false;

  const syncOther = (changed, other) => {
    if (!resizeAspectRatio || updating) return;
    updating = true;
    const val = parseInt(changed.value, 10);
    if (!isNaN(val)) {
      other.value = changed === widthInput
        ? Math.round(val / resizeAspectRatio)
        : Math.round(val * resizeAspectRatio);
    }
    updating = false;
  };

  widthInput.addEventListener('input', () => {
    if (!widthInput.value || !heightInput.value) {
      resizeAspectRatio = null;
      return;
    }
    syncOther(widthInput, heightInput);
  });

  heightInput.addEventListener('input', () => {
    if (!widthInput.value || !heightInput.value) {
      resizeAspectRatio = null;
      return;
    }
    syncOther(heightInput, widthInput);
  });

  // Commit dimensions on change (blur / Enter)
  const commitDimensions = () => {
    const w = parseInt(widthInput.value, 10) || null;
    const h = parseInt(heightInput.value, 10) || null;
    updateSettings('resize', { width: w, height: h });
  };

  widthInput.addEventListener('change', commitDimensions);
  heightInput.addEventListener('change', commitDimensions);
}

/* ── Background removal ──────────────────────────────────────────── */

function initBackground() {
  const toggle = $('#background-toggle');
  const hint = $('#background-hint');
  if (!toggle) return;

  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    if (hint) hint.classList.toggle('is-hidden', !enabled);
    updateSettings('background', { enabled });
    syncCompressionControls();
  });
}

function getEffectiveCompressSettings(settings = state.settings) {
  if (!settings.background?.enabled) {
    return settings.compress;
  }

  return {
    ...settings.compress,
    mode: 'lossless',
    outputFormat: 'png',
    quality: null,
  };
}

function syncCompressionControls() {
  const compress = getEffectiveCompressSettings();
  const backgroundEnabled = state.settings.background?.enabled;

  setSegmentedValue('#compression-mode-control', compress.mode);
  setSegmentedValue('#format-control', compress.outputFormat || 'auto');
  setSegmentedDisabled('#compression-mode-control', backgroundEnabled);
  setSegmentedDisabled('#format-control', backgroundEnabled);

  const compressionHint = $('#compression-hint');
  if (compressionHint) {
    compressionHint.textContent = MODE_HINTS[compress.mode] || '';
  }

  const backgroundHint = $('#background-hint');
  if (backgroundHint) {
    backgroundHint.textContent = backgroundEnabled ? LOCKED_COMPRESSION_HINT : BACKGROUND_REMOVAL_HINT;
    backgroundHint.classList.toggle('sidebar__hint--warning', backgroundEnabled);
    backgroundHint.classList.toggle('is-hidden', !backgroundEnabled);
  }

  const qualitySlider = $('#quality-slider');
  if (qualitySlider) {
    qualitySlider.disabled = backgroundEnabled;
  }

  const hideQuality = backgroundEnabled || compress.mode === 'lossless' || compress.outputFormat === 'png';
  toggleHidden('#quality-slider-group', hideQuality);
  if (!hideQuality) {
    const quality = compress.quality ?? getDefaultQuality(compress.mode, compress.outputFormat || 'auto');
    syncSliderValue(quality);
  }
}

/* ── Sync controls from persisted state ───────────────────────────── */

function syncControlsFromState() {
  const { resize, background } = state.settings;

  syncCompressionControls();

  // Resize
  setSegmentedValue('#resize-mode-control', resize.mode);
  toggleHidden('#custom-size-section', resize.mode !== 'custom');
  if (resize.width) {
    const w = $('#custom-width');
    if (w) w.value = resize.width;
  }
  if (resize.height) {
    const h = $('#custom-height');
    if (h) h.value = resize.height;
  }

  // Background removal
  const bgToggle = $('#background-toggle');
  if (bgToggle) bgToggle.checked = background.enabled;

  // Watermark
  syncWatermarkEditor();

  updateSummary();
}

/* ── Summary text ─────────────────────────────────────────────────── */

function updateSummary() {
  const el = $('#settings-summary');
  if (!el) return;

  const { resize, background } = state.settings;
  const compress = getEffectiveCompressSettings();
  const parts = [];

  // Compression
  parts.push(MODE_LABELS[compress.mode] || compress.mode);

  // Format (non-auto for any mode)
  if (compress.outputFormat && compress.outputFormat !== 'auto') {
    parts.push(FORMAT_LABELS[compress.outputFormat] || compress.outputFormat);
  }

  // Quality (non-lossless, non-PNG)
  if (compress.mode !== 'lossless' && compress.outputFormat !== 'png' && compress.quality != null) {
    parts.push(`Q${compress.quality}`);
  }

  // Resize
  if (resize.mode === 'custom' && resize.width && resize.height) {
    parts.push(`${resize.width}\u00d7${resize.height}`);
  } else {
    parts.push('Original size');
  }

  if (background.enabled) {
    parts.push('BG removed');
  }

  // Watermark
  if (getEffectiveWatermarkState().enabled) {
    parts.push('Watermark');
  }

  el.textContent = parts.join(' \u00b7 ');
}

/* ── Utility helpers ──────────────────────────────────────────────── */

function getDefaultQuality(mode, format) {
  if (format === 'png') return null; // PNG is lossless, no quality
  const modeDefaults = QUALITY_DEFAULTS[mode];
  if (!modeDefaults) return null; // lossless
  return modeDefaults[format] ?? modeDefaults.auto ?? null;
}

function syncSliderValue(quality) {
  const slider = $('#quality-slider');
  const output = $('#quality-value');
  if (slider && quality != null) slider.value = quality;
  if (output && quality != null) output.textContent = quality;
}

function appendCompressionSettings(settings, formData) {
  formData.append('compression_mode', settings.mode);
  formData.append('output_format', settings.outputFormat || 'auto');
  if (settings.mode !== 'lossless' && settings.outputFormat !== 'png' && settings.quality != null) {
    formData.append('quality', settings.quality);
  }
}

function appendBackgroundSettings(settings, formData) {
  if (settings.enabled) {
    formData.append('remove_background', '1');
  }
}

function appendResizeSettings(settings, formData) {
  formData.append('resize_mode', settings.mode);
  if (settings.mode === 'custom') {
    if (settings.width) formData.append('max_width', settings.width);
    if (settings.height) formData.append('max_height', settings.height);
  }
}

/**
 * Build FormData with current settings for processing.
 * @param {FormData} formData
 */
export async function appendSettingsToFormData(formData) {
  const settings = getSettings();
  appendCompressionSettings(getEffectiveCompressSettings(settings), formData);
  appendBackgroundSettings(settings.background, formData);
  appendResizeSettings(settings.resize, formData);
  await appendWatermarkSettings(formData);
}

export function getCurrentProcessingSnapshot() {
  flushPendingWatermarkEditorUpdates();
  return getProcessingSnapshot();
}
