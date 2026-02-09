/**
 * Batch operations: selection, queue processing, ZIP download.
 */
import { $, $$, downloadBlob } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { postJSON } from '../lib/api.js';
import { state, selectAll } from '../state/app-state.js';
import { processTile, base64ToUint8Array } from './image-tile.js';
import { showToast } from '../components/toast.js';
import { globalProgress } from '../components/progress.js';

let processing = false;
let cancelled = false;
const CHUNK_SIZE = 5;

export function initBatch() {
  const selectAllCheckbox = $('#select-all');
  const processBtn = $('#process-selected');
  const downloadBtn = $('#download-selected');
  const cancelBtn = $('#cancel-batch');
  const panelToggle = $('#tool-panel-toggle');

  // Select All
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', (e) => {
      const checked = e.target.checked;
      selectAll(checked);

      // Update individual checkboxes
      $$('.tile__select').forEach((cb) => {
        cb.checked = checked;
        cb.closest('.tile')?.classList.toggle('is-selected', checked);
      });
    });
  }

  // Process Selected
  if (processBtn) {
    processBtn.addEventListener('click', () => processSelected());
  }

  // Download Selected
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => downloadSelected());
  }

  // Cancel batch
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      cancelled = true;
    });
  }

  // Mobile tool panel toggle
  if (panelToggle) {
    panelToggle.addEventListener('click', () => {
      const panel = $('#tool-panel');
      if (panel) panel.classList.toggle('is-collapsed');
    });
  }

  // Listen for file count changes to show/hide action bar
  bus.on('files:countChanged', ({ total }) => {
    const actionBar = $('#action-bar');
    if (actionBar) {
      actionBar.classList.toggle('is-hidden', total === 0);
    }
    const el = $('#total-files-count');
    if (el) el.textContent = total;
  });

  // Listen for selection changes to update UI
  bus.on('selection:changed', ({ selected }) => {
    const hasSelection = selected > 0;
    if (processBtn) processBtn.disabled = !hasSelection;
    if (downloadBtn) downloadBtn.disabled = !hasSelection;
    const el = $('#selected-files-count');
    if (el) el.textContent = selected;
  });
}

/**
 * Process all selected files.
 * Delegates per-tile processing to image-tile.js processTile().
 */
async function processSelected() {
  if (processing) return;

  const selectedIds = [...state.selectedFiles];
  if (selectedIds.length === 0) return;

  processing = true;
  cancelled = false;

  const batchProgressEl = $('#batch-progress');
  const processedCountEl = $('#processed-count');
  const totalCountEl = $('#total-count');
  const timeRemainingEl = $('#time-remaining');
  const progressBar = $('#batch-progress-bar');

  const total = selectedIds.length;
  let processed = 0;
  const startTime = Date.now();

  // Show batch progress
  if (batchProgressEl) batchProgressEl.classList.remove('is-hidden');
  if (totalCountEl) totalCountEl.textContent = total;
  if (processedCountEl) processedCountEl.textContent = 0;

  globalProgress.show();

  // Process in chunks, delegating each tile to processTile()
  const queue = [...selectedIds];

  while (queue.length > 0 && !cancelled) {
    const chunk = queue.splice(0, CHUNK_SIZE);

    await Promise.all(
      chunk.map(async (fileId) => {
        const entry = state.files.get(fileId);
        if (!entry || entry.status === 'done') {
          processed++;
          updateBatchProgress(processed, total, startTime, processedCountEl, progressBar, timeRemainingEl);
          return;
        }

        try {
          await processTile(fileId, { skipGlobalProgress: true });
        } catch (error) {
          console.error(`Batch processing error for ${fileId}:`, error);
        }

        processed++;
        updateBatchProgress(processed, total, startTime, processedCountEl, progressBar, timeRemainingEl);
      })
    );
  }

  // Cleanup
  processing = false;
  globalProgress.hide();
  if (batchProgressEl) {
    setTimeout(() => batchProgressEl.classList.add('is-hidden'), 1000);
  }

  if (!cancelled) {
    showToast({ message: `Processed ${processed} images`, type: 'success' });
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

/**
 * Download all selected processed files (single or ZIP).
 */
async function downloadSelected() {
  const selectedIds = [...state.selectedFiles];
  const processedIds = selectedIds.filter((id) => {
    const entry = state.files.get(id);
    return entry?.processedData;
  });

  if (processedIds.length === 0) {
    showToast({ message: 'No processed images to download', type: 'warning' });
    return;
  }

  if (processedIds.length === 1) {
    // Single file download via /download endpoint
    const entry = state.files.get(processedIds[0]);
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

    for (const fileId of processedIds) {
      const entry = state.files.get(fileId);
      if (entry?.processedData) {
        const binaryData = base64ToUint8Array(entry.processedData.data);
        zip.file(entry.processedData.filename, binaryData);
      }
    }

    const content = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    downloadBlob(content, 'processed_images.zip');
    showToast({ message: `Downloaded ${processedIds.length} images as ZIP`, type: 'success' });
  } catch (error) {
    console.error('ZIP creation error:', error);
    showToast({ message: 'Failed to create ZIP file', type: 'error' });
  } finally {
    globalProgress.hide();
  }
}

