/**
 * Upload: file input handling, workspace drag-and-drop, auto-process trigger.
 */
import { $ } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { state, addFile } from '../state/app-state.js';
import { showToast } from '../components/toast.js';
import { createImageTile } from './image-tile.js';

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']);
const ACCEPTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif']);
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export function initApp() {
  const fileInput = $('#file-input');
  const workspace = $('.workspace');
  const workspaceEmpty = $('#workspace-empty');
  const browseBtn = $('#workspace-browse-btn');
  const addMoreBtn = $('#add-more-btn');

  if (!fileInput) return;

  // Prevent default drag behaviors on the whole window
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    document.body.addEventListener(evt, (e) => e.preventDefault());
  });

  // File input change handler
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFiles(e.target.files);
      fileInput.value = ''; // Allow re-selecting same files
    }
  });

  // Empty state — drag/drop + click-to-browse
  if (workspaceEmpty) {
    workspaceEmpty.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        const allRejected = Array.from(e.dataTransfer.items).every(
          (item) => item.kind === 'file' && item.type && !ACCEPTED_TYPES.has(item.type)
        );
        if (allRejected) {
          workspace?.classList.add('is-dragover-reject');
          workspaceEmpty.classList.remove('is-dragover');
          return;
        }
      }
      workspace?.classList.remove('is-dragover-reject');
      workspaceEmpty.classList.add('is-dragover');
    });

    workspaceEmpty.addEventListener('dragleave', (e) => {
      if (!workspaceEmpty.contains(e.relatedTarget)) {
        workspaceEmpty.classList.remove('is-dragover');
        workspace?.classList.remove('is-dragover-reject');
      }
    });

    workspaceEmpty.addEventListener('drop', (e) => {
      e.preventDefault();
      workspaceEmpty.classList.remove('is-dragover');
      workspace?.classList.remove('is-dragover-reject');
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    });

    workspaceEmpty.addEventListener('click', (e) => {
      if (e.target.closest('#workspace-browse-btn')) return;
      if (e.target.closest('#settings-panel')) return;
      fileInput.click();
    });
  }

  // CTA button in empty state
  if (browseBtn) {
    browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
  }

  // Add More button in toolbar
  if (addMoreBtn) {
    addMoreBtn.addEventListener('click', () => fileInput.click());
  }

  // Workspace-level drag handlers (active when grid is visible)
  if (workspace) {
    workspace.addEventListener('dragover', (e) => {
      e.preventDefault();
      // Only show drag feedback when image grid is visible
      const imageGrid = $('#image-grid');
      if (!imageGrid || imageGrid.classList.contains('is-hidden')) return;
      if (e.dataTransfer.types.includes('Files')) {
        workspace.classList.add('is-dragover');
      }
    });

    workspace.addEventListener('dragleave', (e) => {
      if (!workspace.contains(e.relatedTarget)) {
        workspace.classList.remove('is-dragover');
      }
    });

    workspace.addEventListener('drop', (e) => {
      e.preventDefault();
      workspace.classList.remove('is-dragover');
      const imageGrid = $('#image-grid');
      if (!imageGrid || imageGrid.classList.contains('is-hidden')) return;
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    });
  }

  // Restore empty state when all files cleared
  bus.on('files:cleared', () => {
    showEmptyState();
  });

  bus.on('files:countChanged', ({ total }) => {
    if (total === 0) {
      showEmptyState();
    }
  });
}

function showEmptyState() {
  const emptyState = $('#workspace-empty');
  const imageGrid = $('#image-grid');
  if (emptyState) emptyState.classList.remove('is-hidden');
  if (imageGrid) {
    imageGrid.classList.add('is-hidden');
    const tiles = imageGrid.querySelectorAll('.tile');
    tiles.forEach((tile) => tile.remove());
  }
}

/**
 * Unified file handling — single path for drag-and-drop and click.
 * Auto-triggers processing after files are added.
 */
function handleFiles(fileList) {
  const emptyState = $('#workspace-empty');
  const imageGrid = $('#image-grid');
  let addedCount = 0;
  const rejected = [];
  const newFileIds = [];

  Array.from(fileList).forEach((file) => {
    if (!isValidFile(file)) {
      rejected.push(file.name);
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      showToast({
        message: `"${file.name}" is too large (${sizeMB} MB). Maximum is 50 MB.`,
        type: 'warning',
        duration: 7000,
      });
      return;
    }

    const fileId = crypto.randomUUID();
    const blobUrl = URL.createObjectURL(file);

    addFile(fileId, file, blobUrl);
    createImageTile(fileId, file, blobUrl);
    newFileIds.push(fileId);
    addedCount++;
  });

  // Show aggregated rejection toast
  if (rejected.length > 0) {
    const names = rejected.length <= 3
      ? rejected.map((n) => `"${n}"`).join(', ')
      : `${rejected.length} files`;
    showToast({
      message: `${names} not supported. Use JPG, PNG, WebP, or TIFF.`,
      type: 'warning',
    });
  }

  if (addedCount > 0) {
    // Show workspace, hide empty state
    if (emptyState) emptyState.classList.add('is-hidden');
    if (imageGrid) imageGrid.classList.remove('is-hidden');

    // Show toolbar
    bus.emit('files:countChanged', { total: state.files.size });

    // Feedback toast and scroll when adding to existing batch
    if (state.files.size > addedCount) {
      showToast({
        message: `Added ${addedCount} image${addedCount > 1 ? 's' : ''}`,
        type: 'info',
        duration: 2000,
      });
      imageGrid?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Auto-process newly added files
    bus.emit('files:autoProcess', { fileIds: newFileIds });
  }
}

function isValidFile(file) {
  if (ACCEPTED_TYPES.has(file.type)) return true;
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  return ACCEPTED_EXTENSIONS.has(ext);
}
