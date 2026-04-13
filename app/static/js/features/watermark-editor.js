import { $, $$ } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { showToast } from '../components/toast.js';
import {
  state,
  updateSettings,
  getEffectiveWatermarkState,
  getWatermarkLayerStatus,
  setWatermarkLogoAsset,
  setWatermarkQrAsset,
  setWatermarkActiveTab,
  WATERMARK_LAYER_KEYS,
} from '../state/app-state.js';
import {
  validateWatermarkQrUrl,
  generateWatermarkQrBlob,
} from '../lib/watermark.js';
import {
  initSegmentedControl,
  setSegmentedValue,
  toggleHidden,
} from '../lib/form-controls.js';

const MAX_WATERMARK_LOGO_SIZE = 5 * 1024 * 1024;
const SLIDER_COMMIT_DELAY_MS = 80;

/* ── Position Grid helpers ──────────────────────────────────── */

function initPositionGrid(container, onChange) {
  const cells = [...container.querySelectorAll('.watermark-position__cell--active')];

  function selectPosition(value) {
    cells.forEach(btn => {
      const match = btn.dataset.value === value;
      btn.classList.toggle('is-selected', match);
      btn.setAttribute('aria-checked', String(match));
    });
    onChange(value);
  }

  cells.forEach(btn => {
    btn.addEventListener('click', () => selectPosition(btn.dataset.value));
  });

  // Arrow-key navigation cycles through all 6 position options
  cells.forEach((btn, idx) => {
    btn.addEventListener('keydown', (event) => {
      let next = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        next = cells[(idx + 1) % cells.length];
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        next = cells[(idx - 1 + cells.length) % cells.length];
      }
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.click();
    });
  });
}

function setPositionGridValue(selector, value) {
  const container = $(selector);
  if (!container) return;

  container.querySelectorAll('.watermark-position__cell--active').forEach(btn => {
    const match = btn.dataset.value === value;
    btn.classList.toggle('is-selected', match);
    btn.setAttribute('aria-checked', String(match));
  });
}

/* ── Logo Drop Zone ─────────────────────────────────────────── */

