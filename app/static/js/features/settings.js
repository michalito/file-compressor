/**
 * Settings: modals, localStorage persistence, tool registry pattern.
 */
import { $, $$ } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import { state, updateSettings, getSettings } from '../state/app-state.js';
import { openModal, closeModal } from '../components/modal.js';

/* ── Tool Registry ─────────────────────────────────────────────────── */

const tools = {
  compress: {
    id: 'compress',
    label: 'Compression',
    modalId: 'compression-modal',
    summaryId: 'compress-summary',
    defaultSettings: { mode: 'lossless', outputFormat: 'auto' },

    renderSummary(settings) {
      const modes = {
        lossless: 'Lossless',
        web: 'Web Optimized',
        high: 'Max Compression',
      };
      const label = modes[settings.mode] || 'Unknown';
      if (settings.mode === 'lossless') return label;
      const formats = { auto: 'Auto', webp: 'WebP', jpeg: 'JPEG' };
      return `${label} (${formats[settings.outputFormat] || 'Auto'})`;
    },

    applyToModal(settings) {
      const radio = $(`input[name="compression-type"][value="${settings.mode}"]`);
      if (radio) radio.checked = true;

      const formatRadio = $(`input[name="output-format"][value="${settings.outputFormat}"]`);
      if (formatRadio) formatRadio.checked = true;

      toggleOutputFormatSection();
    },

    readFromModal() {
      const mode = $('input[name="compression-type"]:checked')?.value || 'lossless';
      const outputFormat = $('input[name="output-format"]:checked')?.value || 'auto';
      return { mode, outputFormat };
    },

    toFormData(settings, formData) {
      formData.append('compression_mode', settings.mode);
      if (settings.mode !== 'lossless') {
        formData.append('output_format', settings.outputFormat || 'auto');
      }
    },
  },

  resize: {
    id: 'resize',
    label: 'Resize',
    modalId: 'resize-modal',
    summaryId: 'resize-summary',
    defaultSettings: { mode: 'original', width: null, height: null },

    renderSummary(settings) {
      if (settings.mode === 'original') return 'Original Size';
      if (settings.width && settings.height) {
        return `${settings.width} x ${settings.height}px`;
      }
      return 'Custom Size';
    },

    applyToModal(settings) {
      const radio = $(`input[name="resize-type"][value="${settings.mode}"]`);
      if (radio) radio.checked = true;

      const customControls = $('.custom-size-controls');
      if (customControls) {
        customControls.classList.toggle('is-hidden', settings.mode !== 'custom');
      }

      const widthInput = $('#custom-width');
      const heightInput = $('#custom-height');

      if (widthInput && settings.width) widthInput.value = settings.width;
      if (heightInput && settings.height) heightInput.value = settings.height;
    },

    readFromModal() {
      const mode = $('input[name="resize-type"]:checked')?.value || 'original';
      return {
        mode,
        width: mode === 'custom' ? (parseInt($('#custom-width')?.value, 10) || null) : null,
        height: mode === 'custom' ? (parseInt($('#custom-height')?.value, 10) || null) : null,
      };
    },

    toFormData(settings, formData) {
      formData.append('resize_mode', settings.mode);
      if (settings.mode === 'custom') {
        if (settings.width) formData.append('max_width', settings.width);
        if (settings.height) formData.append('max_height', settings.height);
      }
    },
  },
};

/* ── Initialization ────────────────────────────────────────────────── */

export function initSettings() {
  // Set up each tool
  Object.values(tools).forEach((tool) => {
    // Tool card click + keyboard → open modal
    const card = $(`#${tool.id}-tool-card`);
    if (card) {
      const openToolModal = () => {
        tool.applyToModal(state.settings[tool.id]);
        openModal(tool.modalId);
      };
      card.addEventListener('click', openToolModal);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openToolModal();
        }
      });
    }

    // Modal save button
    const saveBtn = $(`#save-${tool.id}-settings`);
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const values = tool.readFromModal();
        updateSettings(tool.id, values);
        closeModal(tool.modalId);
        updateSummaryDisplay(tool);
      });
    }

    // Modal close (X) and cancel buttons
    const closeBtn = $(`#close-${tool.id}-modal`);
    if (closeBtn) {
      closeBtn.addEventListener('click', () => closeModal(tool.modalId));
    }
    const cancelBtn = $(`#cancel-${tool.id}-settings`);
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => closeModal(tool.modalId));
    }

    // Initialize summary display
    updateSummaryDisplay(tool);
  });

  // Compression mode → toggle output format section
  $$('input[name="compression-type"]').forEach((radio) => {
    radio.addEventListener('change', toggleOutputFormatSection);
  });

  // Resize mode → toggle custom size controls
  $$('input[name="resize-type"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const customControls = $('.custom-size-controls');
      if (customControls) {
        customControls.classList.toggle('is-hidden', radio.value !== 'custom');
      }
    });
  });

  // Aspect ratio maintenance
  initAspectRatio();

  // Size presets
  $$('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const widthInput = $('#custom-width');
      const heightInput = $('#custom-height');
      if (widthInput) widthInput.value = btn.dataset.width;
      if (heightInput) heightInput.value = btn.dataset.height;

      // Select custom radio
      const customRadio = $('#custom-size');
      if (customRadio) customRadio.checked = true;
      const customControls = $('.custom-size-controls');
      if (customControls) customControls.classList.remove('is-hidden');
    });
  });

  // Listen for settings changes to update displays
  bus.on('settings:changed', ({ tool: toolId }) => {
    const t = tools[toolId];
    if (t) updateSummaryDisplay(t);
  });
}

function updateSummaryDisplay(tool) {
  const summaryEl = $(`#${tool.summaryId}`);
  if (summaryEl) {
    summaryEl.textContent = tool.renderSummary(state.settings[tool.id]);
  }
}

function toggleOutputFormatSection() {
  const selectedMode = $('input[name="compression-type"]:checked')?.value;
  const formatSection = $('#output-format-section');
  if (formatSection) {
    formatSection.classList.toggle('is-hidden', selectedMode === 'lossless');
  }
}

function initAspectRatio() {
  const widthInput = $('#custom-width');
  const heightInput = $('#custom-height');
  if (!widthInput || !heightInput) return;

  let aspectRatio = null;
  let updating = false;

  const update = (changed, other) => {
    if (!aspectRatio || updating) return;
    updating = true;
    const val = parseInt(changed.value, 10);
    if (!isNaN(val)) {
      other.value = changed === widthInput
        ? Math.round(val / aspectRatio)
        : Math.round(val * aspectRatio);
    }
    updating = false;
  };

  widthInput.addEventListener('input', () => {
    if (!aspectRatio && heightInput.value) {
      aspectRatio = parseInt(widthInput.value, 10) / parseInt(heightInput.value, 10);
    }
    update(widthInput, heightInput);
  });

  heightInput.addEventListener('input', () => {
    if (!aspectRatio && widthInput.value) {
      aspectRatio = parseInt(widthInput.value, 10) / parseInt(heightInput.value, 10);
    }
    update(heightInput, widthInput);
  });
}

/**
 * Build FormData with current settings for processing.
 * @param {FormData} formData
 */
export function appendSettingsToFormData(formData) {
  const settings = getSettings();
  Object.values(tools).forEach((tool) => {
    tool.toFormData(settings[tool.id], formData);
  });
}
