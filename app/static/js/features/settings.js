/**
 * Settings: right-side sidebar with accordion sections, segmented controls,
 * quality sliders, and immediate apply. Desktop: persistent drawer.
 * Mobile: bottom sheet with backdrop and focus trap.
 */
import { $, $$ } from '../lib/dom.js';
import { bus } from '../lib/events.js';
import * as storage from '../lib/storage.js';
import { getAIUpscaleHealth } from '../lib/ai-upscale-api.js';
import {
  state,
  updateSettings,
  getSettings,
  getEffectiveWatermarkState,
  getProcessingSnapshot,
} from '../state/app-state.js';
import {
  initSegmentedControl,
  setSegmentedValue,
  setSegmentedDisabled,
  toggleHidden,
} from '../lib/form-controls.js';
import {
  initWatermarkEditor,
  syncWatermarkEditor,
  appendWatermarkSettings,
  flushPendingWatermarkEditorUpdates,
} from './watermark-editor.js';

/* ── Constants ────────────────────────────────────────────────────── */

const SIDEBAR_OPEN_KEY = 'compressify_sidebar_open';
const LEGACY_PANEL_EXPANDED_KEY = 'compressify_panel_expanded';
const SIDEBAR_TRANSITION_DISABLED_CLASS = 'is-sidebar-transition-disabled';
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const MOBILE_MQ = window.matchMedia('(max-width: 640px)');
const MAX_RESIZE_DIMENSION = 10000;
let resizeAspectRatio = null;
let settingsValidationState = {
  processable: true,
  resize: { valid: true, message: '', width: null, height: null },
  aiUpscale: { valid: true, message: '' },
};

const WORKFLOW_LABELS = {
  optimize: 'Optimize',
  'ai-upscale': 'AI Upscale',
};

const MODE_LABELS = {
  lossless: 'Lossless',
  web: 'Balanced',
  high: 'Maximum',
};

const FORMAT_LABELS = {
  auto: 'Auto',
  png: 'PNG',
  webp: 'WebP',
  jpeg: 'JPEG',
};

const QUALITY_DEFAULTS = {
  web:  { auto: 80, webp: 75, jpeg: 85 },
  high: { auto: 50, webp: 40, jpeg: 60 },
};

const AI_MODEL_LABELS = {
  photo: 'Photo',
  anime: 'Anime',
};

const AI_QUALITY_DEFAULTS = {
  webp: 90,
  jpeg: 92,
};

const AI_UPSCALE_HEALTH_RETRY_DELAYS_MS = (() => {
  if (!Array.isArray(window.__AI_UPSCALE_HEALTH_RETRY_DELAYS_MS)) {
    return [1500, 3000, 5000];
  }
  const normalized = window.__AI_UPSCALE_HEALTH_RETRY_DELAYS_MS
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return normalized.length > 0 ? normalized : [1500, 3000, 5000];
})();
const AI_UPSCALE_HEALTH_MAX_RETRIES = (() => {
  const override = Number(window.__AI_UPSCALE_HEALTH_MAX_RETRIES);
  return Number.isFinite(override) && override > 0 ? override : 24;
})();
const AI_UPSCALE_HEALTH_ERROR_RETRY_DELAY_MS = (() => {
  const override = Number(window.__AI_UPSCALE_HEALTH_ERROR_RETRY_DELAY_MS);
  return Number.isFinite(override) && override >= 0 ? override : 8000;
})();

let aiUpscaleHealthState = {
  loading: false,
  enabled: false,
  healthy: false,
  state: 'disabled',
  backend: null,
  workerInstanceId: null,
  startedAt: null,
  details: {},
  reason: 'AI upscaling is unavailable.',
};
let aiUpscaleHealthRefreshPromise = null;
let aiUpscaleHealthRetryTimer = null;
let aiUpscaleHealthRetryAttempt = 0;

/* ── Initialization ───────────────────────────────────────────────── */

export function initSettings() {
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;

  initSidebar();
  initWorkflowControl();
  initSectionAccordions();
  initToggleSectionHeaders();
  initCompressionMode();
  initQualitySlider();
  initFormatControl();
  initAIUpscaleControls();
  initResizeMode();
  initPresets();
  initAspectRatio();
  initAspectRatioLock();
  initBackground();
  initWatermarkEditor();

  // Apply persisted state to controls
  syncControlsFromState();
  void refreshAIUpscaleHealth();

  // Listen for external state changes
  bus.on('settings:changed', () => {
    syncWorkflowMode();
    syncCompressionControls();
    syncAIUpscaleControls();
    updateSummary();
  });
  bus.on('watermark:logoChanged', () => updateSummary());
  bus.on('watermark:qrChanged', () => updateSummary());
}

/* ── Sidebar management ──────────────────────────────────────────── */

