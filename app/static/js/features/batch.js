/**
 * Batch operations: auto-process, queue processing, ZIP download, file management.
 */
import { $, downloadBlob } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { postJSON } from '../lib/api.js';
import { state, clearAllFiles, updateFile } from '../state/app-state.js';
import { processTile, base64ToUint8Array } from './image-tile.js';
import { showToast } from '../components/toast.js';
import { globalProgress } from '../components/progress.js';

let processing = false;
let abortController = null;
const CHUNK_SIZE = 5;

export function initBatch() {
  const clearBtn = $('#clear-all');
  const cancelBtn = $('#cancel-batch');
  const downloadBtn = $('#download-all');
  const retryFailedBtn = $('#retry-failed');
  const reprocessBtn = $('#reprocess-all');

  // Auto-process when files are added
  bus.on('files:autoProcess', async ({ fileIds }) => {
    if (processing) return;
    await runBatch(fileIds);
  });

  // Download All
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => downloadAll());
  }

  // Clear All (with confirmation)
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const count = state.files.size;
      if (count === 0) return;
      if (!confirm(`Clear all ${count} file${count > 1 ? 's' : ''}? Processed results will be lost.`)) return;
      clearAllFiles();
    });
  }

  // Retry Failed
  if (retryFailedBtn) {
    retryFailedBtn.addEventListener('click', () => retryFailed());
  }

  // Re-process all done files with new settings
  if (reprocessBtn) {
    reprocessBtn.addEventListener('click', () => reprocessAll());
  }

  // Cancel batch
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (abortController) {
        abortController.abort();
      }
    });
  }

  // Show/hide toolbar based on file count
  bus.on('files:countChanged', ({ total }) => {
    const toolbar = $('#workspace-toolbar');
    if (toolbar) {
      toolbar.classList.toggle('is-hidden', total === 0);
    }
    const el = $('#total-files-count');
    if (el) el.textContent = total;
  });

  // Update Download All button and Retry Failed visibility when file statuses change
  bus.on('file:updated', () => {
    updateDownloadAllState();
    updateRetryFailedVisibility();
    updateReprocessVisibility();
  });
  bus.on('files:cleared', () => {
    updateDownloadAllState();
    updateRetryFailedVisibility();
    updateReprocessVisibility();
  });
  bus.on('files:removed', () => {
    updateDownloadAllState();
    updateRetryFailedVisibility();
    updateReprocessVisibility();
  });

  // Re-process detection: when settings change, check if any done files used different settings
  bus.on('settings:changed', () => {
    updateReprocessVisibility();
  });
}

/**
 * Enable/disable the Download All button based on whether any files have been processed.
 */
function updateDownloadAllState() {
  const btn = $('#download-all');
  if (!btn) return;
  const hasDone = [...state.files.values()].some((e) => e.status === 'done' && e.processedData);
  btn.disabled = !hasDone;
  btn.title = hasDone ? '' : 'Processing...';
}

/**
 * Show/hide the "Retry Failed" button.
 */
function updateRetryFailedVisibility() {
  const btn = $('#retry-failed');
  if (!btn) return;
  const hasErrors = [...state.files.values()].some((e) => e.status === 'error');
  btn.classList.toggle('is-hidden', !hasErrors);
}

/**
 * Show/hide the "Re-process" button when settings have changed since last processing.
 */
function updateReprocessVisibility() {
  const btn = $('#reprocess-all');
  if (!btn) return;

  const currentSettings = JSON.stringify(state.settings);
  const needsReprocess = [...state.files.values()].some((e) => {
    if (e.status !== 'done' || !e.processedWithSettings) return false;
    return JSON.stringify(e.processedWithSettings) !== currentSettings;
  });

  btn.classList.toggle('is-hidden', !needsReprocess);
}

/**
 * Retry all failed files.
 */