function initLogoDropZone() {
  const dropzone = $('#watermark-logo-dropzone');
  const fileInput = $('#watermark-logo-file');
  if (!dropzone || !fileInput) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('is-dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('is-dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;

    if (file.type !== 'image/png') {
      showToast({ message: 'Watermark logo must be a PNG image.', type: 'warning' });
      return;
    }

    if (file.size > MAX_WATERMARK_LOGO_SIZE) {
      showToast({ message: 'Watermark logo must be 5 MB or smaller.', type: 'warning' });
      return;
    }

    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/* ── Config ─────────────────────────────────────────────────── */

const WATERMARK_LAYER_CONFIG = {
  text: {
    tab: '#watermark-tab-text',
    status: '#watermark-tab-text-status',
    panel: '#watermark-panel-text',
    toggle: '#watermark-text-toggle',
    message: '#watermark-text-message',
    positionControl: '#watermark-text-position-control',
    opacitySlider: '#watermark-text-opacity-slider',
    opacityValue: '#watermark-text-opacity-value',
    sizeSlider: '#watermark-text-size-slider',
    sizeValue: '#watermark-text-size-value',
    densityGroup: '#watermark-text-density-group',
    densitySlider: '#watermark-text-density-slider',
    densityValue: '#watermark-text-density-value',
    angleSlider: '#watermark-text-angle-slider',
    angleValue: '#watermark-text-angle-value',
  },
  logo: {
    tab: '#watermark-tab-logo',
    status: '#watermark-tab-logo-status',
    panel: '#watermark-panel-logo',
    toggle: '#watermark-logo-toggle',
    message: '#watermark-logo-message',
    positionControl: '#watermark-logo-position-control',
    opacitySlider: '#watermark-logo-opacity-slider',
    opacityValue: '#watermark-logo-opacity-value',
    sizeSlider: '#watermark-logo-size-slider',
    sizeValue: '#watermark-logo-size-value',
    densityGroup: '#watermark-logo-density-group',
    densitySlider: '#watermark-logo-density-slider',
    densityValue: '#watermark-logo-density-value',
    angleSlider: '#watermark-logo-angle-slider',
    angleValue: '#watermark-logo-angle-value',
  },
  qr: {
    tab: '#watermark-tab-qr',
    status: '#watermark-tab-qr-status',
    panel: '#watermark-panel-qr',
    toggle: '#watermark-qr-toggle',
    message: '#watermark-qr-error',
    positionControl: '#watermark-qr-position-control',
    opacitySlider: '#watermark-qr-opacity-slider',
    opacityValue: '#watermark-qr-opacity-value',
    sizeSlider: '#watermark-qr-size-slider',
    sizeValue: '#watermark-qr-size-value',
    densityGroup: '#watermark-qr-density-group',
    densitySlider: '#watermark-qr-density-slider',
    densityValue: '#watermark-qr-density-value',
    angleSlider: '#watermark-qr-angle-slider',
    angleValue: '#watermark-qr-angle-value',
  },
};

let qrGeneration = 0;
let busListenersBound = false;
const pendingSliderUpdates = new Map();

function getSliderUpdateKey(layerKey, field) {
  return `${layerKey}:${field}`;
}

function commitWatermarkLayerValue(layerKey, field, value) {
  if (state.settings.watermark?.[layerKey]?.[field] === value) {
    return;
  }

  updateSettings('watermark', { [layerKey]: { [field]: value } });
}

function scheduleWatermarkLayerValue(layerKey, field, value) {
  const key = getSliderUpdateKey(layerKey, field);
  const previous = pendingSliderUpdates.get(key);
  if (previous?.timerId) {
    window.clearTimeout(previous.timerId);
  }

  const timerId = window.setTimeout(() => {
    pendingSliderUpdates.delete(key);
    commitWatermarkLayerValue(layerKey, field, value);
  }, SLIDER_COMMIT_DELAY_MS);

  pendingSliderUpdates.set(key, { layerKey, field, value, timerId });
}

function flushWatermarkLayerValue(layerKey, field, fallbackValue) {
  const key = getSliderUpdateKey(layerKey, field);
  const pending = pendingSliderUpdates.get(key);

  if (pending?.timerId) {
    window.clearTimeout(pending.timerId);
  }

  pendingSliderUpdates.delete(key);
  commitWatermarkLayerValue(layerKey, field, pending?.value ?? fallbackValue);
}

export function flushPendingWatermarkEditorUpdates() {
  const pendingUpdates = [...pendingSliderUpdates.values()];
  pendingSliderUpdates.clear();

  pendingUpdates.forEach(({ layerKey, field, value, timerId }) => {
    if (timerId) {
      window.clearTimeout(timerId);
    }
    commitWatermarkLayerValue(layerKey, field, value);
  });
}

function setWatermarkBodyVisibility(enabled) {
  const body = $('#watermark-body');
  if (body) body.classList.toggle('is-hidden', !enabled);
}

function getWatermarkLayerSettings(layerKey) {
  return state.settings.watermark?.[layerKey] || {};
}

function getPreferredWatermarkTab() {
  if (WATERMARK_LAYER_KEYS.includes(state.ui.watermarkActiveTab)) {
    return state.ui.watermarkActiveTab;
  }

  return WATERMARK_LAYER_KEYS.find((layerKey) => state.settings.watermark?.[layerKey]?.enabled) || 'text';
}

function syncWatermarkTabs(activeLayer = getPreferredWatermarkTab()) {
  const resolvedLayer = WATERMARK_LAYER_KEYS.includes(activeLayer) ? activeLayer : getPreferredWatermarkTab();

  WATERMARK_LAYER_KEYS.forEach((layerKey) => {
    const config = WATERMARK_LAYER_CONFIG[layerKey];
    const tab = $(config.tab);
    const panel = $(config.panel);
    const isActive = layerKey === resolvedLayer;

    if (tab) {
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
      tab.setAttribute('tabindex', isActive ? '0' : '-1');
    }

    if (panel) {
      panel.classList.toggle('is-active', isActive);
      panel.hidden = !isActive;
    }
  });
}

function updateWatermarkLayerMessage(layerKey, message) {
  const el = $(WATERMARK_LAYER_CONFIG[layerKey].message);
  if (!el) return;

  el.textContent = message || '';
  el.classList.toggle('is-hidden', !message);
}

export async function ensureWatermarkQrAsset() {
  const value = (state.settings.watermark.qr?.url || '').trim();

  if (!value) {
    qrGeneration += 1;
    setWatermarkQrAsset(null);
    return;
  }

  const validation = validateWatermarkQrUrl(value);
  if (!validation.valid) {
    qrGeneration += 1;
    setWatermarkQrAsset({ url: value, blob: null, objectUrl: null, error: validation.error });
    return;
  }

  if (
    state.runtime.watermarkQr?.url === validation.url &&
    state.runtime.watermarkQr?.blob &&
    !state.runtime.watermarkQr?.error
  ) {
    return;
  }

  const currentGeneration = ++qrGeneration;

  try {
    const blob = await generateWatermarkQrBlob(validation.url);
    if (currentGeneration !== qrGeneration) return;

    setWatermarkQrAsset({
      url: validation.url,
      blob,
      objectUrl: URL.createObjectURL(blob),
      error: null,
    });
  } catch (error) {
    if (currentGeneration !== qrGeneration) return;

    console.error('Failed to generate QR watermark:', error);
    setWatermarkQrAsset({
      url: validation.url,
      blob: null,
      objectUrl: null,
      error: 'Failed to generate QR code image.',
    });
  }
}

function syncWatermarkLogoMeta() {
  const chip = $('#watermark-logo-filename');
  const dropzone = $('#watermark-logo-dropzone');
  const fileDisplay = $('#watermark-logo-file-display');
  const asset = state.runtime.watermarkLogo;

  if (chip) {
    chip.textContent = asset ? asset.name : '';
  }

  if (dropzone) dropzone.classList.toggle('is-hidden', Boolean(asset));
  if (fileDisplay) fileDisplay.classList.toggle('is-hidden', !asset);
}

function syncWatermarkLayerTransforms(layerKey) {
  const config = WATERMARK_LAYER_CONFIG[layerKey];
  const layer = getWatermarkLayerSettings(layerKey);
  const position = layer.position || 'bottom-right';
  const opacity = layer.opacity ?? 50;
  const size = layer.size ?? 5;
  const tileDensity = layer.tileDensity ?? 5;
  const angle = layer.angle ?? 0;

  setPositionGridValue(config.positionControl, position);
  toggleHidden(config.densityGroup, position !== 'tiled');

  const opacitySlider = $(config.opacitySlider);
  const opacityValue = $(config.opacityValue);
  if (opacitySlider) opacitySlider.value = opacity;
  if (opacityValue) opacityValue.textContent = `${opacity}%`;

  const sizeSlider = $(config.sizeSlider);
  const sizeValue = $(config.sizeValue);
  if (sizeSlider) sizeSlider.value = size;
  if (sizeValue) sizeValue.textContent = `${size}`;

  const densitySlider = $(config.densitySlider);
  const densityValue = $(config.densityValue);
  if (densitySlider) densitySlider.value = tileDensity;
  if (densityValue) densityValue.textContent = `${tileDensity}`;

  const angleSlider = $(config.angleSlider);
  const angleValue = $(config.angleValue);
  if (angleSlider) angleSlider.value = angle;
  if (angleValue) angleValue.textContent = `${angle}\u00b0`;
}

function syncWatermarkLayerStatus(layerKey) {
  const status = getWatermarkLayerStatus(layerKey);
  const statusEl = $(WATERMARK_LAYER_CONFIG[layerKey].status);

  if (statusEl) {
    const srSpan = statusEl.querySelector('.sr-only');
    if (srSpan) srSpan.textContent = status.label;
    statusEl.dataset.tone = status.tone;
    statusEl.title = status.label;
  }

  updateWatermarkLayerMessage(layerKey, status.message);
}

export function syncWatermarkEditor() {
  const watermark = state.settings.watermark;
  const wmToggle = $('#watermark-toggle');
  const textToggle = $('#watermark-text-toggle');
  const textInput = $('#watermark-text');
  const logoToggle = $('#watermark-logo-toggle');
  const qrToggle = $('#watermark-qr-toggle');
  const qrInput = $('#watermark-qr-url');

  if (wmToggle) wmToggle.checked = Boolean(watermark.enabled);
  setWatermarkBodyVisibility(watermark.enabled);

  if (textToggle) textToggle.checked = Boolean(watermark.text?.enabled);
  if (textInput) textInput.value = watermark.text?.value || '';
  if (logoToggle) logoToggle.checked = Boolean(watermark.logo?.enabled);
  if (qrToggle) qrToggle.checked = Boolean(watermark.qr?.enabled);
  if (qrInput) qrInput.value = watermark.qr?.url || '';

  setSegmentedValue('#watermark-text-color-control', watermark.text?.color || 'white');
  syncWatermarkLogoMeta();

  WATERMARK_LAYER_KEYS.forEach((layerKey) => {
    syncWatermarkLayerTransforms(layerKey);
    syncWatermarkLayerStatus(layerKey);
  });

  syncWatermarkTabs();
}

function initWatermarkTabs() {
  const tabs = $$('#watermark-tabs [role="tab"]');
  if (!tabs.length) return;

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      setWatermarkActiveTab(tab.dataset.layer || 'text');
    });

    tab.addEventListener('keydown', (event) => {
      const currentIndex = tabs.indexOf(tab);
      let targetIndex = null;

      if (event.key === 'ArrowRight') targetIndex = (currentIndex + 1) % tabs.length;
      if (event.key === 'ArrowLeft') targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') targetIndex = 0;
      if (event.key === 'End') targetIndex = tabs.length - 1;

      if (targetIndex == null) return;

      event.preventDefault();
      const nextTab = tabs[targetIndex];
      nextTab.focus();
      setWatermarkActiveTab(nextTab.dataset.layer || 'text');
    });
  });
}

