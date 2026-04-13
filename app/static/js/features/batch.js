/**
 * Batch operations: auto-process queue, ZIP download, file management.
 */
import { $, createElement, downloadBlob, base64ToUint8Array } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { postJSON } from '../lib/api.js';
import { state, clearAllFiles, updateFile } from '../state/app-state.js';
import { processTile } from './image-tile.js';
import { showToast } from '../components/toast.js';
import { globalProgress } from '../components/progress.js';
import { showConfirm } from '../components/confirm.js';
import {
  getCurrentProcessingSnapshot,
  getCurrentSettingsValidation,
  isCurrentSettingsProcessable,
} from './settings.js';

const CHUNK_SIZE = 5;
const RETRYABLE_STATUSES = new Set(['pending', 'error', 'cancelled']);

let processing = false;
let abortController = null;
let activeBatch = null;
const queue = [];
const queuedIds = new Set();

export function initBatch() {
  const clearBtn = $('#clear-all');
  const cancelBtn = $('#cancel-batch');
  const downloadBtn = $('#download-all');
  const retryIncompleteBtn = $('#retry-incomplete');
  const reprocessBtn = $('#reprocess-all');

  bus.on('files:autoProcess', ({ fileIds }) => {
    enqueueForProcessing(fileIds);
  });

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => downloadAll());
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const count = state.files.size;
      if (count === 0) return;

      const confirmed = await showConfirm({
        title: 'Clear all files?',
        message: `${count} file${count > 1 ? 's' : ''} and their processed results will be permanently lost.`,
        confirmLabel: 'Clear All',
        variant: 'danger',
      });
      if (!confirmed) return;

      if (abortController) {
        abortController.abort();
      }

      clearQueuedEntries();
      if (activeBatch) {
        activeBatch.cancelled = true;
        activeBatch.suppressSummary = true;
      }
      clearAllFiles();
    });
  }

  if (retryIncompleteBtn) {
    retryIncompleteBtn.addEventListener('click', () => retryIncomplete());
  }

  if (reprocessBtn) {
    reprocessBtn.addEventListener('click', () => reprocessAll());
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (abortController) {
        abortController.abort();
      }
    });
  }

  bus.on('files:countChanged', ({ total }) => {
    const toolbar = $('#workspace-toolbar');
    if (toolbar) {
      toolbar.classList.toggle('is-hidden', total === 0);
    }
    const el = $('#total-files-count');
    if (el) el.textContent = total;
  });

  bus.on('file:updated', () => {
    updateDownloadAllState();
    updateRetryIncompleteVisibility();
    updateReprocessVisibility();
  });

  bus.on('files:cleared', () => {
    clearQueuedEntries();
    if (!processing) {
      activeBatch = null;
      const batchProgressEl = $('#batch-progress');
      if (batchProgressEl) batchProgressEl.classList.add('is-hidden');
      globalProgress.hide();
    }
    updateDownloadAllState();
    updateRetryIncompleteVisibility();
    updateReprocessVisibility();
  });

  bus.on('files:removed', ({ fileId }) => {
    removeQueuedFile(fileId);
    updateDownloadAllState();
    updateRetryIncompleteVisibility();
    updateReprocessVisibility();
  });

  bus.on('settings:changed', () => {
    updateReprocessVisibility();
  });

  bus.on('settings:validationChanged', ({ processable }) => {
    updateReprocessVisibility();
    if (processable) {
      enqueuePendingFiles();
    }
  });
}

function enqueueForProcessing(fileIds) {
  if (!isCurrentSettingsProcessable()) {
    showResizeValidationToast();
    return;
  }

  const newlyQueued = [];

  for (const fileId of fileIds) {
    const entry = state.files.get(fileId);
    if (!entry || !RETRYABLE_STATUSES.has(entry.status) || queuedIds.has(fileId)) {
      continue;
    }

    queuedIds.add(fileId);
    queue.push(fileId);
    newlyQueued.push(fileId);
  }

  if (newlyQueued.length === 0) return;

  if (activeBatch) {
    activeBatch.total += newlyQueued.length;
    syncBatchTotals();
  }

  void drainQueue();
}

