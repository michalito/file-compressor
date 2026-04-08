/**
 * Crop & rotate feature: modal management, preset ratios, rotation preview,
 * and server communication.
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

// Rotation state
let currentRotation = 0;          // 0, 90, 180, 270 (degrees clockwise)
let rotatedBlobUrl = null;         // Blob URL for the rotated preview (for cleanup)
let originalImage = null;          // Persistent Image element of the unrotated source
let rotateGeneration = 0;          // Monotonic counter to discard stale toBlob callbacks

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

  // Rotate buttons
  const rotateCcwBtn = $('#rotate-ccw');
  if (rotateCcwBtn) rotateCcwBtn.addEventListener('click', () => rotatePreview(-1));

  const rotateCwBtn = $('#rotate-cw');
  if (rotateCwBtn) rotateCwBtn.addEventListener('click', () => rotatePreview(1));

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
  currentRotation = 0;

  // Clean up prior rotation state
  if (rotatedBlobUrl) {
    URL.revokeObjectURL(rotatedBlobUrl);
    rotatedBlobUrl = null;
  }

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

  // Capture the original image for rotation reference.
  // All canvas rotations derive from this to avoid quality degradation.
  originalImage = new Image();
  originalImage.src = entry.blobUrl;

  // Load image and initialize crop interaction
  img.onload = () => {
    // Open modal first so the image is laid out and getBoundingClientRect works
    openModal('crop-modal');
    // Defer interaction init to next frame so layout is computed
    requestAnimationFrame(() => {
      initCropInteraction();
    });
  };
  img.onerror = () => {
    showToast({ message: 'Failed to load image for editing', type: 'error' });
  };
  img.src = entry.blobUrl;
}

/**
 * Create (or recreate) the CropInteraction on the current image.
 */
function initCropInteraction() {
  const img = $('#crop-image');
  const dimEl = $('#crop-dimensions');

  if (cropInteraction) {
    cropInteraction.destroy();
    cropInteraction = null;
  }

  cropInteraction = new CropInteraction(
    $('#crop-canvas-area'),
    img,
    (coords) => {
      if (dimEl) {
        dimEl.textContent = `${coords.width} \u00d7 ${coords.height} px`;
      }
    }
  );
}

/**
 * Rotate the preview image by 90 degrees.
 *
 * Uses a generation counter to prevent stale toBlob callbacks from
 * overwriting a newer preview or running after the modal has closed.
 * CropInteraction is destroyed at the start so applyCrop is a no-op
 * while the async preview swap is in flight.
 *
 * @param {number} direction  1 = clockwise, -1 = counter-clockwise
 */
function rotatePreview(direction) {
  if (!originalImage || !originalImage.naturalWidth || !currentFileId) return;

  currentRotation = (currentRotation + direction * 90 + 360) % 360;
  const gen = ++rotateGeneration;

  // Tear down the current crop interaction immediately so applyCrop
  // cannot submit coordinates from the old orientation while the
  // async preview swap is in flight.
  if (cropInteraction) {
    cropInteraction.destroy();
    cropInteraction = null;
  }

  const img = $('#crop-image');
  const dimEl = $('#crop-dimensions');

  // Reset ratio to Free on rotation (dimensions change for 90/270)
  resetRatioControl();

  if (dimEl) dimEl.textContent = 'Rotating...';

  // If rotation is back to 0, restore the original image directly
  if (currentRotation === 0) {
    if (rotatedBlobUrl) {
      URL.revokeObjectURL(rotatedBlobUrl);
      rotatedBlobUrl = null;
    }

    img.onload = () => {
      if (gen !== rotateGeneration) return;
      requestAnimationFrame(() => initCropInteraction());
    };
    const entry = state.files.get(currentFileId);
    img.src = entry ? entry.blobUrl : originalImage.src;
    return;
  }

  // Draw the original image rotated onto an off-screen canvas
  const srcW = originalImage.naturalWidth;
  const srcH = originalImage.naturalHeight;
  const swap = currentRotation === 90 || currentRotation === 270;

  const canvas = document.createElement('canvas');
  canvas.width = swap ? srcH : srcW;
  canvas.height = swap ? srcW : srcH;

  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((currentRotation * Math.PI) / 180);
  ctx.drawImage(originalImage, -srcW / 2, -srcH / 2);

  // Convert canvas to blob and swap the image src.
  // The generation check discards this callback if a newer rotation
  // was started or if the modal was closed in the meantime.
  canvas.toBlob((blob) => {
    if (gen !== rotateGeneration || !blob) return;

    // Revoke previous rotated blob
    if (rotatedBlobUrl) {
      URL.revokeObjectURL(rotatedBlobUrl);
    }
    rotatedBlobUrl = URL.createObjectURL(blob);

    img.onload = () => {
      if (gen !== rotateGeneration) return;
      requestAnimationFrame(() => initCropInteraction());
    };
    img.src = rotatedBlobUrl;
  }, 'image/png');
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

  // Clean up rotation state and invalidate any in-flight toBlob callbacks
  currentRotation = 0;
  rotateGeneration++;
  originalImage = null;
  if (rotatedBlobUrl) {
    URL.revokeObjectURL(rotatedBlobUrl);
    rotatedBlobUrl = null;
  }

  currentFileId = null;
  closeModal('crop-modal');

  // Clear image src to free memory
  const img = $('#crop-image');
  if (img) img.src = '';
}

