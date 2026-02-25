/**
 * Settings: inline panel with segmented controls, quality slider, immediate apply.
 * Replaces the old modal-based settings system.
 */
import { $, $$ } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import * as storage from '../lib/storage.js';
import { state, updateSettings, getSettings } from '../state/app-state.js';

/* ── Constants ────────────────────────────────────────────────────── */

const PANEL_EXPANDED_KEY = 'compressify_panel_expanded';

const MODE_HINTS = {
  lossless: 'Highest quality, preserves original format',
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
  const panel = $('#settings-panel');
  if (!panel) return;

  initToggle(panel);
  initCompressionMode();
  initQualitySlider();
  initFormatControl();
  initResizeMode();
  initPresets();
  initAspectRatio();
  initWatermark();
  initPanelPositioning();

  // Apply persisted state to controls
  syncControlsFromState();

  // Listen for external state changes
  bus.on('settings:changed', () => updateSummary());
}

/* ── Panel toggle ─────────────────────────────────────────────────── */

function initToggle(panel) {
  const toggle = $('#settings-toggle');
  if (!toggle) return;

  // Restore persisted preference
  const savedExpanded = storage.getItem(PANEL_EXPANDED_KEY);
  if (savedExpanded === false) {
    panel.classList.remove('is-expanded');
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isExpanded = panel.classList.toggle('is-expanded');
    toggle.setAttribute('aria-expanded', String(isExpanded));
    storage.setItem(PANEL_EXPANDED_KEY, isExpanded);
  });
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

  let aspectRatio = null;
  let updating = false;

  const syncOther = (changed, other) => {
    if (!aspectRatio || updating) return;
    updating = true;
    const val = parseInt(changed.value, 10);
    if (!isNaN(val)) {
      other.value = changed === widthInput
        ? Math.round(val / aspectRatio)
        : Math.round(val * aspectRatio);
    }
    updating = false;
  };

  widthInput.addEventListener('input', () => {
    if (!aspectRatio && heightInput.value) {
      aspectRatio = parseInt(widthInput.value, 10) / parseInt(heightInput.value, 10);
    }
    syncOther(widthInput, heightInput);
  });

  heightInput.addEventListener('input', () => {
    if (!aspectRatio && widthInput.value) {
      aspectRatio = parseInt(widthInput.value, 10) / parseInt(heightInput.value, 10);
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

/* ── Panel positioning ────────────────────────────────────────────── */

function initPanelPositioning() {
  let hadFiles = false;

  bus.on('files:countChanged', ({ total }) => {
    const hasFiles = total > 0;
    // Auto-collapse when files first appear (empty → has files)
    if (hasFiles && !hadFiles) {
      collapsePanel();
    }
    hadFiles = hasFiles;
    positionPanel(hasFiles);
  });
}

function collapsePanel() {
  const panel = $('#settings-panel');
  const toggle = $('#settings-toggle');
  if (panel) panel.classList.remove('is-expanded');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function positionPanel(hasFiles) {
  const panel = $('#settings-panel');
  if (!panel) return;

  const emptyState = $('#workspace-empty');
  const toolbar = $('#workspace-toolbar');
  const workspace = $('.workspace');

  if (hasFiles && toolbar && workspace) {
    // Move panel after toolbar
    toolbar.after(panel);
  } else if (!hasFiles && emptyState) {
    // Move panel back into empty state, before the formats text
    const formats = emptyState.querySelector('.workspace__empty-formats');
    if (formats) {
      emptyState.insertBefore(panel, formats);
    } else {
      emptyState.appendChild(panel);
    }
  }
}

/* ── Sync controls from persisted state ───────────────────────────── */

function syncControlsFromState() {
  const { compress, resize, watermark } = state.settings;

  // Compression mode
  setSegmentedValue('#compression-mode-control', compress.mode);
  const hint = $('#compression-hint');
  if (hint) hint.textContent = MODE_HINTS[compress.mode] || '';

  const isLossless = compress.mode === 'lossless';
  const hideQuality = isLossless || compress.outputFormat === 'png';
  toggleHidden('#quality-slider-group', hideQuality);

  // Format
  setSegmentedValue('#format-control', compress.outputFormat || 'auto');

  // Quality
  if (!hideQuality) {
    const q = compress.quality ?? getDefaultQuality(compress.mode, compress.outputFormat || 'auto');
    syncSliderValue(q);
  }

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

  const { compress, resize, watermark } = state.settings;
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
  Object.entries(tools).forEach(([key, tool]) => {
    tool.toFormData(settings[key], formData);
  });
}