function initSidebar() {
  const appLayout = $('.app-layout');
  const toggleBtn = $('#sidebar-toggle');
  const closeBtn = $('#sidebar-close');
  const backdrop = $('#sidebar-backdrop');
  const sidebar = $('#settings-sidebar');

  if (!appLayout || !sidebar) return;

  migrateLegacySidebarPreference();
  setSidebarClosedState(true);

  // Restore persisted state — default open on desktop, closed on mobile
  const isMobile = MOBILE_MQ.matches;
  const savedOpen = storage.getItem(SIDEBAR_OPEN_KEY);

  if (!isMobile && savedOpen !== false) {
    runWithoutSidebarTransitions(appLayout, () => {
      openSidebar({ persist: false });
    });
  }

  // Toggle button in header
  toggleBtn?.addEventListener('click', () => toggleSidebar());

  // Close button inside sidebar
  closeBtn?.addEventListener('click', () => closeSidebar());

  // Backdrop click (mobile)
  backdrop?.addEventListener('click', () => closeSidebar());

  // Escape key closes on mobile
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isSidebarOpen() && MOBILE_MQ.matches) {
      closeSidebar();
    }
  });

  // Auto-close on mobile when first files arrive
  let hadFiles = false;
  bus.on('files:countChanged', ({ total }) => {
    const hasFiles = total > 0;
    if (hasFiles && !hadFiles && MOBILE_MQ.matches) {
      closeSidebar({ persist: false, restoreFocus: false });
    }
    hadFiles = hasFiles;
  });

  // Handle viewport resize between desktop/mobile modes
  MOBILE_MQ.addEventListener('change', (e) => {
    if (e.matches) {
      // Switched to mobile — close sidebar without overwriting desktop preference
      if (isSidebarOpen()) closeSidebar({ persist: false, restoreFocus: false });
    } else {
      // Switched to desktop — clean up mobile ARIA and restore saved state
      sidebar?.removeAttribute('role');
      sidebar?.removeAttribute('aria-modal');
      document.body.style.overflow = '';
      sidebar?.removeEventListener('keydown', trapFocus);
      // Restore desktop sidebar from persisted preference
      const savedOpen = storage.getItem(SIDEBAR_OPEN_KEY);
      if (savedOpen !== false) openSidebar({ persist: false });
    }
  });
}

function migrateLegacySidebarPreference() {
  const legacyValue = storage.getItem(LEGACY_PANEL_EXPANDED_KEY);
  if (legacyValue === null) return;

  if (storage.getItem(SIDEBAR_OPEN_KEY) === null) {
    storage.setItem(SIDEBAR_OPEN_KEY, legacyValue);
  }

  storage.removeItem(LEGACY_PANEL_EXPANDED_KEY);
}

function runWithoutSidebarTransitions(appLayout, callback) {
  appLayout.classList.add(SIDEBAR_TRANSITION_DISABLED_CLASS);
  callback();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      appLayout.classList.remove(SIDEBAR_TRANSITION_DISABLED_CLASS);
    });
  });
}

function initSectionAccordions() {
  $$('.sidebar__section[data-section]').forEach((section) => {
    const header = section.querySelector('[data-accordion-trigger]');
    if (!header) return;

    header.addEventListener('click', () => {
      const isOpen = section.classList.toggle('is-open');
      header.setAttribute('aria-expanded', String(isOpen));
    });
  });
}

function initToggleSectionHeaders() {
  $$('.sidebar__section-header[data-toggle-checkbox]').forEach((header) => {
    const checkboxId = header.dataset.toggleCheckbox;
    const checkbox = checkboxId ? document.getElementById(checkboxId) : null;
    if (!checkbox) return;

    header.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.sidebar__toggle') || target.closest('.sidebar__tooltip-trigger')) return;

      checkbox.click();
    });
  });
}