async function retryFailed() {
  if (processing) return;

  const failedIds = [...state.files.entries()]
    .filter(([, entry]) => entry.status === 'error')
    .map(([id]) => id);

  if (failedIds.length === 0) return;

  // Reset each failed tile's state
  failedIds.forEach((fileId) => {
    const tile = document.querySelector(`[data-file-id="${fileId}"]`);
    if (tile) {
      tile.classList.remove('is-error');
      const errorEl = tile.querySelector('.tile__error');
      if (errorEl) errorEl.remove();
      const retryBtn = tile.querySelector('.tile__retry-btn');
      if (retryBtn) retryBtn.classList.add('is-hidden');
    }
    updateFile(fileId, { status: 'pending', errorMessage: null });
  });

  await runBatch(failedIds);
}

/**
 * Re-process all done files with current settings.
 */
async function reprocessAll() {
  if (processing) return;

  const currentSettings = JSON.stringify(state.settings);
  const doneIds = [...state.files.entries()]
    .filter(([, entry]) => {
      if (entry.status !== 'done' || !entry.processedWithSettings) return false;
      return JSON.stringify(entry.processedWithSettings) !== currentSettings;
    })
    .map(([id]) => id);

  if (doneIds.length === 0) return;

  // Reset done files to pending
  doneIds.forEach((fileId) => {
    updateFile(fileId, { status: 'pending', processedData: null, processedWithSettings: null });
    const tile = document.querySelector(`[data-file-id="${fileId}"]`);
    if (tile) {
      tile.classList.remove('is-done');
      const processedSection = tile.querySelector('.tile__processed');
      if (processedSection) processedSection.classList.add('is-hidden');
      const savingsEl = tile.querySelector('.tile__savings');
      if (savingsEl) savingsEl.classList.add('is-hidden');
      const badges = tile.querySelector('.tile__status-badges');
      if (badges) badges.innerHTML = '';
      const downloadBtn = tile.querySelector('.tile__download-btn');
      if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.title = 'Processing...';
      }
    }
  });

  await runBatch(doneIds);
}

/**
 * Shared batch processing loop.
 * @param {string[]} fileIds
 */
async function runBatch(fileIds) {
  processing = true;
  abortController = new AbortController();

  const batchProgressEl = $('#batch-progress');
  const processedCountEl = $('#processed-count');
  const totalCountEl = $('#total-count');
  const timeRemainingEl = $('#time-remaining');
  const progressBar = $('#batch-progress-bar');
  const succeededEl = $('#batch-succeeded');
  const failedEl = $('#batch-failed');
  const successCountEl = $('#batch-success-count');
  const failCountEl = $('#batch-fail-count');

  const total = fileIds.length;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const startTime = Date.now();

  // Show batch progress, reset stats
  if (batchProgressEl) batchProgressEl.classList.remove('is-hidden');
  if (totalCountEl) totalCountEl.textContent = total;
  if (processedCountEl) processedCountEl.textContent = 0;
  if (succeededEl) succeededEl.classList.add('is-hidden');
  if (failedEl) failedEl.classList.add('is-hidden');
  if (successCountEl) successCountEl.textContent = 0;
  if (failCountEl) failCountEl.textContent = 0;

  globalProgress.show();

  // Process in chunks
  const queue = [...fileIds];
  let aborted = false;

  while (queue.length > 0 && !aborted) {
    const chunk = queue.splice(0, CHUNK_SIZE);

    await Promise.all(
      chunk.map(async (fileId) => {
        if (abortController.signal.aborted) {
          aborted = true;
          return;
        }

        const entry = state.files.get(fileId);
        if (!entry || entry.status === 'done') {
          succeeded++;
          processed++;
          updateBatchProgress(processed, total, startTime, processedCountEl, progressBar, timeRemainingEl);
          updateBatchStats(succeeded, failed, succeededEl, failedEl, successCountEl, failCountEl);
          return;
        }

        await processTile(fileId, {
          skipGlobalProgress: true,
          signal: abortController.signal,
        });

        const updatedEntry = state.files.get(fileId);
        if (updatedEntry?.status === 'cancelled') {
          aborted = true;
          return;
        } else if (updatedEntry?.status === 'done') {
          succeeded++;
        } else if (updatedEntry?.status === 'error') {
          failed++;
        }

        processed++;
        updateBatchProgress(processed, total, startTime, processedCountEl, progressBar, timeRemainingEl);
        updateBatchStats(succeeded, failed, succeededEl, failedEl, successCountEl, failCountEl);
      })
    );
  }

  // Cleanup
  processing = false;
  abortController = null;
  globalProgress.hide();
  if (batchProgressEl) {
    setTimeout(() => batchProgressEl.classList.add('is-hidden'), 1500);
  }

  // Completion summary toast
  if (aborted) {
    showToast({
      message: `Cancelled. ${succeeded} processed, ${total - processed} skipped.`,
      type: 'info',
    });
  } else if (failed === 0) {
    showToast({
      message: `All ${succeeded} images processed successfully`,
      type: 'success',
    });
  } else {
    showToast({
      message: `${succeeded} processed, ${failed} failed`,
      type: 'warning',
    });
  }
}

