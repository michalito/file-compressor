/**
 * Crop feature: modal management, preset ratios, server communication.
 */
import { $, base64ToUint8Array, formatToMime } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { postJSON } from '../lib/api.js';
import { state, updateFile } from '../state/app-state.js';
import { showToast } from '../components/toast.js';
import { openModal, closeModal } from '../components/modal.js';
import { CropInteraction } from './crop-interaction.js';

const ASPECT_RATIOS = {
  'free': null,
  '1:1': 1,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
};

let currentFileId = null;
let cropInteraction = null;

/**
 * Initialize crop feature — wire up modal controls.
 */
export function initCrop() {
  const modal = $('#crop-modal');
  if (!modal) return;

  // Close button
  const closeBtn = $('#crop-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeCropModal);

  // Cancel button
  const cancelBtn = $('#crop-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeCropModal);

  // Apply button
  const applyBtn = $('#crop-apply');
  if (applyBtn) applyBtn.addEventListener('click', applyCrop);

  // Intercept Escape in capture phase so closeCropModal runs
  // Capture-phase listeners so closeCropModal (with full cleanup) runs
  // before the generic closeModal in modal.js (which uses bubble phase).
  // stopImmediatePropagation prevents the generic handler from also firing.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentFileId) {
      e.stopImmediatePropagation();
      closeCropModal();
    }
  }, true);

  modal.addEventListener('click', (e) => {
    if (e.target === modal && currentFileId) {
      e.stopImmediatePropagation();
      closeCropModal();
    }
  }, true);

  // Ratio preset buttons
  initRatioControl();
}

/**
 * Initialize the ratio segmented control.
 */
function initRatioControl() {
  const control = $('#crop-ratio-control');
  if (!control) return;

  const buttons = control.querySelectorAll('.segmented-control__item');

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      // Update active state
      buttons.forEach((b) => {
        b.classList.remove('is-active');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('is-active');
      btn.setAttribute('aria-checked', 'true');

      // Apply ratio
      const value = btn.dataset.value;
      const ratio = ASPECT_RATIOS[value] ?? null;
      if (cropInteraction) {
        cropInteraction.setAspectRatio(ratio);
      }
    });

    // Arrow key navigation
    btn.addEventListener('keydown', (e) => {
      const btns = Array.from(buttons);
      const idx = btns.indexOf(btn);
      let next = -1;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        next = (idx + 1) % btns.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        next = (idx - 1 + btns.length) % btns.length;
      }

      if (next >= 0) {
        e.preventDefault();
        btns[next].focus();
        btns[next].click();
      }
    });
  });
}

/**
 * Open the crop modal for a specific file.
 * @param {string} fileId
 */
export function openCropModal(fileId) {
  const entry = state.files.get(fileId);
  if (!entry?.processedData) return;

  currentFileId = fileId;

  // Reset ratio to Free
  resetRatioControl();

  const img = $('#crop-image');

  // Destroy previous interaction if any
  if (cropInteraction) {
    cropInteraction.destroy();
    cropInteraction = null;
  }

  // Update dimension display
  const dimEl = $('#crop-dimensions');
  if (dimEl) dimEl.textContent = 'Loading...';

  // Load image and initialize crop interaction
  img.onload = () => {
    // Open modal first so the image is laid out and getBoundingClientRect works
    openModal('crop-modal');
    // Defer interaction init to next frame so layout is computed
    requestAnimationFrame(() => {
      cropInteraction = new CropInteraction(
        $('#crop-canvas-area'),
        img,
        (coords) => {
          if (dimEl) {
            dimEl.textContent = `${coords.width} \u00d7 ${coords.height} px`;
          }
        }
      );
    });
  };
  img.onerror = () => {
    showToast({ message: 'Failed to load image for cropping', type: 'error' });
  };
  img.src = entry.blobUrl;
}

/**
 * Reset ratio control to "Free".
 */
function resetRatioControl() {
  const control = $('#crop-ratio-control');
  if (!control) return;

  const buttons = control.querySelectorAll('.segmented-control__item');
  buttons.forEach((b) => {
    const isFree = b.dataset.value === 'free';
    b.classList.toggle('is-active', isFree);
    b.setAttribute('aria-checked', isFree ? 'true' : 'false');
  });
}

/**
 * Close the crop modal and clean up.
 */
function closeCropModal() {
  if (cropInteraction) {
    cropInteraction.destroy();
    cropInteraction = null;
  }
  currentFileId = null;
  closeModal('crop-modal');

  // Clear image src to free memory
  const img = $('#crop-image');
  if (img) img.src = '';
}

/**
 * Apply the crop: send coordinates to server, update state.
 */
async function applyCrop() {
  if (!cropInteraction || !currentFileId) return;

  const entry = state.files.get(currentFileId);
  if (!entry?.processedData) return;

  const coords = cropInteraction.getImageCoordinates();

  // Check if crop is the full image (no-op)
  const meta = entry.processedData.metadata;
  const [imgW, imgH] = meta.final_dimensions;
  if (coords.x === 0 && coords.y === 0 && coords.width === imgW && coords.height === imgH) {
    closeCropModal();
    return;
  }

  const applyBtn = $('#crop-apply');
  const cancelBtn = $('#crop-cancel');
  const fileId = currentFileId;

  try {
    // Disable buttons during request
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Cropping...'; }
    if (cancelBtn) cancelBtn.disabled = true;

    const response = await postJSON('/crop', {
      compressed_data: entry.processedData.data,
      filename: entry.processedData.filename,
      crop: coords,
    });

    const result = await response.json();

    // Preserve the original upload's size/dimensions so savings
    // percentage stays relative to the upload, not the pre-crop size
    const prevMeta = entry.processedData.metadata;
    const mergedMetadata = {
      ...result.metadata,
      original_size: prevMeta.original_size,
      original_dimensions: prevMeta.original_dimensions,
    };

    // Stash the original upload before the first crop so it can be recovered
    if (!entry.originalFile) {
      updateFile(fileId, { originalFile: entry.file });
    }

    // Promote cropped data to a File so reprocessing uses the cropped image
    const mimeType = formatToMime(result.metadata.format);
    const croppedBytes = base64ToUint8Array(result.compressed_data);
    const croppedFile = new File([croppedBytes], result.filename, { type: mimeType });
    const newBlobUrl = URL.createObjectURL(croppedFile);
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);

    // Update state: new file source, blob URL, and processed data.
    // Note: processedWithSettings is intentionally left unchanged — crop doesn't
    // alter compression settings, so re-process detection should only trigger
    // when the user changes settings, not from cropping alone.
    updateFile(fileId, {
      file: croppedFile,
      blobUrl: newBlobUrl,
      processedData: {
        data: result.compressed_data,
        filename: result.filename,
        metadata: mergedMetadata,
      },
    });

    // Emit crop event for tile update
    bus.emit('file:cropped', { fileId, metadata: mergedMetadata });

    closeCropModal();
    showToast({ message: 'Image cropped successfully', type: 'success' });

  } catch (error) {
    console.error('Crop error:', error);
    showToast({ message: `Crop failed: ${error.message}`, type: 'error' });
  } finally {
    if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply Crop'; }
    if (cancelBtn) cancelBtn.disabled = false;
  }
}
