/**
 * Settings: right-side sidebar with accordion sections, segmented controls,
 * quality sliders, and immediate apply. Desktop: persistent drawer.
 * Mobile: bottom sheet with backdrop and focus trap.
 */
import { $, $$ } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import * as storage from '../lib/storage.js';
import { state, updateSettings, getSettings } from '../state/app-state.js';

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

/* ── Tool FormData builders ───────────────────────────────────────── */

const tools = {
  compress: {
    toFormData(settings, formData) {
      formData.append('compression_mode', settings.mode);
      formData.append('output_format', settings.outputFormat || 'auto');
      if (settings.mode !== 'lossless' && settings.outputFormat !== 'png' && settings.quality != null) {
        formData.append('quality', settings.quality);
      }
    },
  },
  background: {
    toFormData(settings, formData) {
      if (settings.enabled) {
        formData.append('remove_background', '1');
      }
    },
  },
  resize: {
    toFormData(settings, formData) {
      formData.append('resize_mode', settings.mode);
      if (settings.mode === 'custom') {
        if (settings.width) formData.append('max_width', settings.width);
        if (settings.height) formData.append('max_height', settings.height);
      }
    },
  },
  watermark: {
    toFormData(settings, formData) {
      if (settings.enabled && settings.text.trim()) {
        formData.append('watermark_text', settings.text.trim());
        formData.append('watermark_position', settings.position);
        formData.append('watermark_opacity', settings.opacity);
        formData.append('watermark_color', settings.color);
        formData.append('watermark_size', settings.size);
        formData.append('watermark_angle', settings.angle ?? 0);
        if (settings.position === 'tiled') {
          formData.append('watermark_tile_density', settings.tileDensity);
        }
      }
    },
  },
};

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
  initWatermark();

  // Apply persisted state to controls
  syncControlsFromState();

  // Listen for external state changes
  bus.on('settings:changed', () => {
    syncCompressionControls();
    updateSummary();
  });
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

/* ── Watermark ────────────────────────────────────────────────────── */

function initWatermark() {
  const toggle = $('#watermark-toggle');
  const body = $('#watermark-body');
  const textInput = $('#watermark-text');
  if (!toggle || !body) return;

  // Toggle
  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    body.classList.toggle('is-hidden', !enabled);
    updateSettings('watermark', { enabled });
  });

  // Text input — commit on change (blur / Enter)
  if (textInput) {
    textInput.addEventListener('change', () => {
      updateSettings('watermark', { text: textInput.value });
    });
  }

  // Position segmented control
  const posControl = $('#watermark-position-control');
  if (posControl) {
    initSegmentedControl(posControl, (value) => {
      updateSettings('watermark', { position: value });
      toggleHidden('#watermark-density-group', value !== 'tiled');
    });
  }

  // Color segmented control
  const colorControl = $('#watermark-color-control');
  if (colorControl) {
    initSegmentedControl(colorControl, (value) => {
      updateSettings('watermark', { color: value });
    });
  }

  // Opacity slider
  const opacitySlider = $('#watermark-opacity-slider');
  const opacityValue = $('#watermark-opacity-value');
  if (opacitySlider) {
    opacitySlider.addEventListener('input', () => {
      if (opacityValue) opacityValue.textContent = `${opacitySlider.value}%`;
    });
    opacitySlider.addEventListener('change', () => {
      updateSettings('watermark', { opacity: parseInt(opacitySlider.value, 10) });
    });
  }

  // Size slider
  const sizeSlider = $('#watermark-size-slider');
  const sizeValue = $('#watermark-size-value');
  if (sizeSlider) {
    sizeSlider.addEventListener('input', () => {
      if (sizeValue) sizeValue.textContent = sizeSlider.value;
    });
    sizeSlider.addEventListener('change', () => {
      updateSettings('watermark', { size: parseInt(sizeSlider.value, 10) });
    });
  }

  // Tile density slider
  const densitySlider = $('#watermark-density-slider');
  const densityValue = $('#watermark-density-value');
  if (densitySlider) {
    densitySlider.addEventListener('input', () => {
      if (densityValue) densityValue.textContent = densitySlider.value;
    });
    densitySlider.addEventListener('change', () => {
      updateSettings('watermark', { tileDensity: parseInt(densitySlider.value, 10) });
    });
  }

  // Angle slider
  const angleSlider = $('#watermark-angle-slider');
  const angleValue = $('#watermark-angle-value');
  if (angleSlider) {
    angleSlider.addEventListener('input', () => {
      if (angleValue) angleValue.textContent = `${angleSlider.value}\u00b0`;
    });
    angleSlider.addEventListener('change', () => {
      updateSettings('watermark', { angle: parseInt(angleSlider.value, 10) });
    });
  }
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
  const { resize, background, watermark } = state.settings;

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
  const wmToggle = $('#watermark-toggle');
  const wmBody = $('#watermark-body');
  const wmText = $('#watermark-text');
  if (wmToggle) wmToggle.checked = watermark.enabled;
  if (wmBody) wmBody.classList.toggle('is-hidden', !watermark.enabled);
  if (wmText) wmText.value = watermark.text || '';
  setSegmentedValue('#watermark-position-control', watermark.position);
  setSegmentedValue('#watermark-color-control', watermark.color);

  const opacitySlider = $('#watermark-opacity-slider');
  const opacityValue = $('#watermark-opacity-value');
  if (opacitySlider) opacitySlider.value = watermark.opacity;
  if (opacityValue) opacityValue.textContent = `${watermark.opacity}%`;

  const sizeSlider = $('#watermark-size-slider');
  const sizeValue = $('#watermark-size-value');
  if (sizeSlider) sizeSlider.value = watermark.size;
  if (sizeValue) sizeValue.textContent = watermark.size;

  const densitySlider = $('#watermark-density-slider');
  const densityValue = $('#watermark-density-value');
  if (densitySlider) densitySlider.value = watermark.tileDensity;
  if (densityValue) densityValue.textContent = watermark.tileDensity;
  toggleHidden('#watermark-density-group', watermark.position !== 'tiled');

  const angleSlider = $('#watermark-angle-slider');
  const angleValueEl = $('#watermark-angle-value');
  if (angleSlider) angleSlider.value = watermark.angle ?? 0;
  if (angleValueEl) angleValueEl.textContent = `${watermark.angle ?? 0}\u00b0`;

  updateSummary();
}

