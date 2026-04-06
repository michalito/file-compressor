/**
 * Image tile: lifecycle (create, update, remove, blob URL management).
 */
import { $, createElement, icon, downloadBlob, base64ToUint8Array, formatToMime } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { postForm, postJSON } from '../lib/api.js';
import { state, updateFile, removeFile } from '../state/app-state.js';
import { appendSettingsToFormData } from './settings.js';
import { showToast } from '../components/toast.js';
import { globalProgress } from '../components/progress.js';
import { openCropModal } from './crop.js';

// Wire up event-driven DOM cleanup
bus.on('files:removed', ({ fileId }) => {
  const tile = $(`[data-file-id="${fileId}"]`);
  if (tile) tile.remove();
});

bus.on('files:cleared', () => {
  const grid = $('#image-grid');
  if (grid) {
    const tiles = grid.querySelectorAll('.tile');
    tiles.forEach((tile) => tile.remove());
  }
});

// Update tile UI after cropping
bus.on('file:cropped', ({ fileId, metadata }) => {
  const tile = $(`[data-file-id="${fileId}"]`);
  if (!tile) return;

  // Update processed info section
  updateTileWithResults(tile, metadata);

  // Update preview image (crop.js already created a blob URL in entry.blobUrl)
  const entry = state.files.get(fileId);
  if (entry?.blobUrl) {
    const img = tile.querySelector('.tile__image');
    if (img) img.src = entry.blobUrl;
  }

  // Add Cropped badge if not already present
  const badges = tile.querySelector('.tile__status-badges');
  if (badges && !badges.querySelector('.badge--cropped')) {
    const croppedBadge = createElement('span', { class: 'badge badge--info badge--cropped' }, 'Cropped');
    badges.appendChild(croppedBadge);
  }

  // Show Reset button
  const resetBtn = tile.querySelector('.tile__reset-crop-btn');
  if (resetBtn) resetBtn.classList.remove('is-hidden');
});

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

  // Remove button
  const removeBtn = tile.querySelector('.tile__remove-btn');
  removeBtn.setAttribute('aria-label', `Remove ${file.name}`);
  removeBtn.addEventListener('click', () => {
    removeFile(fileId);
  });

  // Retry button
  const retryBtn = tile.querySelector('.tile__retry-btn');
  retryBtn.addEventListener('click', () => retryProcessing(fileId, tile));

  // Download button
  const downloadBtn = tile.querySelector('.tile__download-btn');
  downloadBtn.addEventListener('click', () => downloadFile(fileId, tile));

  // Crop button
  const cropBtn = tile.querySelector('.tile__crop-btn');
  if (cropBtn) {
    cropBtn.addEventListener('click', () => openCropModal(fileId));
  }

  // Reset crop button — restores original file and reprocesses
  const resetCropBtn = tile.querySelector('.tile__reset-crop-btn');
  if (resetCropBtn) {
    resetCropBtn.addEventListener('click', () => resetCrop(fileId, tile));
  }

  grid.appendChild(clone);
}

/**
 * Process a single image by fileId.
 * Exported so batch.js can delegate per-tile processing here.
 * @param {string} fileId
 * @param {{ skipGlobalProgress?: boolean, signal?: AbortSignal }} [options]
 */
export async function processTile(fileId, { skipGlobalProgress = false, signal } = {}) {
  const tile = $(`[data-file-id="${fileId}"]`);
  if (!tile) return;
  return processImage(fileId, tile, skipGlobalProgress, signal);
}

/**
 * Reset to original file (undo all crops) and reprocess.
 */
function resetCrop(fileId, tile) {
  const entry = state.files.get(fileId);
  if (!entry?.originalFile) return;

  // Restore original file
  updateFile(fileId, {
    file: entry.originalFile,
    originalFile: null,
  });

  // Reprocess from the original
  processImage(fileId, tile);
}

/**
 * Retry processing after an error.
 */
function retryProcessing(fileId, tile) {
  // Clear error state
  tile.classList.remove('is-error');
  const errorEl = tile.querySelector('.tile__error');
  if (errorEl) errorEl.remove();

  // Hide retry
  const retryBtn = tile.querySelector('.tile__retry-btn');
  if (retryBtn) retryBtn.classList.add('is-hidden');

  // Reset status and re-process
  updateFile(fileId, { status: 'pending', errorMessage: null });
  processImage(fileId, tile);
}

/**
 * Process a single image (internal, needs tile element).
 */