function toggleSidebar() {
  if (isSidebarOpen()) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

function openSidebar({ persist = shouldPersistSidebarState() } = {}) {
  const appLayout = $('.app-layout');
  const toggleBtn = $('#sidebar-toggle');
  const sidebar = $('#settings-sidebar');

  setSidebarClosedState(false);
  appLayout?.classList.add('is-sidebar-open');
  toggleBtn?.setAttribute('aria-expanded', 'true');

  if (MOBILE_MQ.matches) {
    document.body.style.overflow = 'hidden';
    sidebar?.setAttribute('role', 'dialog');
    sidebar?.setAttribute('aria-modal', 'true');
    // Focus first focusable element
    requestAnimationFrame(() => {
      const firstFocusable = sidebar?.querySelector(FOCUSABLE_SELECTOR);
      firstFocusable?.focus();
    });
    sidebar?.addEventListener('keydown', trapFocus);
  } else {
    document.body.style.overflow = '';
    sidebar?.removeAttribute('role');
    sidebar?.removeAttribute('aria-modal');
    sidebar?.removeEventListener('keydown', trapFocus);
  }

  if (persist) storage.setItem(SIDEBAR_OPEN_KEY, true);
}

function closeSidebar({
  persist = shouldPersistSidebarState(),
  restoreFocus = MOBILE_MQ.matches || isFocusInsideSidebar(),
} = {}) {
  const appLayout = $('.app-layout');
  const toggleBtn = $('#sidebar-toggle');
  const sidebar = $('#settings-sidebar');

  appLayout?.classList.remove('is-sidebar-open');
  toggleBtn?.setAttribute('aria-expanded', 'false');
  setSidebarClosedState(true);

  if (MOBILE_MQ.matches) {
    document.body.style.overflow = '';
    sidebar?.removeAttribute('role');
    sidebar?.removeAttribute('aria-modal');
    sidebar?.removeEventListener('keydown', trapFocus);
  }

  if (restoreFocus) toggleBtn?.focus();
  if (persist) storage.setItem(SIDEBAR_OPEN_KEY, false);
}

function isSidebarOpen() {
  return $('.app-layout')?.classList.contains('is-sidebar-open') ?? false;
}

function shouldPersistSidebarState() {
  return !MOBILE_MQ.matches;
}

function setSidebarClosedState(closed) {
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;

  sidebar.toggleAttribute('inert', closed);
  sidebar.setAttribute('aria-hidden', String(closed));
}

function isFocusInsideSidebar() {
  const sidebar = $('#settings-sidebar');
  return !!sidebar && sidebar.contains(document.activeElement);
}

function trapFocus(e) {
  if (e.key !== 'Tab') return;

  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;

  const focusable = [...sidebar.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (el) => !el.disabled && el.offsetParent !== null
  );

  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function getActiveWorkflowMode() {
  return state.settings.workflow?.mode || 'optimize';
}

function initWorkflowControl() {
  const control = $('#workflow-control');
  if (!control) return;

  initSegmentedControl(control, (value) => {
    updateSettings('workflow', { mode: value });
    syncWorkflowMode();
    if (value === 'ai-upscale') {
      void refreshAIUpscaleHealth();
    } else {
      clearAIUpscaleHealthRetry();
    }
  });
}

function initAIUpscaleControls() {
  const modelControl = $('#ai-model-control');
  if (modelControl) {
    initSegmentedControl(modelControl, (value) => {
      updateSettings('aiUpscale', { modelPreset: value });
    });
  }

  const scaleControl = $('#ai-scale-control');
  if (scaleControl) {
    initSegmentedControl(scaleControl, (value) => {
      updateSettings('aiUpscale', { scale: Number.parseInt(value, 10) });
    });
  }

  const formatControl = $('#ai-format-control');
  if (formatControl) {
    initSegmentedControl(formatControl, (value) => {
      const nextQuality = value === 'png'
        ? null
        : getAIUpscaleDefaultQuality(value);
      updateSettings('aiUpscale', {
        outputFormat: value,
        quality: nextQuality,
      });
      syncAIUpscaleControls();
    });
  }

  const slider = $('#ai-quality-slider');
  const output = $('#ai-quality-value');
  if (slider && output) {
    slider.addEventListener('input', () => {
      output.textContent = slider.value;
    });

    slider.addEventListener('change', () => {
      updateSettings('aiUpscale', { quality: Number.parseInt(slider.value, 10) });
    });
  }
}

function syncWorkflowMode() {
  const mode = getActiveWorkflowMode();
  document.documentElement.dataset.workflowMode = mode;
  setSegmentedValue('#workflow-control', mode);

  if (mode !== 'ai-upscale') {
    clearAIUpscaleHealthRetry();
    aiUpscaleHealthRetryAttempt = 0;
  }

  $$('[data-workflow-section]').forEach((section) => {
    section.classList.toggle('is-hidden', section.dataset.workflowSection !== mode);
  });

  syncValidationState();
  updateSummary();
}

function syncAIUpscaleControls() {
  const settings = state.settings.aiUpscale || {};
  const outputFormat = settings.outputFormat || 'png';
  const quality = outputFormat === 'png'
    ? null
    : settings.quality ?? getAIUpscaleDefaultQuality(outputFormat);

  setSegmentedValue('#ai-model-control', settings.modelPreset || 'photo');
  setSegmentedValue('#ai-scale-control', String(settings.scale || 2));
  setSegmentedValue('#ai-format-control', outputFormat);
  toggleHidden('#ai-quality-slider-group', outputFormat === 'png');

  const slider = $('#ai-quality-slider');
  const output = $('#ai-quality-value');
  if (slider) {
    slider.disabled = outputFormat === 'png';
    if (quality != null) slider.value = quality;
  }
  if (output && quality != null) {
    output.textContent = quality;
  }
  syncAIUpscaleStatus();
}

function syncAIUpscaleStatus() {
  const el = $('#ai-upscale-status');
  if (!el) return;

  el.classList.remove('sidebar__ai-status--pending', 'sidebar__ai-status--healthy', 'sidebar__ai-status--error');

  if (aiUpscaleHealthState.loading) {
    el.classList.add('sidebar__ai-status--pending');
    el.textContent = aiUpscaleHealthState.reason || 'Checking…';
  } else if (aiUpscaleHealthState.state === 'starting') {
    el.classList.add('sidebar__ai-status--pending');
    el.textContent = aiUpscaleHealthState.reason || 'Starting…';
  } else if (aiUpscaleHealthState.enabled && aiUpscaleHealthState.healthy) {
    el.classList.add('sidebar__ai-status--healthy');
    el.textContent = aiUpscaleHealthState.reason || 'Ready';
  } else {
    el.classList.add('sidebar__ai-status--error');
    el.textContent = aiUpscaleHealthState.reason || 'Unavailable';
  }
}

async function refreshAIUpscaleHealth() {
  if (aiUpscaleHealthRefreshPromise) {
    return aiUpscaleHealthRefreshPromise;
  }

  clearAIUpscaleHealthRetry();
  const preserveStartingStatus = aiUpscaleHealthState.state === 'starting';
  if (!preserveStartingStatus) {
    aiUpscaleHealthState = {
      ...aiUpscaleHealthState,
      loading: true,
      reason: 'Checking AI upscaling service…',
    };
    syncAIUpscaleStatus();
    syncValidationState();
  }

  aiUpscaleHealthRefreshPromise = (async () => {
    try {
      const result = await getAIUpscaleHealth();
      aiUpscaleHealthState = {
        loading: false,
        enabled: Boolean(result.enabled),
        healthy: Boolean(result.healthy),
        state: result.state || (result.healthy ? 'ready' : 'error'),
        backend: result.backend || null,
        workerInstanceId: result.worker_instance_id || null,
        startedAt: result.started_at || null,
        details: result.details || {},
        reason: result.reason || (result.healthy ? 'AI upscaling service ready' : 'AI upscaling is unavailable.'),
      };
    } catch (error) {
      aiUpscaleHealthState = {
        loading: false,
        enabled: aiUpscaleHealthState.enabled,
        healthy: false,
        state: 'error',
        backend: null,
        workerInstanceId: null,
        startedAt: null,
        details: {},
        reason: error.message || 'AI upscaling service is unavailable.',
      };
    } finally {
      aiUpscaleHealthRefreshPromise = null;
      syncAIUpscaleStatus();
      syncValidationState();
      updateAIUpscaleHealthRetry();
    }
  })();

  return aiUpscaleHealthRefreshPromise;
}

function clearAIUpscaleHealthRetry() {
  if (aiUpscaleHealthRetryTimer) {
    window.clearTimeout(aiUpscaleHealthRetryTimer);
    aiUpscaleHealthRetryTimer = null;
  }
}

function scheduleAIUpscaleHealthRetry() {
  if (aiUpscaleHealthRetryTimer || getActiveWorkflowMode() !== 'ai-upscale') {
    return;
  }

  if (aiUpscaleHealthRetryAttempt >= AI_UPSCALE_HEALTH_MAX_RETRIES) {
    aiUpscaleHealthState = {
      ...aiUpscaleHealthState,
      loading: false,
      healthy: false,
      state: 'error',
      reason: 'AI service is taking too long to start. Try refreshing the page.',
    };
    syncAIUpscaleStatus();
    syncValidationState();
    return;
  }

  const index = Math.min(aiUpscaleHealthRetryAttempt, AI_UPSCALE_HEALTH_RETRY_DELAYS_MS.length - 1);
  const delay = AI_UPSCALE_HEALTH_RETRY_DELAYS_MS[index];
  aiUpscaleHealthRetryTimer = window.setTimeout(() => {
    aiUpscaleHealthRetryTimer = null;
    aiUpscaleHealthRetryAttempt += 1;
    void refreshAIUpscaleHealth();
  }, delay);
}

function updateAIUpscaleHealthRetry() {
  if (
    aiUpscaleHealthState.enabled
    && !aiUpscaleHealthState.healthy
    && getActiveWorkflowMode() === 'ai-upscale'
  ) {
    if (aiUpscaleHealthState.state === 'starting') {
      scheduleAIUpscaleHealthRetry();
      return;
    }
    if (aiUpscaleHealthState.state === 'error' && aiUpscaleHealthRetryAttempt === 0) {
      aiUpscaleHealthRetryAttempt = 1;
      aiUpscaleHealthRetryTimer = window.setTimeout(() => {
        aiUpscaleHealthRetryTimer = null;
        void refreshAIUpscaleHealth();
      }, AI_UPSCALE_HEALTH_ERROR_RETRY_DELAY_MS);
      return;
    }
  }

  aiUpscaleHealthRetryAttempt = 0;
  clearAIUpscaleHealthRetry();
}

function getAIUpscaleDefaultQuality(format) {
  return AI_QUALITY_DEFAULTS[format] ?? null;
}

function syncValidationState() {
  const workflowMode = getActiveWorkflowMode();
  const aiValid = !aiUpscaleHealthState.loading && aiUpscaleHealthState.enabled && aiUpscaleHealthState.healthy;
  settingsValidationState.aiUpscale = {
    valid: aiValid,
    message: aiUpscaleHealthState.loading
      ? 'Checking AI upscaling service…'
      : aiUpscaleHealthState.reason || 'AI upscaling is unavailable.',
  };

  settingsValidationState.processable = workflowMode === 'ai-upscale'
    ? aiValid
    : settingsValidationState.resize.valid;

  bus.emit('settings:validationChanged', settingsValidationState);
}

/* ── Compression mode segmented control ───────────────────────────── */

function initCompressionMode() {
  const control = $('#compression-mode-control');
  if (!control) return;

  initSegmentedControl(control, (value) => {
    const format = state.settings.compress.outputFormat || 'auto';
    const quality = getDefaultQuality(value, format);
    updateSettings('compress', { mode: value, quality });

    // Show/hide quality slider (hidden for lossless OR PNG)
    const hideQuality = value === 'lossless' || format === 'png';
    toggleHidden('#quality-slider-group', hideQuality);

    // Sync quality slider
    if (!hideQuality) {
      syncSliderValue(quality);
    }
  });
}

/* ── Quality slider ───────────────────────────────────────────────── */

function initQualitySlider() {
  const slider = $('#quality-slider');
  const output = $('#quality-value');
  if (!slider || !output) return;

  // Live visual feedback during drag
  slider.addEventListener('input', () => {
    output.textContent = slider.value;
  });

  // Commit on release
  slider.addEventListener('change', () => {
    updateSettings('compress', { quality: Number.parseInt(slider.value, 10) });
  });
}

/* ── Format segmented control ─────────────────────────────────────── */

function initFormatControl() {
  const control = $('#format-control');
  if (!control) return;

  initSegmentedControl(control, (value) => {
    const mode = state.settings.compress.mode;
    const quality = getDefaultQuality(mode, value);
    updateSettings('compress', { outputFormat: value, quality });

    const hideQuality = mode === 'lossless' || value === 'png';
    toggleHidden('#quality-slider-group', hideQuality);
    if (!hideQuality) syncSliderValue(quality);
  });
}

/* ── Resize toggle ───────────────────────────────────────────────── */

function initResizeMode() {
  const toggle = $('#resize-toggle');
  if (!toggle) return;

  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    setResizeSectionVisibility(enabled);

    if (!enabled) {
      clearActivePreset();
      restoreResizeControlsFromState();
      updateSettings('resize', { mode: 'original' });
      syncResizeValidation({ emit: true, persist: false });
    } else {
      restoreResizeControlsFromState();
      updateSettings('resize', { mode: 'custom' });
      syncResizeValidation({ emit: true });
    }
  });
}