function bindWatermarkLayerTransformControls(layerKey) {
  const config = WATERMARK_LAYER_CONFIG[layerKey];

  const positionControl = $(config.positionControl);
  if (positionControl) {
    initPositionGrid(positionControl, (value) => {
      updateSettings('watermark', { [layerKey]: { position: value } });
      toggleHidden(config.densityGroup, value !== 'tiled');
    });
  }

  const opacitySlider = $(config.opacitySlider);
  const opacityValue = $(config.opacityValue);
  if (opacitySlider) {
    opacitySlider.addEventListener('input', () => {
      if (opacityValue) opacityValue.textContent = `${opacitySlider.value}%`;
      scheduleWatermarkLayerValue(layerKey, 'opacity', parseInt(opacitySlider.value, 10));
    });
    opacitySlider.addEventListener('change', () => {
      flushWatermarkLayerValue(layerKey, 'opacity', parseInt(opacitySlider.value, 10));
    });
  }

  const sizeSlider = $(config.sizeSlider);
  const sizeValue = $(config.sizeValue);
  if (sizeSlider) {
    sizeSlider.addEventListener('input', () => {
      if (sizeValue) sizeValue.textContent = sizeSlider.value;
      scheduleWatermarkLayerValue(layerKey, 'size', parseInt(sizeSlider.value, 10));
    });
    sizeSlider.addEventListener('change', () => {
      flushWatermarkLayerValue(layerKey, 'size', parseInt(sizeSlider.value, 10));
    });
  }

  const densitySlider = $(config.densitySlider);
  const densityValue = $(config.densityValue);
  if (densitySlider) {
    densitySlider.addEventListener('input', () => {
      if (densityValue) densityValue.textContent = densitySlider.value;
      scheduleWatermarkLayerValue(layerKey, 'tileDensity', parseInt(densitySlider.value, 10));
    });
    densitySlider.addEventListener('change', () => {
      flushWatermarkLayerValue(layerKey, 'tileDensity', parseInt(densitySlider.value, 10));
    });
  }

  const angleSlider = $(config.angleSlider);
  const angleValue = $(config.angleValue);
  if (angleSlider) {
    angleSlider.addEventListener('input', () => {
      if (angleValue) angleValue.textContent = `${angleSlider.value}\u00b0`;
      scheduleWatermarkLayerValue(layerKey, 'angle', parseInt(angleSlider.value, 10));
    });
    angleSlider.addEventListener('change', () => {
      flushWatermarkLayerValue(layerKey, 'angle', parseInt(angleSlider.value, 10));
    });
  }
}

