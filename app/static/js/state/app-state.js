/**
 * Reactive state store using Proxy.
 * Emits change events on the event bus when state is modified.
 */
import { bus } from '../lib/events.js';
import * as storage from '../lib/storage.js';

const STORAGE_KEY = 'compressify_settings';
export const WATERMARK_LAYER_KEYS = ['text', 'logo', 'qr'];

const defaultWatermarkLayer = {
  enabled: false,
  position: 'bottom-right',
  opacity: 50,
  size: 5,
  angle: 0,
  tileDensity: 5,
};

const defaultSettings = {
  workflow: { mode: 'optimize' },
  aiUpscale: { modelPreset: 'photo', scale: 2, outputFormat: 'png', quality: null },
  compress: { mode: 'lossless', outputFormat: 'auto', quality: null },
  resize: { mode: 'original', width: null, height: null, locked: false },
  background: { enabled: false },
  watermark: {
    enabled: false,
    text: { ...defaultWatermarkLayer, value: '', color: 'white' },
    logo: { ...defaultWatermarkLayer },
    qr: { ...defaultWatermarkLayer, url: '' },
  },
};

function cloneDefaultWatermarkSettings() {
  return {
    enabled: defaultSettings.watermark.enabled,
    text: { ...defaultSettings.watermark.text },
    logo: { ...defaultSettings.watermark.logo },
    qr: { ...defaultSettings.watermark.qr },
  };
}

function cloneDefaultSettings() {
  return {
    workflow: { ...defaultSettings.workflow },
    aiUpscale: { ...defaultSettings.aiUpscale },
    compress: { ...defaultSettings.compress },
    resize: { ...defaultSettings.resize },
    background: { ...defaultSettings.background },
    watermark: cloneDefaultWatermarkSettings(),
  };
}

function createDefaultState() {
  return {
    settings: cloneDefaultSettings(),
    files: new Map(),          // fileId → { file, status, blobUrl, processedData, processedWithSettings }
    ui: {
      watermarkPreviewFileId: null,
      watermarkActiveTab: null,
    },
    runtime: {
      watermarkLogo: null,
      watermarkQr: null,
    },
    processing: false,
    batchProgress: { processed: 0, total: 0, startTime: null },
  };
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep(target, updates) {
  if (!isPlainObject(target) || !isPlainObject(updates)) {
    return updates;
  }

  const next = { ...target };

  for (const [key, value] of Object.entries(updates)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      next[key] = mergeDeep(target[key], value);
    } else {
      next[key] = value;
    }
  }

  return next;
}

function getLegacyWatermarkTransform(savedWatermark = {}) {
  return {
    position: savedWatermark.position ?? defaultWatermarkLayer.position,
    opacity: savedWatermark.opacity ?? defaultWatermarkLayer.opacity,
    size: savedWatermark.size ?? defaultWatermarkLayer.size,
    angle: savedWatermark.angle ?? defaultWatermarkLayer.angle,
    tileDensity: savedWatermark.tileDensity ?? defaultWatermarkLayer.tileDensity,
  };
}

function migrateResizeSettings(savedResize = {}) {
  const resize = {
    ...defaultSettings.resize,
    ...(savedResize || {}),
  };

  if (typeof savedResize?.locked !== 'boolean') {
    resize.locked = Boolean(savedResize?.width && savedResize?.height);
  }

  return resize;
}

