import { $, $$ } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import {
  state,
  getEffectiveWatermarkState,
  setWatermarkPreviewFileId,
} from '../state/app-state.js';
import { ensureWatermarkFont } from '../lib/watermark.js';
import { renderWatermarkPreviewCanvas } from '../lib/watermark-preview-renderer.js';

let renderGeneration = 0;
let sourceCache = { fileId: null, file: null, image: null };
const assetImageCache = new Map();

const STATE_CONFIG = {
  empty:       { icon: 'icon-image',        heading: 'No image yet',        sub: 'Upload a file to see your watermark.' },
  disabled:    { icon: 'icon-eye-off',       heading: 'Watermark is off',    sub: 'Enable the toggle above to preview.' },
  inactive:    { icon: 'icon-type',          heading: 'No content added',    sub: 'Add text, a logo, or a QR code.' },
  unsupported: { icon: 'icon-alert-circle',  heading: 'Preview unavailable', sub: 'This format can\'t render in your browser.' },
};

export function initWatermarkPreview() {
  const canvas = $('#watermark-preview-canvas');
  if (!canvas) return;

  void ensureWatermarkFont().then(() => renderPreview());

  bus.on('files:added', ({ fileId }) => {
    if (!state.ui.watermarkPreviewFileId || !state.files.has(state.ui.watermarkPreviewFileId)) {
      setWatermarkPreviewFileId(fileId);
      return;
    }

    renderPreview();
    syncSelectedTile();
  });

  bus.on('files:removed', ({ fileId }) => {
    if (sourceCache.fileId === fileId) {
      sourceCache = { fileId: null, file: null, image: null };
    }

    if (state.ui.watermarkPreviewFileId === fileId) {
      setWatermarkPreviewFileId(getFirstFileId());
      return;
    }

    renderPreview();
    syncSelectedTile();
  });

  bus.on('files:cleared', () => {
    sourceCache = { fileId: null, file: null, image: null };
    renderPreview();
    syncSelectedTile();
  });

  bus.on('file:updated', ({ fileId, file }) => {
    if (file && state.ui.watermarkPreviewFileId === fileId) {
      sourceCache = { fileId: null, file: null, image: null };
      renderPreview();
    }
  });

  bus.on('file:cropped', ({ fileId }) => {
    if (state.ui.watermarkPreviewFileId === fileId) {
      sourceCache = { fileId: null, file: null, image: null };
      renderPreview();
    }
  });

  bus.on('settings:changed', ({ tool }) => {
    if (tool === 'watermark') {
      renderPreview();
    }
  });

  bus.on('watermark:logoChanged', () => {
    assetImageCache.clear();
    renderPreview();
  });

  bus.on('watermark:qrChanged', () => {
    assetImageCache.clear();
    renderPreview();
  });

  bus.on('watermark:previewFileChanged', () => {
    syncSelectedTile();
    renderPreview();
  });

  if (!state.ui.watermarkPreviewFileId && state.files.size > 0) {
    setWatermarkPreviewFileId(getFirstFileId());
    return;
  }

  syncSelectedTile();
  renderPreview();
}

function getFirstFileId() {
  return state.files.keys().next().value || null;
}

function ensurePreviewSelection() {
  if (state.ui.watermarkPreviewFileId && state.files.has(state.ui.watermarkPreviewFileId)) {
    return state.ui.watermarkPreviewFileId;
  }

  const fallback = getFirstFileId();
  if (fallback !== state.ui.watermarkPreviewFileId) {
    setWatermarkPreviewFileId(fallback);
  }

  return fallback;
}

function syncSelectedTile() {
  const selectedId = ensurePreviewSelection();
  $$('.tile').forEach((tile) => {
    tile.classList.toggle('tile--preview-selected', tile.dataset.fileId === selectedId);
  });
}

function setPreviewState(stateKey, _message) {
  const stateEl = $('#watermark-preview-state');
  const viewportEl = $('#watermark-preview-viewport');
  if (!stateEl) return;

  stateEl.dataset.state = stateKey;

  if (viewportEl) viewportEl.classList.toggle('is-active', stateKey === 'ready');

  const config = STATE_CONFIG[stateKey];
  if (!config) {
    stateEl.replaceChildren();
    stateEl.classList.add('is-hidden');
    return;
  }

  const NS = 'http://www.w3.org/2000/svg';

  const iconWrap = document.createElement('span');
  iconWrap.className = 'watermark-preview-card__state-icon';
  iconWrap.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#' + config.icon);
  svg.appendChild(use);
  iconWrap.appendChild(svg);

  const heading = document.createElement('span');
  heading.className = 'watermark-preview-card__state-heading';
  heading.textContent = config.heading;

  const sub = document.createElement('span');
  sub.className = 'watermark-preview-card__state-sub';
  sub.textContent = config.sub;

  stateEl.replaceChildren(iconWrap, heading, sub);
  stateEl.classList.remove('is-hidden');
}

function updatePreviewSourceName(name) {
  const el = $('#watermark-preview-source-name');
  if (el) el.textContent = name || '';
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Image could not be decoded in this browser.'));
    image.src = url;
  });
}

async function loadSourceImage(fileId, entry) {
  if (sourceCache.fileId === fileId && sourceCache.file === entry.file && sourceCache.image) {
    return sourceCache.image;
  }

  const objectUrl = URL.createObjectURL(entry.file);

  try {
    const image = await loadImageFromUrl(objectUrl);
    sourceCache = { fileId, file: entry.file, image };
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadAssetImage(url) {
  if (!url) return null;
  if (!assetImageCache.has(url)) {
    assetImageCache.set(url, loadImageFromUrl(url));
  }
  return assetImageCache.get(url);
}

async function renderPreview() {
  const canvas = $('#watermark-preview-canvas');
  if (!canvas) return;

  const generation = ++renderGeneration;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const fileId = ensurePreviewSelection();
  const entry = fileId ? state.files.get(fileId) : null;
  updatePreviewSourceName(entry?.file?.name || null);

  if (!entry) {
    setPreviewState('empty', 'Upload an image to preview watermark placement.');
    return;
  }

  if (!state.settings.watermark.enabled) {
    setPreviewState('disabled', 'Enable Watermark to preview placement.');
    return;
  }

  const watermark = getEffectiveWatermarkState();
  if (!watermark.enabled) {
    setPreviewState('inactive', 'Add text, logo, or QR content to preview watermark placement.');
    return;
  }

  try {
    const image = await loadSourceImage(fileId, entry);
    if (generation !== renderGeneration) return;

    const [logoImage, qrImage] = await Promise.all([
      watermark.logo.enabled && state.runtime.watermarkLogo?.objectUrl
        ? loadAssetImage(state.runtime.watermarkLogo.objectUrl)
        : Promise.resolve(null),
      watermark.qr.enabled && state.runtime.watermarkQr?.objectUrl
        ? loadAssetImage(state.runtime.watermarkQr.objectUrl)
        : Promise.resolve(null),
    ]);
    if (generation !== renderGeneration) return;

    await renderWatermarkPreviewCanvas(canvas, image, watermark, {
      logoImage,
      qrImage,
    });

    if (generation !== renderGeneration) return;
    setPreviewState('ready', null);
  } catch (error) {
    if (generation !== renderGeneration) return;
    console.error('Watermark preview failed:', error);
    setPreviewState('unsupported', 'This image format cannot be previewed in your browser. Processing still works on the server.');
  }
}