async function processImage(fileId, tile, skipGlobalProgress = false, signal) {
  const entry = state.files.get(fileId);
  if (!entry) return;

  const progressEl = tile.querySelector('.tile__progress');
  const retryBtn = tile.querySelector('.tile__retry-btn');
  const downloadBtn = tile.querySelector('.tile__download-btn');
  const cropBtn = tile.querySelector('.tile__crop-btn');

  try {
    updateFile(fileId, { status: 'processing' });
    progressEl.classList.remove('is-hidden');
    tile.classList.add('is-processing');
    retryBtn.classList.add('is-hidden');
    tile.classList.remove('is-done');
    // Hide crop and reset buttons during reprocessing
    if (cropBtn) cropBtn.classList.add('is-hidden');
    const resetCropBtn = tile.querySelector('.tile__reset-crop-btn');
    if (resetCropBtn) resetCropBtn.classList.add('is-hidden');
    // Clear stale state from previous attempt
    const cancelledBadge = tile.querySelector('.badge--cancelled');
    if (cancelledBadge) cancelledBadge.remove();
    const croppedBadge = tile.querySelector('.badge--cropped');
    if (croppedBadge) croppedBadge.remove();
    tile.querySelectorAll('.tile__warning').forEach((el) => el.remove());
    if (!skipGlobalProgress) {
      globalProgress.show();
      globalProgress.setIndeterminate();
    }

    const formData = new FormData();
    formData.append('file', entry.file);
    appendSettingsToFormData(formData);

    const response = await postForm('/process', formData, { signal });
    const result = await response.json();

    // On reprocess, carry forward the original upload's size so savings
    // percentage stays relative to the upload, not the intermediate file
    const resultMetadata = { ...result.metadata };
    const prevOriginalSize = entry.processedData?.metadata?.original_size;
    if (prevOriginalSize) {
      resultMetadata.original_size = prevOriginalSize;
    }

    // Store processed data and snapshot of settings used
    updateFile(fileId, {
      status: 'done',
      processedData: {
        data: result.compressed_data,
        filename: result.filename,
        metadata: resultMetadata,
      },
      processedWithSettings: JSON.parse(JSON.stringify(state.settings)),
    });

    // Update tile UI
    downloadBtn.disabled = false;
    downloadBtn.removeAttribute('title');
    tile.classList.add('is-done');

    // Show crop button (only for browser-displayable formats, not TIFF)
    const outputFormat = (result.metadata.format || '').toUpperCase();
    if (cropBtn && outputFormat !== 'TIFF') cropBtn.classList.remove('is-hidden');

    // Re-show Reset if the original pre-crop file is still stashed
    const resetBtn = tile.querySelector('.tile__reset-crop-btn');
    if (resetBtn && entry.originalFile) resetBtn.classList.remove('is-hidden');

    updateTileWithResults(tile, resultMetadata);

    // Update preview with the processed image
    const previewBytes = base64ToUint8Array(result.compressed_data);
    const previewMime = formatToMime(resultMetadata.format);
    const previewBlob = new Blob([previewBytes], { type: previewMime });
    const newBlobUrl = URL.createObjectURL(previewBlob);
    const previewImg = tile.querySelector('.tile__image');
    if (previewImg) previewImg.src = newBlobUrl;
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
    updateFile(fileId, { blobUrl: newBlobUrl });

    // Show status badges
    const badges = tile.querySelector('.tile__status-badges');
    badges.innerHTML = '';
    badges.appendChild(createBadge('Compressed', 'success'));

    // Show "Converted" badge if format changed
    const origFmt = result.metadata.original_format;
    const outFmt = result.metadata.format;
    if (origFmt && outFmt && origFmt !== outFmt) {
      badges.appendChild(createBadge(`\u2192 ${outFmt}`, 'info'));
    }

    const origDims = result.metadata.original_dimensions;
    const finalDims = result.metadata.final_dimensions;
    if (origDims && finalDims &&
        (origDims[0] !== finalDims[0] || origDims[1] !== finalDims[1])) {
      badges.appendChild(createBadge('Resized', 'info'));
    }

    if (result.metadata.watermarked) {
      badges.appendChild(createBadge('Watermarked', 'info'));
    }

    // Show warnings
    if (result.warnings && result.warnings.length > 0) {
      result.warnings.forEach((w) => showTileWarning(tile, w));
    }
  } catch (error) {
    // AbortError means cancelled
    if (error.name === 'AbortError') {
      updateFile(fileId, { status: 'cancelled' });
      const badges = tile.querySelector('.tile__status-badges');
      if (badges) {
        const existing = badges.querySelector('.badge--cancelled');
        if (!existing) {
          badges.appendChild(createBadge('Cancelled', 'cancelled'));
        }
      }
      return;
    }

    console.error('Processing error:', error);
    updateFile(fileId, { status: 'error', errorMessage: error.message });
    tile.classList.add('is-error');
    showTileError(tile, `Processing failed: ${error.message}`);

    // Show retry
    retryBtn.classList.remove('is-hidden');

    showToast({ message: `Failed to process ${entry.file.name}`, type: 'error' });
  } finally {
    progressEl.classList.add('is-hidden');
    tile.classList.remove('is-processing');
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

  // Savings overlay
  const savings = Math.round((1 - metadata.compressed_size / metadata.original_size) * 100);
  const savingsEl = tile.querySelector('.tile__savings');

  if (savings > 0) {
    savingsEl.classList.remove('is-hidden');
    savingsEl.classList.remove('tile__savings--negative');
    savingsEl.querySelector('.tile__savings-text').textContent = `${savings}% saved`;
  } else if (savings < 0) {
    savingsEl.classList.remove('is-hidden');
    savingsEl.classList.add('tile__savings--negative');
    savingsEl.querySelector('.tile__savings-text').textContent = `+${Math.abs(savings)}% larger`;
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

  const actions = tile.querySelector('.tile__actions');
  tile.insertBefore(errorEl, actions);
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

