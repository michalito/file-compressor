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
    compress: { mode: 'lossless', outputFormat: 'auto' },
    resize: { mode: 'original', width: null, height: null, maintainAspectRatio: true },
  },

  // Files (runtime only)
  files: new Map(),          // fileId → { file, status, blobUrl, processedData }
  selectedFiles: new Set(),  // Set of fileIds

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
    status: 'pending',       // pending | processing | done | error
    blobUrl,
    processedData: null,     // { data, filename, metadata }
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
    state.selectedFiles.delete(fileId);
    bus.emit('files:removed', { fileId });
    bus.emit('files:countChanged', { total: state.files.size });
    bus.emit('selection:changed', { selected: state.selectedFiles.size });
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
 * Toggle file selection.
 */
export function toggleFileSelection(fileId, selected) {
  if (selected) {
    state.selectedFiles.add(fileId);
  } else {
    state.selectedFiles.delete(fileId);
  }
  bus.emit('selection:changed', { selected: state.selectedFiles.size, total: state.files.size });
}

/**
 * Select/deselect all files.
 */
export function selectAll(selected) {
  if (selected) {
    for (const fileId of state.files.keys()) {
      state.selectedFiles.add(fileId);
    }
  } else {
    state.selectedFiles.clear();
  }
  bus.emit('selection:changed', { selected: state.selectedFiles.size, total: state.files.size });
}