function migrateWatermarkSettings(savedWatermark = {}) {
  const watermark = cloneDefaultWatermarkSettings();
  const legacySharedTransform = getLegacyWatermarkTransform(savedWatermark);
  const legacyText = typeof savedWatermark.text === 'string'
    ? savedWatermark.text
    : savedWatermark.text?.value ?? '';
  const legacyTextColor = typeof savedWatermark.color === 'string'
    ? savedWatermark.color
    : savedWatermark.text?.color ?? defaultSettings.watermark.text.color;

  watermark.enabled = Boolean(savedWatermark.enabled);

  watermark.text = {
    ...defaultSettings.watermark.text,
    ...legacySharedTransform,
    ...(isPlainObject(savedWatermark.text) ? savedWatermark.text : {}),
    value: legacyText,
    enabled: isPlainObject(savedWatermark.text)
      ? savedWatermark.text.enabled ?? Boolean(legacyText)
      : Boolean(legacyText),
    color: legacyTextColor,
  };

  watermark.logo = {
    ...defaultSettings.watermark.logo,
    ...legacySharedTransform,
    ...(isPlainObject(savedWatermark.logo) ? savedWatermark.logo : {}),
  };

  watermark.qr = {
    ...defaultSettings.watermark.qr,
    ...legacySharedTransform,
    ...(isPlainObject(savedWatermark.qr) ? savedWatermark.qr : {}),
    url: savedWatermark.qr?.url ?? defaultSettings.watermark.qr.url,
  };

  return watermark;
}

function getNormalizedLayerTransform(layerSettings, defaults) {
  return {
    position: layerSettings?.position ?? defaults.position,
    opacity: layerSettings?.opacity ?? defaults.opacity,
    size: layerSettings?.size ?? defaults.size,
    angle: layerSettings?.angle ?? defaults.angle,
    tileDensity: layerSettings?.tileDensity ?? defaults.tileDensity,
  };
}

function getTextLayerStatus(watermark, runtime) {
  const layer = watermark?.text ?? defaultSettings.watermark.text;
  const value = (layer.value || '').trim();

  if (!layer.enabled) {
    return { label: 'Off', tone: 'off', message: null };
  }

  if (!value) {
    return {
      label: 'Invalid',
      tone: 'invalid',
      message: 'Enter watermark text to enable this layer.',
    };
  }

  return { label: 'Ready', tone: 'ready', message: null };
}

function getLogoLayerStatus(watermark, runtime) {
  const layer = watermark?.logo ?? defaultSettings.watermark.logo;

  if (!layer.enabled) {
    return { label: 'Off', tone: 'off', message: null };
  }

  if (!runtime?.watermarkLogo?.file) {
    return {
      label: 'Needs file',
      tone: 'pending',
      message: 'Upload a PNG logo to enable this layer.',
    };
  }

  return { label: 'Ready', tone: 'ready', message: null };
}

function getQrLayerStatus(watermark, runtime) {
  const layer = watermark?.qr ?? defaultSettings.watermark.qr;
  const value = (layer.url || '').trim();

  if (!layer.enabled) {
    return { label: 'Off', tone: 'off', message: null };
  }

  if (!value) {
    return {
      label: 'Needs URL',
      tone: 'pending',
      message: 'Enter an absolute http:// or https:// URL.',
    };
  }

  if (runtime?.watermarkQr?.error) {
    return {
      label: 'Invalid',
      tone: 'invalid',
      message: runtime.watermarkQr.error,
    };
  }

  return { label: 'Ready', tone: 'ready', message: null };
}

export function getWatermarkLayerStatus(layerKey, watermark = state.settings.watermark, runtime = state.runtime) {
  if (layerKey === 'text') return getTextLayerStatus(watermark, runtime);
  if (layerKey === 'logo') return getLogoLayerStatus(watermark, runtime);
  if (layerKey === 'qr') return getQrLayerStatus(watermark, runtime);
  return { label: 'Off', tone: 'off', message: null };
}