function bindWatermarkBusListeners() {
  if (busListenersBound) return;
  busListenersBound = true;

  bus.on('settings:changed', ({ tool }) => {
    if (tool === 'watermark') syncWatermarkEditor();
  });
  bus.on('watermark:logoChanged', () => syncWatermarkEditor());
  bus.on('watermark:qrChanged', () => syncWatermarkEditor());
  bus.on('watermark:activeTabChanged', ({ layer }) => syncWatermarkTabs(layer));
}

export function initWatermarkEditor() {
  const toggle = $('#watermark-toggle');
  const textToggle = $('#watermark-text-toggle');
  const textInput = $('#watermark-text');
  const logoToggle = $('#watermark-logo-toggle');
  const logoFileInput = $('#watermark-logo-file');
  const logoClearBtn = $('#watermark-logo-clear');
  const qrToggle = $('#watermark-qr-toggle');
  const qrInput = $('#watermark-qr-url');
  const textColorControl = $('#watermark-text-color-control');

  if (!toggle) return;

  initWatermarkTabs();
  initLogoDropZone();
  WATERMARK_LAYER_KEYS.forEach(bindWatermarkLayerTransformControls);
  bindWatermarkBusListeners();

  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    setWatermarkBodyVisibility(enabled);
    updateSettings('watermark', { enabled });
  });

  if (textToggle) {
    textToggle.addEventListener('change', () => {
      const enabled = textToggle.checked;
      if (enabled) setWatermarkActiveTab('text');
      updateSettings('watermark', enabled
        ? { enabled: true, text: { enabled: true } }
        : { text: { enabled: false } });
    });
  }

  if (textInput) {
    textInput.addEventListener('input', () => {
      const value = textInput.value;
      updateSettings('watermark', value.trim()
        ? { enabled: true, text: { value, enabled: true } }
        : { text: { value, enabled: false } });
    });
  }

  if (textColorControl) {
    initSegmentedControl(textColorControl, (value) => {
      updateSettings('watermark', { text: { color: value } });
    });
  }

  if (logoToggle) {
    logoToggle.addEventListener('change', () => {
      const enabled = logoToggle.checked;
      if (enabled) setWatermarkActiveTab('logo');
      updateSettings('watermark', enabled
        ? { enabled: true, logo: { enabled: true } }
        : { logo: { enabled: false } });
    });
  }

  if (logoFileInput) {
    logoFileInput.addEventListener('change', () => {
      const file = logoFileInput.files?.[0];
      if (!file) {
        setWatermarkLogoAsset(null);
        updateSettings('watermark', { logo: { enabled: false } });
        return;
      }

      if (file.type !== 'image/png') {
        logoFileInput.value = '';
        showToast({ message: 'Watermark logo must be a PNG image.', type: 'warning' });
        return;
      }

      if (file.size > MAX_WATERMARK_LOGO_SIZE) {
        logoFileInput.value = '';
        showToast({ message: 'Watermark logo must be 5 MB or smaller.', type: 'warning' });
        return;
      }

      setWatermarkLogoAsset({
        file,
        objectUrl: URL.createObjectURL(file),
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      });

      setWatermarkActiveTab('logo');
      updateSettings('watermark', { enabled: true, logo: { enabled: true } });
    });
  }

  if (logoClearBtn) {
    logoClearBtn.addEventListener('click', () => {
      if (logoFileInput) logoFileInput.value = '';
      setWatermarkLogoAsset(null);
      updateSettings('watermark', { logo: { enabled: false } });
    });
  }

  if (qrToggle) {
    qrToggle.addEventListener('change', () => {
      const enabled = qrToggle.checked;
      if (enabled) setWatermarkActiveTab('qr');
      updateSettings('watermark', enabled
        ? { enabled: true, qr: { enabled: true } }
        : { qr: { enabled: false } });
      void ensureWatermarkQrAsset();
    });
  }

  if (qrInput) {
    qrInput.addEventListener('input', () => {
      const value = qrInput.value;
      if (value.trim()) setWatermarkActiveTab('qr');
      updateSettings('watermark', value.trim()
        ? { enabled: true, qr: { url: value, enabled: true } }
        : { qr: { url: value, enabled: false } });
      void ensureWatermarkQrAsset();
    });
  }

  void ensureWatermarkQrAsset();
  syncWatermarkEditor();
}

