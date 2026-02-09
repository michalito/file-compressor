/**
 * Image tile: lifecycle (create, update, remove, blob URL management).
 */
import { $, createElement, icon, downloadBlob } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { postForm, postJSON } from '../lib/api.js';
import { state, updateFile, toggleFileSelection, removeFile } from '../state/app-state.js';
import { appendSettingsToFormData } from './settings.js';
import { showToast } from '../components/toast.js';
import { globalProgress } from '../components/progress.js';

/**
 * Create and append an image tile for a file.
 * @param {string} fileId
 * @param {File} file
 * @param {string} blobUrl
 */
export function createImageTile(fileId, file, blobUrl) {
  const template = $('#image-tile-template');
  const grid = $('#image-grid');
  if (!template || !grid) return;

  const clone = template.content.cloneNode(true);
  const tile = clone.querySelector('.tile');

  tile.dataset.fileId = fileId;

  // Set filename (textContent = safe)
  const filenameEl = tile.querySelector('.tile__filename');
  filenameEl.textContent = file.name;

  // Set file size
  tile.querySelector('.tile__file-size').textContent = formatFileSize(file.size);

  // Set preview image
  const img = tile.querySelector('.tile__image');
  img.alt = `Preview of ${file.name}`;

  // Load image to get dimensions
  const tempImg = new Image();
  tempImg.onload = () => {
    img.src = blobUrl;
    tile.querySelector('.tile__dimensions').textContent =
      `${tempImg.naturalWidth} x ${tempImg.naturalHeight}`;
  };
  tempImg.onerror = () => {
    img.src = blobUrl;
    tile.querySelector('.tile__dimensions').textContent = 'Unknown';
  };
  tempImg.src = blobUrl;

  // Checkbox — set accessible label with filename
  const checkbox = tile.querySelector('.tile__select');
  checkbox.setAttribute('aria-label', `Select ${file.name}`);
  checkbox.addEventListener('change', () => {
    toggleFileSelection(fileId, checkbox.checked);
    tile.classList.toggle('is-selected', checkbox.checked);
  });

  // Process button
  const processBtn = tile.querySelector('.tile__process-btn');
  processBtn.addEventListener('click', () => processImage(fileId, tile));

  // Download button
  const downloadBtn = tile.querySelector('.tile__download-btn');
  downloadBtn.addEventListener('click', () => downloadFile(fileId, tile));

  grid.appendChild(clone);
}

/**
 * Process a single image by fileId.
 * Exported so batch.js can delegate per-tile processing here.
 * When called from batch, skipGlobalProgress=true since batch owns the progress bar.
 * @param {string} fileId
 * @param {{ skipGlobalProgress?: boolean }} [options]
 */
export async function processTile(fileId, { skipGlobalProgress = false } = {}) {
  const tile = $(`[data-file-id="${fileId}"]`);
  if (!tile) return;
  return processImage(fileId, tile, skipGlobalProgress);
}

/**
 * Process a single image (internal, needs tile element).
 */
async function processImage(fileId, tile, skipGlobalProgress = false) {
  const entry = state.files.get(fileId);
  if (!entry) return;

  const progressEl = tile.querySelector('.tile__progress');
  const processBtn = tile.querySelector('.tile__process-btn');
  const downloadBtn = tile.querySelector('.tile__download-btn');

  try {
    updateFile(fileId, { status: 'processing' });
    progressEl.classList.remove('is-hidden');
    processBtn.disabled = true;
    if (!skipGlobalProgress) {
      globalProgress.show();
      globalProgress.setIndeterminate();
    }

    const formData = new FormData();
    formData.append('file', entry.file);
    appendSettingsToFormData(formData);

    const response = await postForm('/process', formData);
    const result = await response.json();

    // Store processed data in state
    updateFile(fileId, {
      status: 'done',
      processedData: {
        data: result.compressed_data,
        filename: result.filename,
        metadata: result.metadata,
      },
    });

    // Update tile UI
    downloadBtn.disabled = false;
    updateTileWithResults(tile, result.metadata);

    // Show status badges
    const badges = tile.querySelector('.tile__status-badges');
    badges.innerHTML = '';
    badges.appendChild(createBadge('Compressed', 'success'));
    if (state.settings.resize.mode === 'custom') {
      badges.appendChild(createBadge('Resized', 'info'));
    }

    // Show warnings
    if (result.warnings && result.warnings.length > 0) {
      result.warnings.forEach((w) => showTileWarning(tile, w));
    }
  } catch (error) {
    console.error('Processing error:', error);
    updateFile(fileId, { status: 'error', errorMessage: error.message });
    tile.classList.add('is-error');
    showTileError(tile, `Processing failed: ${error.message}`);
    showToast({ message: `Failed to process ${entry.file.name}`, type: 'error' });
  } finally {
    progressEl.classList.add('is-hidden');
    processBtn.disabled = false;
    if (!skipGlobalProgress) {
      globalProgress.hide();
    }
  }
}

/**
 * Download a processed file.
 */
async function downloadFile(fileId, tile) {
  const entry = state.files.get(fileId);
  if (!entry?.processedData) return;

  try {
    const response = await postJSON('/download', {
      compressed_data: entry.processedData.data,
      filename: entry.processedData.filename,
    });

    const blob = await response.blob();
    downloadBlob(blob, `processed_${entry.processedData.filename}`);
  } catch (error) {
    console.error('Download error:', error);
    showTileError(tile, error.message);
    showToast({ message: `Download failed: ${error.message}`, type: 'error' });
  }
}

/**
 * Update tile UI with processing results.
 */
function updateTileWithResults(tile, metadata) {
  const processedSection = tile.querySelector('.tile__processed');
  processedSection.classList.remove('is-hidden');

  const finalW = metadata.final_dimensions[0];
  const finalH = metadata.final_dimensions[1];

  tile.querySelector('.tile__final-size').textContent = formatFileSize(metadata.compressed_size);
  tile.querySelector('.tile__final-dimensions').textContent = `${finalW} x ${finalH}`;
  tile.querySelector('.tile__final-format').textContent = metadata.format || 'Unknown';

  // Space saved
  const savings = Math.round((1 - metadata.compressed_size / metadata.original_size) * 100);
  const savingsEl = tile.querySelector('.tile__savings');
  if (savings > 0) {
    savingsEl.classList.remove('is-hidden');
    savingsEl.querySelector('.tile__savings-text').textContent = `${savings}% space saved`;
  }
}

function createBadge(text, type) {
  const badge = createElement('span', { class: `badge badge--${type}` }, text);
  return badge;
}

function showTileError(tile, message) {
  const existing = tile.querySelector('.tile__error');
  if (existing) existing.remove();

  const errorEl = createElement('div', { class: 'tile__error' });
  errorEl.appendChild(icon('alert-circle', 14));
  errorEl.appendChild(createElement('span', {}, message));

  // Insert before actions
  const actions = tile.querySelector('.tile__actions');
  tile.insertBefore(errorEl, actions);

  setTimeout(() => errorEl.remove(), 8000);
}

function showTileWarning(tile, message) {
  const warningEl = createElement('div', { class: 'tile__warning' });
  warningEl.appendChild(icon('alert-triangle', 14));
  warningEl.appendChild(createElement('span', {}, message));

  const actions = tile.querySelector('.tile__actions');
  tile.insertBefore(warningEl, actions);
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Base64-to-Uint8Array helper (for ZIP).
 */
export function base64ToUint8Array(base64String) {
  const binaryString = atob(base64String);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