/* ── Size presets ─────────────────────────────────────────────────── */

function initPresets() {
  $$('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const w = Number.parseInt(btn.dataset.width, 10);
      const h = Number.parseInt(btn.dataset.height, 10);

      const widthInput = $('#custom-width');
      const heightInput = $('#custom-height');
      if (widthInput) widthInput.value = w;
      if (heightInput) heightInput.value = h;
      resizeAspectRatio = w / h;

      // Mark this preset as active, clear others
      setActivePreset(btn);

      // Ensure toggle is on
      const toggle = $('#resize-toggle');
      if (toggle && !toggle.checked) {
        toggle.checked = true;
        setResizeSectionVisibility(true);
      }

      updateSettings('resize', { mode: 'custom', width: w, height: h, locked: true });
      syncLockButton();
      syncResizeValidation({ emit: true, persist: false });
    });
  });
}

/* ── Preset active-state helpers ─────────────────────────────────── */

function setActivePreset(activeBtn) {
  $$('.preset-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn === activeBtn);
  });
}

function clearActivePreset() {
  $$('.preset-btn').forEach((btn) => {
    btn.classList.remove('is-active');
  });
}

/** Check if current dimensions match any preset; if so, highlight it. */
function syncActivePreset() {
  const w = Number.parseInt($('#custom-width')?.value, 10);
  const h = Number.parseInt($('#custom-height')?.value, 10);

  $$('.preset-btn').forEach((btn) => {
    const pw = Number.parseInt(btn.dataset.width, 10);
    const ph = Number.parseInt(btn.dataset.height, 10);
    btn.classList.toggle('is-active', pw === w && ph === h);
  });
}