function updateBatchProgress(processed, total, startTime, countEl, barEl, timeEl) {
  const progress = processed / total;
  if (countEl) countEl.textContent = processed;
  if (barEl) barEl.style.width = `${progress * 100}%`;
  globalProgress.setProgress(progress);

  if (timeEl && processed > 0) {
    const elapsed = (Date.now() - startTime) / 1000;
    const avgTime = elapsed / processed;
    const remaining = (total - processed) * avgTime;
    timeEl.textContent = remaining > 60
      ? `~${Math.ceil(remaining / 60)} min remaining`
      : `~${Math.ceil(remaining)}s remaining`;
  }
}

function updateBatchStats(succeeded, failed, succeededEl, failedEl, successCountEl, failCountEl) {
  if (succeeded > 0 && succeededEl) {
    succeededEl.classList.remove('is-hidden');
    if (successCountEl) successCountEl.textContent = succeeded;
  }
  if (failed > 0 && failedEl) {
    failedEl.classList.remove('is-hidden');
    if (failCountEl) failCountEl.textContent = failed;
  }
}

/**
 * Download all processed files (single or ZIP).
 */
async function downloadAll() {
  const processedEntries = [...state.files.entries()]
    .filter(([, entry]) => entry.status === 'done' && entry.processedData);

  if (processedEntries.length === 0) {
    showToast({ message: 'No processed images to download', type: 'warning' });
    return;
  }

  if (processedEntries.length === 1) {
    const [, entry] = processedEntries[0];
    try {
      const response = await postJSON('/download', {
        compressed_data: entry.processedData.data,
        filename: entry.processedData.filename,
      });
      const blob = await response.blob();
      downloadBlob(blob, `processed_${entry.processedData.filename}`);
    } catch (error) {
      showToast({ message: `Download failed: ${error.message}`, type: 'error' });
    }
    return;
  }

  // Multiple files → ZIP
  if (typeof JSZip === 'undefined') {
    showToast({ message: 'ZIP library not loaded', type: 'error' });
    return;
  }

  try {
    globalProgress.show();
    globalProgress.setIndeterminate();

    const zip = new JSZip();

    for (const [, entry] of processedEntries) {
      const binaryData = base64ToUint8Array(entry.processedData.data);
      zip.file(entry.processedData.filename, binaryData);
    }

    const content = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    downloadBlob(content, 'processed_images.zip');
    showToast({ message: `Downloaded ${processedEntries.length} images as ZIP`, type: 'success' });
  } catch (error) {
    console.error('ZIP creation error:', error);
    showToast({ message: 'Failed to create ZIP file', type: 'error' });
  } finally {
    globalProgress.hide();
  }
}