function enqueuePendingFiles() {
  const pendingIds = [...state.files.entries()]
    .filter(([fileId, entry]) => entry.status === 'pending' && !queuedIds.has(fileId))
    .map(([fileId]) => fileId);

  if (pendingIds.length === 0) return;
  enqueueForProcessing(pendingIds);
}

function showResizeValidationToast() {
  const validation = getCurrentSettingsValidation();
  if (validation.processable) return;

  showToast({
    message: validation.resize.message || 'Fix resize settings before processing files.',
    type: 'warning',
    duration: 5000,
  });
}

function removeQueuedFile(fileId) {
  if (!queuedIds.has(fileId)) return;

  queuedIds.delete(fileId);
  const index = queue.indexOf(fileId);
  if (index >= 0) {
    queue.splice(index, 1);
  }

  if (activeBatch) {
    activeBatch.total = Math.max(activeBatch.processed, activeBatch.total - 1);
    syncBatchTotals();
  }
}

function clearQueuedEntries() {
  queue.length = 0;
  queuedIds.clear();
}

function startBatchIfNeeded() {
  if (activeBatch || queue.length === 0) return;

  activeBatch = {
    total: queue.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    cancelledCount: 0,
    startTime: Date.now(),
    cancelled: false,
    interrupted: false,
  };

  const batchProgressEl = $('#batch-progress');
  const succeededEl = $('#batch-succeeded');
  const failedEl = $('#batch-failed');
  const successCountEl = $('#batch-success-count');
  const failCountEl = $('#batch-fail-count');

  if (batchProgressEl) batchProgressEl.classList.remove('is-hidden');
  if (succeededEl) succeededEl.classList.add('is-hidden');
  if (failedEl) failedEl.classList.add('is-hidden');
  if (successCountEl) successCountEl.textContent = 0;
  if (failCountEl) failCountEl.textContent = 0;

  syncBatchTotals();
  globalProgress.show();
}

async function drainQueue() {
  if (processing || queue.length === 0) return;

  processing = true;
  const controller = new AbortController();
  abortController = controller;
  startBatchIfNeeded();

  try {
    while (queue.length > 0 && !controller.signal.aborted) {
      const chunk = dequeueChunk(CHUNK_SIZE);
      await Promise.all(chunk.map((fileId) => processQueuedFile(fileId, controller.signal)));
    }

    if (controller.signal.aborted) {
      markRemainingQueuedFilesCancelled();
      if (activeBatch) activeBatch.cancelled = true;
    }
  } finally {
    finishBatch();
    processing = false;
    if (abortController === controller) {
      abortController = null;
    }

    if (queue.length > 0) {
      void drainQueue();
    }
  }
}

function dequeueChunk(size) {
  const chunk = [];

  while (chunk.length < size && queue.length > 0) {
    const fileId = queue.shift();
    queuedIds.delete(fileId);
    chunk.push(fileId);
  }

  return chunk;
}

async function processQueuedFile(fileId, signal) {
  const batch = activeBatch;
  if (!batch) return;

  try {
    const entry = state.files.get(fileId);
    if (!entry) {
      recordBatchOutcome(batch, 'skipped');
      return;
    }

    if (signal.aborted) {
      markFileCancelled(fileId);
      recordBatchOutcome(batch, 'cancelled');
      return;
    }

    if (entry.status === 'done') {
      recordBatchOutcome(batch, 'done');
      return;
    }

    await processTile(fileId, {
      skipGlobalProgress: true,
      signal,
    });

    const updatedEntry = state.files.get(fileId);
    if (updatedEntry?.status === 'done') {
      recordBatchOutcome(batch, 'done');
    } else if (updatedEntry?.status === 'error') {
      recordBatchOutcome(batch, 'error');
    } else {
      if (updatedEntry?.status !== 'cancelled') {
        markFileCancelled(fileId);
      }
      recordBatchOutcome(batch, 'cancelled');
    }
  } catch (error) {
    console.error('Unexpected batch processing error:', error);
    batch.interrupted = true;

    const updatedEntry = state.files.get(fileId);
    if (updatedEntry?.status === 'done') {
      recordBatchOutcome(batch, 'done');
      return;
    }

    if (updatedEntry?.status === 'error') {
      recordBatchOutcome(batch, 'error');
      return;
    }

    if (updatedEntry?.status !== 'cancelled') {
      markFileCancelled(fileId);
    }
    recordBatchOutcome(batch, 'cancelled');
  }
}

