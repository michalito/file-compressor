/**
 * Image tile: lifecycle (create, update, remove, blob URL management).
 */
import { $, createElement, icon, downloadBlob, base64ToUint8Array, formatToMime } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { postForm, postJSON } from '../lib/api.js';
import { state, updateFile, removeFile, setWatermarkPreviewFileId } from '../state/app-state.js';
import {
  appendSettingsToFormData,
  getCurrentProcessingSnapshot,
  isAIUpscaleMode,
} from './settings.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm.js';
import { globalProgress } from '../components/progress.js';
import { openCropModal } from './crop.js';
import {
  cancelAIUpscaleJob,
  createAIUpscaleJob,
  deleteAIUpscaleJob,
  downloadAIArtifact,
  getAIUpscaleHealth,
  getAIUpscaleJob,
} from '../lib/ai-upscale-api.js';
import { ensureDownloadPayload } from '../lib/download-payload.js';

const AI_UPSCALE_POLL_INTERVALS_MS = {
  queued: 2000,
  running: 1500,
  encoding: 1000,
  default: 1500,
};
const AI_UPSCALE_DEFAULT_STALL_TIMEOUT_MS = 30 * 60 * 1000;
const AI_UPSCALE_STALL_TIMEOUT_MS = (() => {
  const override = Number(window.__AI_UPSCALE_STALL_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0
    ? override
    : AI_UPSCALE_DEFAULT_STALL_TIMEOUT_MS;
})();
const AI_UPSCALE_RESTART_HEALTH_RECHECK_DELAY_MS = 750;
const AI_UPSCALE_RESTART_MESSAGE = 'AI upscaling worker restarted during processing. Retry the image.';
const AI_UPSCALE_STALL_MESSAGE = 'AI upscaling stopped making progress. Retry the image.';
const activeAIJobPolls = new Map();

function abortAIUpscalePollsForFile(fileId) {
  for (const [pollKey, activePoll] of activeAIJobPolls.entries()) {
    if (activePoll.fileId !== fileId) continue;
    activePoll.abortController.abort();
    activeAIJobPolls.delete(pollKey);
  }
}

function abortAllAIUpscalePolls() {
  for (const activePoll of activeAIJobPolls.values()) {
    activePoll.abortController.abort();
  }
  activeAIJobPolls.clear();
}

function createCombinedAbortSignal(...signals) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const cleanups = [];

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', abort));
  }

  return {
    controller,
    signal: controller.signal,
    cleanup() {
      cleanups.forEach((fn) => fn());
    },
  };
}

// Wire up event-driven DOM cleanup
bus.on('files:removed', ({ fileId }) => {
  abortAIUpscalePollsForFile(fileId);
  const tile = $(`[data-file-id="${fileId}"]`);
  if (tile) tile.remove();
});

bus.on('files:cleared', () => {
  abortAllAIUpscalePolls();
  const grid = $('#image-grid');
  if (grid) {
    const tiles = grid.querySelectorAll('.tile');
    tiles.forEach((tile) => tile.remove());
  }
});