/**
 * Apply the edit: send rotation + crop coordinates to server, update state.
 */
async function applyCrop() {
  if (!cropInteraction || !currentFileId) return;

  const entry = state.files.get(currentFileId);
  if (!entry?.processedData) return;

  const coords = cropInteraction.getImageCoordinates();
  const hasRotation = currentRotation !== 0;

  // Check if this is a no-op (no rotation AND crop covers the full image)
  if (!hasRotation) {
    const meta = entry.processedData.metadata;
    const [imgW, imgH] = meta.final_dimensions;
    if (coords.x === 0 && coords.y === 0 && coords.width === imgW && coords.height === imgH) {
      closeCropModal();
      return;
    }
  }

  const modalButtons = [
    $('#crop-apply'), $('#crop-cancel'), $('#rotate-ccw'), $('#rotate-cw'),
  ];
  const fileId = currentFileId;
  const applyBtn = modalButtons[0];

  try {
    // Disable controls during request
    for (const btn of modalButtons) if (btn) btn.disabled = true;
    if (applyBtn) applyBtn.textContent = 'Applying...';

    const response = await postJSON('/crop', {
      compressed_data: entry.processedData.data,
      filename: entry.processedData.filename,
      rotation: currentRotation,
      crop: coords,
    });

    const result = await response.json();

    // Preserve the original upload's size/dimensions so savings
    // percentage stays relative to the upload, not the pre-edit size
    const prevMeta = entry.processedData.metadata;
    const mergedMetadata = {
      ...result.metadata,
      original_size: prevMeta.original_size,
      original_dimensions: prevMeta.original_dimensions,
    };

    // Stash the original upload before the first edit so it can be recovered
    if (!entry.originalFile) {
      updateFile(fileId, { originalFile: entry.file });
    }

    // Promote edited data to a File so reprocessing uses the edited image
    const mimeType = formatToMime(result.metadata.format);
    const editedBytes = base64ToUint8Array(result.compressed_data);
    const editedFile = new File([editedBytes], result.filename, { type: mimeType });
    const newBlobUrl = URL.createObjectURL(editedFile);
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);

    // Update state: new file source, blob URL, and processed data.
    // processedWithSettings is intentionally left unchanged -- edits don't
    // alter compression settings, so re-process detection should only trigger
    // when the user changes settings, not from editing alone.
    updateFile(fileId, {
      file: editedFile,
      blobUrl: newBlobUrl,
      processedData: {
        data: result.compressed_data,
        filename: result.filename,
        metadata: mergedMetadata,
      },
    });

    bus.emit('file:cropped', { fileId, metadata: mergedMetadata });

    closeCropModal();

    // Contextual success message
    const wasRotated = result.metadata.rotated;
    const wasCropped = result.metadata.cropped;
    let message = 'Image edited successfully';
    if (wasRotated && wasCropped) message = 'Image rotated and cropped';
    else if (wasRotated) message = 'Image rotated successfully';
    else if (wasCropped) message = 'Image cropped successfully';
    showToast({ message, type: 'success' });

  } catch (error) {
    console.error('Edit error:', error);
    showToast({ message: `Edit failed: ${error.message}`, type: 'error' });
  } finally {
    for (const btn of modalButtons) if (btn) btn.disabled = false;
    if (applyBtn) applyBtn.textContent = 'Apply';
  }
}