function recordBatchOutcome(batch, outcome) {
  if (outcome === 'done') {
    batch.succeeded++;
  } else if (outcome === 'error') {
    batch.failed++;
  } else if (outcome === 'cancelled') {
    batch.cancelled = true;
    batch.cancelledCount++;
  }

  batch.processed++;

  try {
    syncBatchProgress();
  } catch (error) {
    console.error('Failed to sync batch progress:', error);
  }
}

function syncBatchTotals() {
  const totalCountEl = $('#total-count');
  if (totalCountEl && activeBatch) {
    totalCountEl.textContent = activeBatch.total;
  }
  syncBatchProgress();
}

function syncBatchProgress() {
  if (!activeBatch) return;

  const processedCountEl = $('#processed-count');
  const progressBar = $('#batch-progress-bar');
  const timeRemainingEl = $('#time-remaining');
  const succeededEl = $('#batch-succeeded');
  const failedEl = $('#batch-failed');
  const successCountEl = $('#batch-success-count');
  const failCountEl = $('#batch-fail-count');

  const { processed, total, succeeded, failed, startTime } = activeBatch;
  const safeTotal = Math.max(total, 1);
  const progress = processed / safeTotal;

  if (processedCountEl) processedCountEl.textContent = processed;
  if (progressBar) progressBar.style.width = `${progress * 100}%`;
  globalProgress.setProgress(progress);

  if (timeRemainingEl) {
    if (processed > 0 && processed < total) {
      const elapsed = (Date.now() - startTime) / 1000;
      const avgTime = elapsed / processed;
      const remaining = (total - processed) * avgTime;
      timeRemainingEl.textContent = remaining > 60
        ? `~${Math.ceil(remaining / 60)} min remaining`
        : `~${Math.ceil(remaining)}s remaining`;
    } else {
      timeRemainingEl.textContent = '';
    }
  }

  if (succeeded > 0 && succeededEl) {
    succeededEl.classList.remove('is-hidden');
    if (successCountEl) successCountEl.textContent = succeeded;
  }

  if (failed > 0 && failedEl) {
    failedEl.classList.remove('is-hidden');
    if (failCountEl) failCountEl.textContent = failed;
  }
}

function finishBatch() {
  const batch = activeBatch;
  const batchProgressEl = $('#batch-progress');

  activeBatch = null;
  globalProgress.hide();

  if (batchProgressEl) {
    setTimeout(() => batchProgressEl.classList.add('is-hidden'), 1500);
  }

  if (!batch) return;
  if (batch.suppressSummary) return;

  const skipped = Math.max(0, batch.total - batch.processed);
  const incomplete = batch.cancelledCount + skipped;
  if (batch.interrupted) {
    showToast({
      message: `Batch interrupted. ${batch.succeeded} processed, ${incomplete} incomplete. Retry incomplete files.`,
      type: 'warning',
    });
  } else if (batch.cancelled) {
    showToast({
      message: `Cancelled. ${batch.succeeded} processed, ${incomplete} skipped.`,
      type: 'info',
    });
  } else if (batch.failed === 0) {
    showToast({
      message: `All ${batch.succeeded} images processed successfully`,
      type: 'success',
    });
  } else {
    showToast({
      message: `${batch.succeeded} processed, ${batch.failed} failed`,
      type: 'warning',
    });
  }
}

function markRemainingQueuedFilesCancelled() {
  while (queue.length > 0) {
    const fileId = queue.shift();
    queuedIds.delete(fileId);
    markFileCancelled(fileId);
  }
}