export async function appendWatermarkSettings(formData) {
  flushPendingWatermarkEditorUpdates();

  const rawQr = state.settings.watermark.qr;
  if (rawQr?.enabled && rawQr.url?.trim() && (!state.runtime.watermarkQr?.blob || state.runtime.watermarkQr?.error)) {
    await ensureWatermarkQrAsset();
  }

  const watermark = getEffectiveWatermarkState();
  if (!watermark.enabled) return;

  if (watermark.text.enabled) {
    formData.append('watermark_text', watermark.text.value);
    formData.append('watermark_text_color', watermark.text.color);
    formData.append('watermark_text_position', watermark.text.position);
    formData.append('watermark_text_opacity', watermark.text.opacity);
    formData.append('watermark_text_size', watermark.text.size);
    formData.append('watermark_text_angle', watermark.text.angle ?? 0);
    if (watermark.text.position === 'tiled') {
      formData.append('watermark_text_tile_density', watermark.text.tileDensity);
    }
  }

  if (watermark.logo.enabled && state.runtime.watermarkLogo?.file) {
    formData.append('watermark_logo', state.runtime.watermarkLogo.file, state.runtime.watermarkLogo.name);
    formData.append('watermark_logo_position', watermark.logo.position);
    formData.append('watermark_logo_opacity', watermark.logo.opacity);
    formData.append('watermark_logo_size', watermark.logo.size);
    formData.append('watermark_logo_angle', watermark.logo.angle ?? 0);
    if (watermark.logo.position === 'tiled') {
      formData.append('watermark_logo_tile_density', watermark.logo.tileDensity);
    }
  }

  if (watermark.qr.enabled && state.runtime.watermarkQr?.blob) {
    formData.append('watermark_qr_url', watermark.qr.url);
    formData.append('watermark_qr_image', state.runtime.watermarkQr.blob, 'watermark-qr.png');
    formData.append('watermark_qr_position', watermark.qr.position);
    formData.append('watermark_qr_opacity', watermark.qr.opacity);
    formData.append('watermark_qr_size', watermark.qr.size);
    formData.append('watermark_qr_angle', watermark.qr.angle ?? 0);
    if (watermark.qr.position === 'tiled') {
      formData.append('watermark_qr_tile_density', watermark.qr.tileDensity);
    }
  }
}