/* ── Summary text ─────────────────────────────────────────────────── */

function updateSummary() {
  const el = $('#settings-summary');
  if (!el) return;

  const { resize, background, watermark } = state.settings;
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
  if (watermark.enabled && watermark.text.trim()) {
    parts.push('Watermark');
  }

  el.textContent = parts.join(' \u00b7 ');
}

/* ── Segmented control helpers ────────────────────────────────────── */

function initSegmentedControl(container, onChange) {
  const items = container.querySelectorAll('.segmented-control__item');

  items.forEach((item) => {
    item.addEventListener('click', () => {
      // Update visual state
      items.forEach((i) => {
        i.classList.remove('is-active');
        i.setAttribute('aria-checked', 'false');
      });
      item.classList.add('is-active');
      item.setAttribute('aria-checked', 'true');

      onChange(item.dataset.value);
    });

    // Arrow key navigation
    item.addEventListener('keydown', (e) => {
      const arr = [...items];
      const idx = arr.indexOf(item);
      let target = null;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        target = arr[(idx + 1) % arr.length];
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        target = arr[(idx - 1 + arr.length) % arr.length];
      }

      if (target) {
        e.preventDefault();
        target.focus();
        target.click();
      }
    });
  });

  // Set tabindex for roving tabindex pattern
  items.forEach((item, i) => {
    item.setAttribute('tabindex', item.classList.contains('is-active') ? '0' : '-1');
  });

  // Update tabindex on click
  container.addEventListener('click', () => {
    items.forEach((item) => {
      item.setAttribute('tabindex', item.classList.contains('is-active') ? '0' : '-1');
    });
  });
}

function setSegmentedValue(selector, value) {
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

function setSegmentedDisabled(selector, disabled) {
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

/* ── Utility helpers ──────────────────────────────────────────────── */

function toggleHidden(selector, hidden) {
  const el = $(selector);
  if (el) el.classList.toggle('is-hidden', hidden);
}

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

/**
 * Build FormData with current settings for processing.
 * @param {FormData} formData
 */
export function appendSettingsToFormData(formData) {
  const settings = getSettings();
  const effectiveSettings = {
    ...settings,
    compress: getEffectiveCompressSettings(settings),
  };
  Object.entries(tools).forEach(([key, tool]) => {
    tool.toFormData(effectiveSettings[key], formData);
  });
}