/* ── Dimension inputs with aspect ratio ───────────────────────────── */

function initAspectRatio() {
  const widthInput = $('#custom-width');
  const heightInput = $('#custom-height');
  if (!widthInput || !heightInput) return;

  let updating = false;

  const syncOther = (changed, other) => {
    if (!isAspectRatioLocked() || updating) return;
    ensureResizeAspectRatio();
    if (!resizeAspectRatio) return;

    updating = true;
    const val = Number.parseInt(changed.value, 10);
    if (Number.isFinite(val)) {
      other.value = changed === widthInput
        ? Math.round(val / resizeAspectRatio)
        : Math.round(val * resizeAspectRatio);
    }
    updating = false;
  };

  widthInput.addEventListener('input', () => {
    syncOther(widthInput, heightInput);
    syncActivePreset();
    syncResizeValidation({ emit: true });
  });

  heightInput.addEventListener('input', () => {
    syncOther(heightInput, widthInput);
    syncActivePreset();
    syncResizeValidation({ emit: true });
  });
}

/* ── Aspect ratio lock toggle ────────────────────────────────────── */

function initAspectRatioLock() {
  const lockBtn = $('#aspect-ratio-toggle');
  if (!lockBtn) return;

  lockBtn.addEventListener('click', () => {
    if (isAspectRatioLocked()) {
      resizeAspectRatio = null;
      updateSettings('resize', { locked: false });
    } else {
      const w = Number.parseInt($('#custom-width')?.value, 10);
      const h = Number.parseInt($('#custom-height')?.value, 10);
      if (w && h) {
        resizeAspectRatio = w / h;
        updateSettings('resize', { locked: true });
      } else {
        return;
      }
    }
    syncLockButton();
    syncResizeValidation({ emit: true, persist: false });
  });
}

