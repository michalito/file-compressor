/**
 * Upload: drop zone + file input handling.
 * Unified handleFiles() path for both drag-and-drop and click-to-browse.
 */
import { $, $$ } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { state, addFile } from '../state/app-state.js';
import { showToast } from '../components/toast.js';
import { createImageTile } from './image-tile.js';

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']);
const ACCEPTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif']);

export function initApp() {
  const dropZone = $('.drop-zone');
  const fileInput = $('#file-input');
  const workspace = $('.workspace');

  if (!dropZone || !fileInput) return;

  // Prevent default drag behaviors on the whole window
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    document.body.addEventListener(evt, (e) => e.preventDefault());
  });

  // Drop zone visual feedback
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('is-dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('is-dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  });

  // Click to browse
  dropZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFiles(e.target.files);
      fileInput.value = ''; // Allow re-selecting same files
    }
  });

  // Keyboard accessibility
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
}

/**
 * Unified file handling — single path for drag-and-drop and click.
 */
function handleFiles(fileList) {
  const emptyState = $('.workspace__empty');
  const imageGrid = $('.image-grid');
  let addedCount = 0;

  Array.from(fileList).forEach((file) => {
    if (!isValidFile(file)) {
      showToast({
        message: `"${file.name}" is not a supported image format`,
        type: 'warning',
      });
      return;
    }

    const fileId = crypto.randomUUID();
    const blobUrl = URL.createObjectURL(file);

    addFile(fileId, file, blobUrl);
    createImageTile(fileId, file, blobUrl);
    addedCount++;
  });

  if (addedCount > 0) {
    // Show workspace, hide empty state
    if (emptyState) emptyState.classList.add('is-hidden');
    if (imageGrid) imageGrid.classList.remove('is-hidden');

    // Show action bar
    bus.emit('files:countChanged', { total: state.files.size });
  }
}

function isValidFile(file) {
  // Check MIME type
  if (ACCEPTED_TYPES.has(file.type)) return true;

  // Fallback: check extension
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  return ACCEPTED_EXTENSIONS.has(ext);
}