function getActiveWatermark(watermark = state.settings.watermark, runtime = state.runtime) {
  const masterEnabled = Boolean(watermark?.enabled);
  const textSettings = watermark?.text ?? defaultSettings.watermark.text;
  const logoSettings = watermark?.logo ?? defaultSettings.watermark.logo;
  const qrSettings = watermark?.qr ?? defaultSettings.watermark.qr;

  const textValue = (textSettings.value || '').trim();
  const qrUrl = (qrSettings.url || '').trim();

  const textEnabled = Boolean(masterEnabled && textSettings.enabled && textValue);
  const logoEnabled = Boolean(masterEnabled && logoSettings.enabled && runtime?.watermarkLogo?.file);
  const qrEnabled = Boolean(masterEnabled && qrSettings.enabled && qrUrl && runtime?.watermarkQr?.blob && !runtime?.watermarkQr?.error);

  const layers = [];
  if (textEnabled) layers.push('text');
  if (logoEnabled) layers.push('logo');
  if (qrEnabled) layers.push('qr');

  return {
    enabled: masterEnabled && layers.length > 0,
    layers,
    text: {
      enabled: textEnabled,
      value: textValue,
      color: textSettings.color ?? defaultSettings.watermark.text.color,
      ...getNormalizedLayerTransform(textSettings, defaultSettings.watermark.text),
    },
    logo: {
      enabled: logoEnabled,
      ...getNormalizedLayerTransform(logoSettings, defaultSettings.watermark.logo),
      fingerprint: logoEnabled
        ? {
            name: runtime.watermarkLogo.name,
            size: runtime.watermarkLogo.size,
            lastModified: runtime.watermarkLogo.lastModified,
          }
        : null,
    },
    qr: {
      enabled: qrEnabled,
      url: qrEnabled ? qrUrl : '',
      error: runtime?.watermarkQr?.error || null,
      ...getNormalizedLayerTransform(qrSettings, defaultSettings.watermark.qr),
    },
  };
}

function revokeObjectUrl(url) {
  if (url) URL.revokeObjectURL(url);
}

function createState() {
  const defaultState = createDefaultState();

  const savedSettings = storage.getItem(STORAGE_KEY);
  if (savedSettings) {
    defaultState.settings = {
      ...defaultState.settings,
      ...savedSettings,
      workflow: { ...defaultState.settings.workflow, ...(savedSettings.workflow || {}) },
      aiUpscale: { ...defaultState.settings.aiUpscale, ...(savedSettings.aiUpscale || {}) },
      compress: { ...defaultState.settings.compress, ...(savedSettings.compress || {}) },
      resize: migrateResizeSettings(savedSettings.resize || {}),
      background: { ...defaultState.settings.background, ...(savedSettings.background || {}) },
      watermark: migrateWatermarkSettings(savedSettings.watermark || {}),
    };
  }

  return defaultState;
}

export const state = createState();

/**
 * Update settings and persist to localStorage.
 * @param {string} tool - tool key from settings
 * @param {Object} values
 */
export function updateSettings(tool, values) {
  state.settings[tool] = mergeDeep(state.settings[tool], values);
  storage.setItem(STORAGE_KEY, state.settings);
  bus.emit('settings:changed', { tool, settings: state.settings[tool] });
}

/**
 * Get current settings.
 */
export function getSettings() {
  return state.settings;
}

export function getEffectiveWatermarkState() {
  return getActiveWatermark();
}

export function getProcessingSnapshot() {
  const workflowMode = state.settings.workflow?.mode || 'optimize';
  if (workflowMode === 'ai-upscale') {
    const aiUpscale = state.settings.aiUpscale || defaultSettings.aiUpscale;
    return {
      workflow: { mode: 'ai-upscale' },
      aiUpscale: {
        modelPreset: aiUpscale.modelPreset ?? defaultSettings.aiUpscale.modelPreset,
        scale: aiUpscale.scale ?? defaultSettings.aiUpscale.scale,
        outputFormat: aiUpscale.outputFormat ?? defaultSettings.aiUpscale.outputFormat,
        quality: aiUpscale.outputFormat === 'png' ? null : aiUpscale.quality ?? defaultSettings.aiUpscale.quality,
      },
    };
  }

  const watermark = getActiveWatermark();

  return {
    workflow: { mode: 'optimize' },
    compress: { ...state.settings.compress },
    resize: {
      mode: state.settings.resize.mode,
      width: state.settings.resize.width,
      height: state.settings.resize.height,
    },
    background: { ...state.settings.background },
    watermark: {
      enabled: watermark.enabled,
      layers: [...watermark.layers],
      text: watermark.text.enabled ? {
        value: watermark.text.value,
        color: watermark.text.color,
        position: watermark.text.position,
        opacity: watermark.text.opacity,
        size: watermark.text.size,
        angle: watermark.text.angle,
        tileDensity: watermark.text.tileDensity,
      } : null,
      logo: watermark.logo.enabled ? {
        ...watermark.logo.fingerprint,
        position: watermark.logo.position,
        opacity: watermark.logo.opacity,
        size: watermark.logo.size,
        angle: watermark.logo.angle,
        tileDensity: watermark.logo.tileDensity,
      } : null,
      qr: watermark.qr.enabled ? {
        url: watermark.qr.url,
        position: watermark.qr.position,
        opacity: watermark.qr.opacity,
        size: watermark.qr.size,
        angle: watermark.qr.angle,
        tileDensity: watermark.qr.tileDensity,
      } : null,
    },
  };
}