bus.on('settings:changed', ({ tool }) => {
  if (tool === 'workflow') {
    syncTileWorkflowControls();
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

  // Add badge reflecting what changed (skip if already present)
  const badges = tile.querySelector('.tile__status-badges');
  if (badges) {
    if (metadata.cropped && !badges.querySelector('.badge--cropped')) {
      badges.appendChild(createElement('span', { class: 'badge badge--info badge--cropped' }, 'Cropped'));
    }
    if (metadata.rotated && !badges.querySelector('.badge--rotated')) {
      badges.appendChild(createElement('span', { class: 'badge badge--info badge--rotated' }, 'Rotated'));
    }
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

  const preview = tile.querySelector('.tile__preview');
  if (preview) {
    preview.addEventListener('click', () => setWatermarkPreviewFileId(fileId));
  }

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
  removeBtn.addEventListener('click', async () => {
    const entry = state.files.get(fileId);
    if (entry?.status === 'processing' && entry.upscaleJob?.jobId) {
      const confirmed = await showConfirm({
        title: 'Cancel AI upscaling?',
        message: `${file.name} is being AI upscaled. Removing it will cancel the job.`,
        confirmLabel: 'Remove',
        variant: 'danger',
      });
      if (!confirmed) return;
    }
    await cleanupRemoteResult(fileId);
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
  syncTileWorkflowControls();
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

function getTileProgressElements(tile) {
  return {
    progressEl: tile.querySelector('.tile__progress'),
    progressBar: tile.querySelector('.progress-inline__bar'),
    progressText: tile.querySelector('.tile__progress-text'),
  };
}

function showBasicTileProgress(tile, text = 'Processing…') {
  const { progressEl, progressBar, progressText } = getTileProgressElements(tile);
  if (!progressEl || !progressBar || !progressText) return;

  progressEl.classList.remove('is-hidden');
  progressBar.classList.add('progress-inline__bar--indeterminate');
  progressBar.style.width = '';
  progressBar.removeAttribute('aria-valuenow');
  progressBar.setAttribute('aria-valuetext', text);
  progressText.textContent = text;
}

export function clearTileProgress(tile) {
  if (!tile) return;

  const { progressEl, progressBar, progressText } = getTileProgressElements(tile);
  if (progressEl) progressEl.classList.add('is-hidden');
  if (progressBar) {
    progressBar.classList.remove('progress-inline__bar--indeterminate');
    progressBar.style.width = '';
    progressBar.removeAttribute('aria-valuenow');
    progressBar.removeAttribute('aria-valuetext');
  }
  if (progressText) {
    progressText.textContent = '';
  }
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
async function retryProcessing(fileId, tile) {
  await cleanupRemoteResult(fileId);
  clearTileProgress(tile);

  // Clear error state
  tile.classList.remove('is-error');
  const errorEl = tile.querySelector('.tile__error');
  if (errorEl) errorEl.remove();

  // Hide retry
  const retryBtn = tile.querySelector('.tile__retry-btn');
  if (retryBtn) retryBtn.classList.add('is-hidden');

  // Reset status and re-process
  updateFile(fileId, {
    status: 'pending',
    errorMessage: null,
    artifactRefs: null,
    upscaleJob: null,
  });
  processImage(fileId, tile);
}

/**
 * Process a single image (internal, needs tile element).
 */
async function processImage(fileId, tile, skipGlobalProgress = false, signal) {
  const entry = state.files.get(fileId);
  if (!entry) return;

  if (isAIUpscaleMode()) {
    return processAIUpscaleImage(fileId, tile, skipGlobalProgress, signal);
  }

  return processOptimizeImage(fileId, tile, skipGlobalProgress, signal);
}

async function processOptimizeImage(fileId, tile, skipGlobalProgress = false, signal) {
  const entry = state.files.get(fileId);
  if (!entry) return;

  const retryBtn = tile.querySelector('.tile__retry-btn');
  const downloadBtn = tile.querySelector('.tile__download-btn');
  const cropBtn = tile.querySelector('.tile__crop-btn');

  try {
    updateFile(fileId, { status: 'processing' });
    showBasicTileProgress(tile);
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
    const rotatedBadge = tile.querySelector('.badge--rotated');
    if (rotatedBadge) rotatedBadge.remove();
    tile.querySelectorAll('.tile__warning').forEach((el) => el.remove());
    if (!skipGlobalProgress) {
      globalProgress.show();
      globalProgress.setIndeterminate();
    }

    const formData = new FormData();
    formData.append('file', entry.file);
    await appendSettingsToFormData(formData);

    const response = await postForm('/process', formData, { signal });
    const result = await response.json();
    clearTileProgress(tile);

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
      processedWithSettings: getCurrentProcessingSnapshot(),
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
    badges.replaceChildren();
    badges.appendChild(createBadge('Compressed', 'success'));

    // Show "Converted" badge if format changed
    const origFmt = result.metadata.original_format;
    const outFmt = result.metadata.format;
    if (origFmt && outFmt && origFmt !== outFmt) {
      badges.appendChild(createBadge(`\u2192 ${outFmt}`, 'info'));
    }

    const resizeMeta = result.metadata.resize;
    if (resizeMeta?.changed) {
      badges.appendChild(createBadge(resizeMeta.upscaled ? 'Upscaled' : 'Resized', 'info'));
    }

    if (result.metadata.watermarked) {
      badges.appendChild(createBadge('Watermarked', 'info'));
    }

    if (result.metadata.background_removed) {
      badges.appendChild(createBadge('BG removed', 'info'));
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
    const isRateLimitError = error.code === 'rate_limit_exceeded' || error.status === 429;
    updateFile(fileId, { status: 'error', errorMessage: error.message });
    tile.classList.add('is-error');
    showTileError(tile, isRateLimitError ? error.message : `Processing failed: ${error.message}`);

    // Show retry
    retryBtn.classList.remove('is-hidden');

    showToast({
      message: isRateLimitError ? error.message : `Failed to process ${entry.file.name}`,
      type: isRateLimitError ? 'warning' : 'error',
      duration: isRateLimitError ? 7000 : undefined,
    });
  } finally {
    clearTileProgress(tile);
    tile.classList.remove('is-processing');
    if (!skipGlobalProgress) {
      globalProgress.hide();
    }
  }
}

async function processAIUpscaleImage(fileId, tile, skipGlobalProgress = false, signal) {
  const entry = state.files.get(fileId);
  if (!entry) return;
  const prevOriginalSize = entry.processedData?.metadata?.original_size;

  const retryBtn = tile.querySelector('.tile__retry-btn');
  const downloadBtn = tile.querySelector('.tile__download-btn');
  const cropBtn = tile.querySelector('.tile__crop-btn');
  let jobId = null;

  try {
    prepareTileForProcessing(fileId, tile, { skipGlobalProgress, hideCrop: true });

    const formData = new FormData();
    formData.append('file', entry.file);
    await appendSettingsToFormData(formData);

    const created = await createAIUpscaleJob(formData, { signal });
    jobId = created.job_id;
    syncAIProgress(tile, {
      phase: created.phase || created.status || 'queued',
      progress: created.progress ?? null,
      queuePosition: created.queue_position ?? null,
    });
    updateFile(fileId, {
      upscaleJob: {
        jobId,
        status: created.status || 'queued',
        phase: created.phase || created.status || 'queued',
        progress: created.progress ?? 0,
        queuePosition: created.queue_position ?? null,
        workerInstanceId: created.worker_instance_id || null,
      },
      artifactRefs: null,
      processedData: null,
      status: 'processing',
    });

    const result = await pollAIUpscaleJob(fileId, jobId, signal);
    clearTileProgress(tile);
    const resultMetadata = { ...result.result.metadata };
    if (prevOriginalSize) {
      resultMetadata.original_size = prevOriginalSize;
    }

    updateFile(fileId, {
      status: 'done',
      processedData: {
        filename: result.result.filename,
        metadata: resultMetadata,
      },
      processedWithSettings: getCurrentProcessingSnapshot(),
      upscaleJob: {
        jobId,
        status: 'done',
        phase: result.phase || 'done',
        progress: result.progress ?? 100,
        queuePosition: null,
        workerInstanceId: result.worker_instance_id || created.worker_instance_id || null,
      },
      artifactRefs: result.result.artifacts,
    });

    downloadBtn.disabled = false;
    downloadBtn.removeAttribute('title');
    tile.classList.add('is-done');
    if (cropBtn) cropBtn.classList.add('is-hidden');

    updateTileWithResults(tile, resultMetadata, { showSavings: false });

    const previewRef = result.result.artifacts?.preview;
    const previewImg = tile.querySelector('.tile__image');
    const previewUrl = previewRef ? `/ai-upscale/artifacts/${previewRef.artifact_id}/preview` : entry.blobUrl;
    if (previewImg && previewUrl) previewImg.src = previewUrl;
    if (entry.blobUrl?.startsWith?.('blob:')) URL.revokeObjectURL(entry.blobUrl);
    updateFile(fileId, { blobUrl: previewUrl });

    const badges = tile.querySelector('.tile__status-badges');
    badges.replaceChildren();
    badges.appendChild(createBadge('AI Upscaled', 'success'));
    badges.appendChild(createBadge(`x${resultMetadata.upscale?.requested_scale || 2}`, 'info'));
    const outFmt = resultMetadata.format;
    if (outFmt) {
      badges.appendChild(createBadge(`→ ${outFmt}`, 'info'));
    }

    if (result.result.warnings && result.result.warnings.length > 0) {
      result.result.warnings.forEach((warning) => showTileWarning(tile, warning));
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      if (jobId) {
        try {
          await cancelAIUpscaleJob(jobId);
        } catch {
          // Ignore cancellation failures during abort teardown.
        }
      }
      updateFile(fileId, { status: 'cancelled', errorMessage: null });
      const badges = tile.querySelector('.tile__status-badges');
      if (badges && !badges.querySelector('.badge--cancelled')) {
        badges.appendChild(createBadge('Cancelled', 'cancelled'));
      }
      return;
    }

    console.error('AI upscaling error:', error);
    const retryableMessage = ['ai_worker_restarted', 'ai_upscale_timeout'].includes(error.code)
      ? error.message
      : `AI upscaling failed: ${error.message}`;
    const currentEntry = state.files.get(fileId);
    updateFile(fileId, {
      status: 'error',
      errorMessage: retryableMessage,
      upscaleJob: jobId ? {
        jobId,
        status: 'error',
        phase: 'error',
        progress: 0,
        queuePosition: null,
        workerInstanceId: error.workerInstanceId || currentEntry?.upscaleJob?.workerInstanceId || null,
        retryable: true,
      } : null,
    });
    tile.classList.add('is-error');
    showTileError(tile, retryableMessage);
    retryBtn.classList.remove('is-hidden');
    showToast({
      message: ['ai_worker_restarted', 'ai_upscale_timeout'].includes(error.code)
        ? error.message
        : `Failed to upscale ${currentEntry?.file?.name || entry.file.name}`,
      type: 'error',
    });
  } finally {
    clearTileProgress(tile);
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
    const payload = ensureDownloadPayload(entry);
    if (payload.kind === 'artifact') {
      const blob = await downloadAIArtifact(payload.artifactId);
      downloadBlob(blob, entry.processedData.filename);
      return;
    }

    const response = await postJSON('/download', {
      compressed_data: payload.data,
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

function prepareTileForProcessing(fileId, tile, { skipGlobalProgress = false, hideCrop = false } = {}) {
  const retryBtn = tile.querySelector('.tile__retry-btn');
  const downloadBtn = tile.querySelector('.tile__download-btn');
  const cropBtn = tile.querySelector('.tile__crop-btn');

  updateFile(fileId, { status: 'processing', errorMessage: null });
  showBasicTileProgress(tile, 'Queued');
  tile.classList.add('is-processing');
  retryBtn.classList.add('is-hidden');
  tile.classList.remove('is-done', 'is-error');

  if (hideCrop && cropBtn) cropBtn.classList.add('is-hidden');
  const resetCropBtn = tile.querySelector('.tile__reset-crop-btn');
  if (resetCropBtn) resetCropBtn.classList.add('is-hidden');

  ['.badge--cancelled', '.badge--cropped', '.badge--rotated'].forEach((selector) => {
    const badge = tile.querySelector(selector);
    if (badge) badge.remove();
  });

  tile.querySelectorAll('.tile__warning, .tile__error').forEach((el) => el.remove());
  syncAIProgress(tile, { phase: 'queued', progress: null, queuePosition: null });
  if (downloadBtn) {
    downloadBtn.disabled = true;
    downloadBtn.setAttribute('title', 'Processing in progress');
  }

  if (!skipGlobalProgress) {
    globalProgress.show();
    globalProgress.setIndeterminate();
  }
}

async function pollAIUpscaleJob(fileId, jobId, signal) {
  const pollKey = `${fileId}:${jobId}`;
  const activePoll = activeAIJobPolls.get(pollKey);
  if (activePoll) {
    return activePoll.promise;
  }

  const { controller: pollAbortController, signal: pollSignal, cleanup: cleanupPollSignal } = createCombinedAbortSignal(signal);
  const pollPromise = runAIUpscaleJobPoll(fileId, jobId, pollSignal).finally(() => {
    cleanupPollSignal();
    const current = activeAIJobPolls.get(pollKey);
    if (current?.promise === pollPromise) {
      activeAIJobPolls.delete(pollKey);
    }
  });

  activeAIJobPolls.set(pollKey, {
    promise: pollPromise,
    abortController: pollAbortController,
    fileId,
    jobId,
  });
  return pollPromise;
}

async function runAIUpscaleJobPoll(fileId, jobId, signal) {
  let lastProgressSignature = null;
  let lastProgressAt = Date.now();

  while (true) {
    ensureAIUpscalePollActive(fileId, jobId, signal);

    let result;
    try {
      result = await getAIUpscaleJob(jobId, { signal });
    } catch (error) {
      const restartError = await maybeResolveAIUpscalePollRestart(fileId, jobId, error, signal);
      if (restartError) throw restartError;
      throw error;
    }
    const phase = result.phase || result.status;
    const progressSignature = getAIUpscaleProgressSignature(result, phase);
    if (progressSignature !== lastProgressSignature) {
      lastProgressSignature = progressSignature;
      lastProgressAt = Date.now();
    }
    const tile = $(`[data-file-id="${fileId}"]`);
    if (tile) {
      syncAIProgress(tile, {
        phase,
        progress: result.progress,
        queuePosition: result.queue_position,
      });
    }

    const entry = state.files.get(fileId);
    if (entry?.upscaleJob?.jobId === jobId) {
      updateFile(fileId, {
        upscaleJob: {
          jobId,
          status: result.status,
          phase,
          progress: result.progress ?? 0,
          queuePosition: result.queue_position ?? null,
          workerInstanceId: result.worker_instance_id || entry.upscaleJob?.workerInstanceId || null,
        },
      });
    }

    if (result.status === 'done') {
      return result;
    }

    if (result.status === 'error') {
      throw new Error(result.error || 'AI upscaling failed');
    }

    if (result.status === 'cancelled' || result.status === 'deleted') {
      throw new DOMException('Cancelled', 'AbortError');
    }

    if (Date.now() - lastProgressAt >= AI_UPSCALE_STALL_TIMEOUT_MS) {
      throw buildAIUpscaleTimeoutError();
    }

    await waitForPoll(getAIUpscalePollInterval(phase), signal);
  }
}

function ensureAIUpscalePollActive(fileId, jobId, signal) {
  if (signal?.aborted) {
    throw new DOMException('Cancelled', 'AbortError');
  }

  const entry = state.files.get(fileId);
  if (!entry) {
    throw new DOMException('Cancelled', 'AbortError');
  }

  if (entry.upscaleJob?.jobId && entry.upscaleJob.jobId !== jobId) {
    throw new DOMException('Cancelled', 'AbortError');
  }
}

function getAIUpscalePollInterval(phase) {
  return AI_UPSCALE_POLL_INTERVALS_MS[phase] || AI_UPSCALE_POLL_INTERVALS_MS.default;
}

async function maybeResolveAIUpscalePollRestart(fileId, jobId, error, signal) {
  if (!error || ![404, 503].includes(error.status)) {
    return null;
  }

  const entry = state.files.get(fileId);
  if (!entry?.upscaleJob || entry.upscaleJob.jobId !== jobId) {
    return null;
  }

  const previousWorkerInstanceId = entry.upscaleJob.workerInstanceId;
  if (!previousWorkerInstanceId) {
    return null;
  }

  const attempts = error.status === 503 ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let health = null;
    try {
      health = await getAIUpscaleHealth({ signal });
    } catch {
      health = null;
    }

    const nextWorkerInstanceId = health?.worker_instance_id || null;
    if (nextWorkerInstanceId && previousWorkerInstanceId !== nextWorkerInstanceId) {
      return buildAIUpscaleRestartError(error.status, nextWorkerInstanceId);
    }

    const workerUnavailable = !health
      || health.httpStatus >= 500
      || health.healthy === false
      || health.state === 'starting';
    if (workerUnavailable) {
      if (attempt < attempts - 1) {
        await waitForPoll(AI_UPSCALE_RESTART_HEALTH_RECHECK_DELAY_MS, signal);
        continue;
      }

      // If the job belonged to a known worker instance and the worker becomes
      // unavailable mid-poll, treat it as a restart window and keep the tile
      // retryable instead of surfacing a generic service error.
      return buildAIUpscaleRestartError(error.status, previousWorkerInstanceId);
    }
  }

  return null;
}

function buildAIUpscaleRestartError(status, workerInstanceId) {
  const restartError = new Error(AI_UPSCALE_RESTART_MESSAGE);
  restartError.code = 'ai_worker_restarted';
  restartError.status = status;
  restartError.retryable = true;
  restartError.workerInstanceId = workerInstanceId;
  return restartError;
}

function buildAIUpscaleTimeoutError() {
  const timeoutError = new Error(AI_UPSCALE_STALL_MESSAGE);
  timeoutError.code = 'ai_upscale_timeout';
  timeoutError.retryable = true;
  return timeoutError;
}

function getAIUpscaleProgressSignature(result, phase) {
  const updatedAt = Number.isFinite(result.updated_at) ? result.updated_at : null;
  const progress = Number.isFinite(result.progress) ? Number(result.progress) : null;
  const queuePosition = Number.isFinite(result.queue_position) ? Number(result.queue_position) : null;
  return JSON.stringify([
    result.status || null,
    phase || null,
    progress,
    queuePosition,
    updatedAt,
  ]);
}

function syncAIProgress(tile, { phase, progress, queuePosition }) {
  const progressEl = tile.querySelector('.tile__progress');
  const progressBar = tile.querySelector('.progress-inline__bar');
  const progressText = tile.querySelector('.tile__progress-text');
  if (!progressEl || !progressBar || !progressText) return;

  const numericProgress = Number.isFinite(progress) ? Math.max(0, Math.min(100, Number(progress))) : null;
  const text = getAIProgressText({ phase, progress: numericProgress, queuePosition });

  if (numericProgress == null) {
    progressBar.classList.add('progress-inline__bar--indeterminate');
    progressBar.style.width = '';
    progressBar.removeAttribute('aria-valuenow');
  } else {
    progressBar.classList.remove('progress-inline__bar--indeterminate');
    progressBar.style.width = `${numericProgress}%`;
    progressBar.setAttribute('aria-valuenow', String(numericProgress));
  }

  progressBar.setAttribute('aria-valuetext', text);
  progressText.textContent = text;
}

function getAIProgressText({ phase, progress, queuePosition }) {
  if (phase === 'queued' && queuePosition > 1) {
    return `Queued • position ${queuePosition}`;
  }
  if (phase === 'queued') {
    return 'Queued';
  }
  if (phase === 'cancelling') {
    return 'Cancelling…';
  }
  if (phase === 'encoding') {
    return 'Encoding final output…';
  }
  if (phase === 'running' && Number.isFinite(progress)) {
    return `Upscaling… ${progress}%`;
  }
  if (phase === 'running') {
    return 'Upscaling…';
  }
  if (phase === 'done') {
    return 'Complete';
  }
  if (phase === 'error') {
    return 'Failed';
  }
  if (phase === 'cancelled') {
    return 'Cancelled';
  }
  return 'Processing…';
}

function waitForPoll(ms, signal) {
  return new Promise((resolve, reject) => {
    let onAbort = null;
    const complete = () => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    };
    const timeoutId = window.setTimeout(complete, ms);
    if (!signal) return;

    onAbort = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function cleanupRemoteResult(fileId) {
  abortAIUpscalePollsForFile(fileId);
  const entry = state.files.get(fileId);
  const jobId = entry?.upscaleJob?.jobId;
  if (!jobId) return;

  try {
    await deleteAIUpscaleJob(jobId);
  } catch (error) {
    if (error.status === 404) return;
    console.error('Failed to clean up AI upscaling job:', error);
  }
}

function syncTileWorkflowControls() {
  const aiMode = isAIUpscaleMode();
  state.files.forEach((entry, fileId) => {
    const tile = $(`[data-file-id="${fileId}"]`);
    if (!tile) return;

    const cropBtn = tile.querySelector('.tile__crop-btn');
    if (!cropBtn) return;

    const outputFormat = (entry.processedData?.metadata?.format || '').toUpperCase();
    const canCrop = !aiMode
      && Boolean(entry.processedData?.data)
      && !entry.artifactRefs?.download?.artifact_id
      && entry.status === 'done'
      && outputFormat !== 'TIFF';

    cropBtn.classList.toggle('is-hidden', !canCrop);
  });
}

/**
 * Update tile UI with processing results.
 */
function updateTileWithResults(tile, metadata, { showSavings = true } = {}) {
  const processedSection = tile.querySelector('.tile__processed');
  processedSection.classList.remove('is-hidden');

  const finalW = metadata.final_dimensions[0];
  const finalH = metadata.final_dimensions[1];

  tile.querySelector('.tile__final-size').textContent = formatFileSize(metadata.compressed_size);
  tile.querySelector('.tile__final-dimensions').textContent = `${finalW} x ${finalH}`;
  tile.querySelector('.tile__final-format').textContent = metadata.format || 'Unknown';

  // Savings overlay (not applicable for AI upscaling where output is intentionally larger)
  if (showSavings) {
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
