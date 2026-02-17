/**
 * Reactive state store using Proxy.
 * Emits change events on the event bus when state is modified.
 */
import { bus } from '../lib/events.js';
import * as storage from '../lib/storage.js';

const STORAGE_KEY = 'compressify_settings';

const defaultState = {
  // Settings (persisted)
  settings: {
    compress: { mode: 'lossless', outputFormat: 'auto', quality: null },
    resize: { mode: 'original', width: null, height: null },
    watermark: { enabled: false, text: '', position: 'bottom-right', opacity: 50, color: 'white', size: 5, tileDensity: 5 },
  },

  // Files (runtime only)
  files: new Map(),          // fileId → { file, status, blobUrl, processedData, processedWithSettings }

  // UI state
  processing: false,
  batchProgress: { processed: 0, total: 0, startTime: null },
};

function createState() {
  // Load persisted settings
  const savedSettings = storage.getItem(STORAGE_KEY);
  if (savedSettings) {
    defaultState.settings = {
      ...defaultState.settings,
      ...savedSettings,
      compress: { ...defaultState.settings.compress, ...(savedSettings.compress || {}) },
      resize: { ...defaultState.settings.resize, ...(savedSettings.resize || {}) },
      watermark: { ...defaultState.settings.watermark, ...(savedSettings.watermark || {}) },
    };
  }

  return defaultState;
}

export const state = createState();

/**
 * Update settings and persist to localStorage.
 * @param {string} tool - 'compress' or 'resize'
 * @param {Object} values
 */
export function updateSettings(tool, values) {
  state.settings[tool] = { ...state.settings[tool], ...values };
  storage.setItem(STORAGE_KEY, state.settings);
  bus.emit('settings:changed', { tool, settings: state.settings[tool] });
}

/**
 * Get current settings.
 */
export function getSettings() {
  return state.settings;
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
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
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
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  }
  state.files.clear();
  bus.emit('files:cleared');
  bus.emit('files:countChanged', { total: 0 });
}