function markFileCancelled(fileId) {
  const entry = state.files.get(fileId);
  if (!entry || entry.status === 'done') return;

  updateFile(fileId, { status: 'cancelled', errorMessage: null });

  const tile = document.querySelector(`[data-file-id="${fileId}"]`);
  if (!tile) return;

  tile.classList.remove('is-processing', 'is-error');
  const progressEl = tile.querySelector('.tile__progress');
  if (progressEl) progressEl.classList.add('is-hidden');

  const errorEl = tile.querySelector('.tile__error');
  if (errorEl) errorEl.remove();

  const retryBtn = tile.querySelector('.tile__retry-btn');
  if (retryBtn) retryBtn.classList.add('is-hidden');

  const badges = tile.querySelector('.tile__status-badges');
  if (badges && !badges.querySelector('.badge--cancelled')) {
    badges.appendChild(createElement('span', { class: 'badge badge--cancelled' }, 'Cancelled'));
  }
}

function resetTileForRetry(fileId) {
  const tile = document.querySelector(`[data-file-id="${fileId}"]`);
  if (!tile) return;

  tile.classList.remove('is-error');
  const errorEl = tile.querySelector('.tile__error');
  if (errorEl) errorEl.remove();

  const retryBtn = tile.querySelector('.tile__retry-btn');
  if (retryBtn) retryBtn.classList.add('is-hidden');

  const cancelledBadge = tile.querySelector('.badge--cancelled');
  if (cancelledBadge) cancelledBadge.remove();
}

function updateDownloadAllState() {
  const btn = $('#download-all');
  if (!btn) return;

  const hasDone = [...state.files.values()].some((entry) => entry.status === 'done' && entry.processedData);
  btn.disabled = !hasDone;
  btn.title = hasDone ? '' : 'Processing...';
}

function updateRetryIncompleteVisibility() {
  const btn = $('#retry-incomplete');
  if (!btn) return;

  const hasIncomplete = [...state.files.values()].some((entry) =>
    entry.status === 'error' || entry.status === 'cancelled'
  );

  btn.classList.toggle('is-hidden', !hasIncomplete);
}

function updateReprocessVisibility() {
  const btn = $('#reprocess-all');
  if (!btn) return;

  const currentSettings = JSON.stringify(getCurrentProcessingSnapshot());
  const needsReprocess = [...state.files.values()].some((entry) => {
    if (entry.status !== 'done' || !entry.processedWithSettings) return false;
    return JSON.stringify(entry.processedWithSettings) !== currentSettings;
  });
  const processable = isCurrentSettingsProcessable();

  btn.classList.toggle('is-hidden', !needsReprocess);
  btn.disabled = !processable;
  btn.title = !processable ? 'Fix resize settings before reprocessing.' : '';
}

async function retryIncomplete() {
  if (processing) return;
  if (!isCurrentSettingsProcessable()) {
    showResizeValidationToast();
    return;
  }

  const incompleteIds = [...state.files.entries()]
    .filter(([, entry]) => entry.status === 'error' || entry.status === 'cancelled')
    .map(([id]) => id);

  if (incompleteIds.length === 0) return;

  for (const fileId of incompleteIds) {
    resetTileForRetry(fileId);
    updateFile(fileId, { status: 'pending', errorMessage: null });
  }

  enqueueForProcessing(incompleteIds);
}

async function reprocessAll() {
  if (processing) return;
  if (!isCurrentSettingsProcessable()) {
    showResizeValidationToast();
    return;
  }

  const currentSettings = JSON.stringify(getCurrentProcessingSnapshot());
  const doneIds = [...state.files.entries()]
    .filter(([, entry]) => {
      if (entry.status !== 'done' || !entry.processedWithSettings) return false;
      return JSON.stringify(entry.processedWithSettings) !== currentSettings;
    })
    .map(([id]) => id);

  if (doneIds.length === 0) return;

  for (const fileId of doneIds) {
    updateFile(fileId, { status: 'pending', processedWithSettings: null });
    const tile = document.querySelector(`[data-file-id="${fileId}"]`);
    if (!tile) continue;

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

  enqueueForProcessing(doneIds);
}

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