export function setWatermarkPreviewFileId(fileId) {
  state.ui.watermarkPreviewFileId = fileId || null;
  bus.emit('watermark:previewFileChanged', { fileId: state.ui.watermarkPreviewFileId });
}

export function setWatermarkActiveTab(layerKey) {
  state.ui.watermarkActiveTab = WATERMARK_LAYER_KEYS.includes(layerKey) ? layerKey : 'text';
  bus.emit('watermark:activeTabChanged', { layer: state.ui.watermarkActiveTab });
}

export function setWatermarkLogoAsset(asset) {
  revokeObjectUrl(state.runtime.watermarkLogo?.objectUrl);
  state.runtime.watermarkLogo = asset ? { ...asset } : null;
  bus.emit('watermark:logoChanged', {
    asset: state.runtime.watermarkLogo
      ? {
          name: state.runtime.watermarkLogo.name,
          size: state.runtime.watermarkLogo.size,
          lastModified: state.runtime.watermarkLogo.lastModified,
        }
      : null,
  });
}

export function setWatermarkQrAsset(asset) {
  revokeObjectUrl(state.runtime.watermarkQr?.objectUrl);
  state.runtime.watermarkQr = asset ? { ...asset } : null;
  bus.emit('watermark:qrChanged', {
    asset: state.runtime.watermarkQr
      ? {
          url: state.runtime.watermarkQr.url,
          error: state.runtime.watermarkQr.error || null,
          hasBlob: Boolean(state.runtime.watermarkQr.blob),
        }
      : null,
  });
}

/**
 * Add a file to state.
 * @param {string} fileId
 * @param {File} file
 * @param {string} blobUrl - preview blob URL
 */
export function addFile(fileId, file, blobUrl) {
  state.files.set(fileId, {
    file,
    status: 'pending',       // pending | processing | done | error | cancelled
    blobUrl,
    processedData: null,     // { data, filename, metadata }
    processedWithSettings: null,
    upscaleJob: null,
    artifactRefs: null,
    errorMessage: null,
  });
  bus.emit('files:added', { fileId });
  bus.emit('files:countChanged', { total: state.files.size });
}

/**
 * Remove a file from state and clean up its blob URL.
 */
export function removeFile(fileId) {
  const entry = state.files.get(fileId);
  if (entry) {
    if (entry.blobUrl?.startsWith?.('blob:')) URL.revokeObjectURL(entry.blobUrl);
    state.files.delete(fileId);
    bus.emit('files:removed', { fileId });
    bus.emit('files:countChanged', { total: state.files.size });
  }
}

/**
 * Update a file's status and data.
 */
export function updateFile(fileId, updates) {
  const entry = state.files.get(fileId);
  if (entry) {
    Object.assign(entry, updates);
    bus.emit('file:updated', { fileId, ...updates });
  }
}

/**
 * Clear all files from state and revoke blob URLs.
 */
export function clearAllFiles() {
  for (const entry of state.files.values()) {
    if (entry.blobUrl?.startsWith?.('blob:')) URL.revokeObjectURL(entry.blobUrl);
  }
  state.files.clear();
  setWatermarkPreviewFileId(null);
  bus.emit('files:cleared');
  bus.emit('files:countChanged', { total: 0 });
}