function syncLockButton() {
  const lockBtn = $('#aspect-ratio-toggle');
  if (!lockBtn) return;

  const isLocked = isAspectRatioLocked();
  lockBtn.setAttribute('aria-pressed', String(isLocked));
  lockBtn.setAttribute('title', isLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio');
  lockBtn.setAttribute('aria-label', isLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio');
}

function isAspectRatioLocked() {
  return Boolean(state.settings.resize?.locked);
}

function setResizeSectionVisibility(enabled) {
  const section = $('#custom-size-section');
  if (!section) return;

  section.classList.toggle('is-open', enabled);
  section.setAttribute('aria-hidden', String(!enabled));
}

function restoreResizeControlsFromState() {
  const widthInput = $('#custom-width');
  const heightInput = $('#custom-height');
  const { width, height, locked } = state.settings.resize;

  if (widthInput) widthInput.value = width ?? '';
  if (heightInput) heightInput.value = height ?? '';

  resizeAspectRatio = locked && width && height ? width / height : null;
  syncLockButton();
  syncActivePreset();
}

function parseResizeDraftDimension(rawValue, label) {
  const normalized = String(rawValue ?? '').trim();
  if (!normalized) {
    return { valid: true, value: null, message: '' };
  }

  if (!/^\d+$/.test(normalized)) {
    return {
      valid: false,
      value: null,
      message: `Enter a whole-number ${label.toLowerCase()} between 1 and ${MAX_RESIZE_DIMENSION}.`,
    };
  }

  const value = Number.parseInt(normalized, 10);
  if (!Number.isFinite(value) || value < 1 || value > MAX_RESIZE_DIMENSION) {
    return {
      valid: false,
      value: null,
      message: `${label} must be between 1 and ${MAX_RESIZE_DIMENSION} px.`,
    };
  }

  return { valid: true, value, message: '' };
}

function computeResizeValidation() {
  const toggle = $('#resize-toggle');
  const enabled = toggle ? toggle.checked : state.settings.resize.mode === 'custom';
  if (!enabled) {
    return {
      processable: true,
      resize: { valid: true, message: '', width: null, height: null },
      aiUpscale: { ...settingsValidationState.aiUpscale },
    };
  }

  const widthResult = parseResizeDraftDimension($('#custom-width')?.value, 'Width');
  if (!widthResult.valid) {
    return {
      processable: false,
      resize: { valid: false, message: widthResult.message, width: null, height: null },
      aiUpscale: { ...settingsValidationState.aiUpscale },
    };
  }

  const heightResult = parseResizeDraftDimension($('#custom-height')?.value, 'Height');
  if (!heightResult.valid) {
    return {
      processable: false,
      resize: { valid: false, message: heightResult.message, width: null, height: null },
      aiUpscale: { ...settingsValidationState.aiUpscale },
    };
  }

  if (widthResult.value == null && heightResult.value == null) {
    return {
      processable: false,
      resize: {
        valid: false,
        message: 'Enter a width, a height, or both.',
        width: null,
        height: null,
      },
      aiUpscale: { ...settingsValidationState.aiUpscale },
    };
  }

  return {
    processable: true,
    resize: {
      valid: true,
      message: '',
      width: widthResult.value,
      height: heightResult.value,
    },
    aiUpscale: { ...settingsValidationState.aiUpscale },
  };
}

function setResizeValidationMessage(message) {
  const errorEl = $('#resize-error');
  if (!errorEl) return;

  errorEl.textContent = message || '';
  errorEl.classList.toggle('is-hidden', !message);
}

function applyResizeValidationState(validation) {
  const enabled = $('#resize-toggle')?.checked ?? state.settings.resize.mode === 'custom';
  const invalid = enabled && !validation.resize.valid;
  const inputsRow = $('.dimensions-group__inputs');
  const widthInput = $('#custom-width');
  const heightInput = $('#custom-height');

  inputsRow?.classList.toggle('is-invalid', invalid);
  [widthInput, heightInput].forEach((input) => {
    if (!input) return;
    input.classList.toggle('is-invalid', invalid);
    input.setAttribute('aria-invalid', String(invalid));
  });

  setResizeValidationMessage(invalid ? validation.resize.message : '');
}

function ensureResizeAspectRatio() {
  if (!isAspectRatioLocked() || resizeAspectRatio) return;

  const widthResult = parseResizeDraftDimension($('#custom-width')?.value, 'Width');
  const heightResult = parseResizeDraftDimension($('#custom-height')?.value, 'Height');
  if (widthResult.valid && heightResult.valid && widthResult.value && heightResult.value) {
    resizeAspectRatio = widthResult.value / heightResult.value;
  }
}

function persistValidResize(validation) {
  const toggle = $('#resize-toggle');
  if (!toggle?.checked || !validation.resize.valid) return;

  const nextResize = {
    mode: 'custom',
    width: validation.resize.width,
    height: validation.resize.height,
  };

  if (
    state.settings.resize.mode !== nextResize.mode ||
    state.settings.resize.width !== nextResize.width ||
    state.settings.resize.height !== nextResize.height
  ) {
    updateSettings('resize', nextResize);
  }
}

function syncResizeValidation({ emit = true, persist = true } = {}) {
  const validation = computeResizeValidation();
  settingsValidationState = {
    ...settingsValidationState,
    resize: validation.resize,
  };

  if (persist) {
    persistValidResize({ resize: validation.resize });
  }

  if (
    validation.resize.valid &&
    isAspectRatioLocked() &&
    !resizeAspectRatio &&
    validation.resize.width &&
    validation.resize.height
  ) {
    resizeAspectRatio = validation.resize.width / validation.resize.height;
  }

  applyResizeValidationState(validation);
  updateSummary();
  syncValidationState();

  if (emit) {
    bus.emit('settings:validationChanged', settingsValidationState);
  }

  return settingsValidationState;
}

/* ── Background removal ──────────────────────────────────────────── */

function initBackground() {
  const toggle = $('#background-toggle');
  if (!toggle) return;

  toggle.addEventListener('change', () => {
    updateSettings('background', { enabled: toggle.checked });
    syncCompressionControls();
  });
}

function getEffectiveCompressSettings(settings = state.settings) {
  if (!settings.background?.enabled) {
    return settings.compress;
  }

  return {
    ...settings.compress,
    mode: 'lossless',
    outputFormat: 'png',
    quality: null,
  };
}

function syncCompressionControls() {
  const compress = getEffectiveCompressSettings();
  const backgroundEnabled = state.settings.background?.enabled;

  setSegmentedValue('#compression-mode-control', compress.mode);
  setSegmentedValue('#format-control', compress.outputFormat || 'auto');
  setSegmentedDisabled('#compression-mode-control', backgroundEnabled);
  setSegmentedDisabled('#format-control', backgroundEnabled);

  const qualitySlider = $('#quality-slider');
  if (qualitySlider) {
    qualitySlider.disabled = backgroundEnabled;
  }

  const hideQuality = backgroundEnabled || compress.mode === 'lossless' || compress.outputFormat === 'png';
  toggleHidden('#quality-slider-group', hideQuality);
  if (!hideQuality) {
    const quality = compress.quality ?? getDefaultQuality(compress.mode, compress.outputFormat || 'auto');
    syncSliderValue(quality);
  }
}

/* ── Sync controls from persisted state ───────────────────────────── */

function syncControlsFromState() {
  const { workflow, aiUpscale, resize, background } = state.settings;

  setSegmentedValue('#workflow-control', workflow?.mode || 'optimize');
  syncCompressionControls();
  syncAIUpscaleControls();

  // Resize
  const isCustom = resize.mode === 'custom';
  const resizeToggle = $('#resize-toggle');
  if (resizeToggle) resizeToggle.checked = isCustom;
  const customSection = $('#custom-size-section');
  if (customSection) {
    // Suppress animation on initial load
    customSection.style.transition = 'none';
    setResizeSectionVisibility(isCustom);
    requestAnimationFrame(() => {
      customSection.style.transition = '';
    });
  }
  restoreResizeControlsFromState();
  syncResizeValidation({ emit: true, persist: false });

  // Background removal
  const bgToggle = $('#background-toggle');
  if (bgToggle) bgToggle.checked = background.enabled;

  // Watermark
  syncWatermarkEditor();

  syncWorkflowMode();
  updateSummary();
}

/* ── Summary text ─────────────────────────────────────────────────── */

function updateSummary() {
  const el = $('#settings-summary');
  if (!el) return;

  const workflowMode = getActiveWorkflowMode();
  if (workflowMode === 'ai-upscale') {
    const aiUpscale = state.settings.aiUpscale || {};
    const parts = [
      WORKFLOW_LABELS[workflowMode] || 'AI Upscale',
      AI_MODEL_LABELS[aiUpscale.modelPreset || 'photo'] || 'Photo',
      `${aiUpscale.scale || 2}x`,
      FORMAT_LABELS[aiUpscale.outputFormat || 'png'] || 'PNG',
    ];

    if ((aiUpscale.outputFormat || 'png') !== 'png' && aiUpscale.quality != null) {
      parts.push(`Q${aiUpscale.quality}`);
    }

    if (!settingsValidationState.aiUpscale.valid) {
      parts.push('Unavailable');
    }

    el.textContent = parts.join(' \u00b7 ');
    return;
  }

  const { resize, background } = state.settings;
  const resizeEnabled = $('#resize-toggle')?.checked ?? resize.mode === 'custom';
  const resizeValidation = settingsValidationState;
  const compress = getEffectiveCompressSettings();
  const parts = [];

  // Compression
  parts.push(MODE_LABELS[compress.mode] || compress.mode);

  // Format (non-auto for any mode)
  if (compress.outputFormat && compress.outputFormat !== 'auto') {
    parts.push(FORMAT_LABELS[compress.outputFormat] || compress.outputFormat);
  }

  // Quality (non-lossless, non-PNG)
  if (compress.mode !== 'lossless' && compress.outputFormat !== 'png' && compress.quality != null) {
    parts.push(`Q${compress.quality}`);
  }

  // Resize
  if (!resizeEnabled) {
    parts.push('Original size');
  } else if (!resizeValidation.resize.valid) {
    parts.push('Resize needs input');
  } else if (resizeValidation.resize.width != null && resizeValidation.resize.height != null) {
    parts.push(`Fit ${resizeValidation.resize.width}\u00d7${resizeValidation.resize.height}`);
  } else if (resizeValidation.resize.width != null) {
    parts.push(`Fit width ${resizeValidation.resize.width}px`);
  } else if (resizeValidation.resize.height != null) {
    parts.push(`Fit height ${resizeValidation.resize.height}px`);
  }

  if (background.enabled) {
    parts.push('BG removed');
  }

  // Watermark
  if (getEffectiveWatermarkState().enabled) {
    parts.push('Watermark');
  }

  el.textContent = parts.join(' \u00b7 ');
}

/* ── Utility helpers ──────────────────────────────────────────────── */

function getDefaultQuality(mode, format) {
  if (format === 'png') return null; // PNG is lossless, no quality
  const modeDefaults = QUALITY_DEFAULTS[mode];
  if (!modeDefaults) return null; // lossless
  return modeDefaults[format] ?? modeDefaults.auto ?? null;
}

function syncSliderValue(quality) {
  const slider = $('#quality-slider');
  const output = $('#quality-value');
  if (slider && quality != null) slider.value = quality;
  if (output && quality != null) output.textContent = quality;
}

function appendCompressionSettings(settings, formData) {
  formData.append('compression_mode', settings.mode);
  formData.append('output_format', settings.outputFormat || 'auto');
  if (settings.mode !== 'lossless' && settings.outputFormat !== 'png' && settings.quality != null) {
    formData.append('quality', settings.quality);
  }
}

function appendBackgroundSettings(settings, formData) {
  if (settings.enabled) {
    formData.append('remove_background', '1');
  }
}

function appendResizeSettings(settings, formData) {
  formData.append('resize_mode', settings.mode);
  if (settings.mode === 'custom') {
    if (settings.width != null) formData.append('max_width', settings.width);
    if (settings.height != null) formData.append('max_height', settings.height);
  }
}

/**
 * Build FormData with current settings for processing.
 * @param {FormData} formData
 */
export async function appendSettingsToFormData(formData) {
  const validation = getCurrentSettingsValidation();
  if (!validation.processable) {
    throw new Error(getCurrentValidationMessage());
  }

  if (getActiveWorkflowMode() === 'ai-upscale') {
    appendAIUpscaleSettingsToFormData(formData);
    return;
  }

  const settings = getSettings();
  appendCompressionSettings(getEffectiveCompressSettings(settings), formData);
  appendBackgroundSettings(settings.background, formData);
  appendResizeSettings(settings.resize, formData);
  await appendWatermarkSettings(formData);
}

export function appendAIUpscaleSettingsToFormData(formData) {
  const settings = state.settings.aiUpscale || {};
  const outputFormat = settings.outputFormat || 'png';
  const quality = outputFormat === 'png'
    ? null
    : settings.quality ?? getAIUpscaleDefaultQuality(outputFormat);

  formData.append('model_preset', settings.modelPreset || 'photo');
  formData.append('scale', String(settings.scale || 2));
  formData.append('output_format', outputFormat);
  if (quality != null) {
    formData.append('quality', String(quality));
  }
}

export function getCurrentSettingsValidation() {
  return settingsValidationState;
}

export function isCurrentSettingsProcessable() {
  return settingsValidationState.processable;
}

export function getCurrentValidationMessage() {
  if (getActiveWorkflowMode() === 'ai-upscale') {
    return settingsValidationState.aiUpscale.message || 'AI upscaling is unavailable.';
  }
  return settingsValidationState.resize.message || 'Fix resize settings before processing.';
}

export function getCurrentProcessingSnapshot() {
  flushPendingWatermarkEditorUpdates();
  return getProcessingSnapshot();
}

export function isAIUpscaleMode() {
  return getActiveWorkflowMode() === 'ai-upscale';
}
