// Wrap the entire code in an IIFE or module to prevent polluting the global namespace
(() => {
  // LoadingManager class to manage the global loader and progress bar
  class LoadingManager {
    constructor() {
      this.loader = document.getElementById('global-loader');
      this.progressBar = null;
      this.activeRequests = 0;

      if (this.loader) {
        const progressElement = this.loader.querySelector('.mdc-linear-progress');
        if (progressElement) {
          this.progressBar = new mdc.linearProgress.MDCLinearProgress(progressElement);
        }
      }
    }

    show() {
      this.activeRequests += 1;
      if (this.loader && this.progressBar) {
        this.loader.classList.remove('hidden');
        this.progressBar.open();
        this.progressBar.determinate = false;
      }
    }

    hide() {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (this.activeRequests === 0 && this.loader && this.progressBar) {
        this.progressBar.close();
        setTimeout(() => {
          this.loader.classList.add('hidden');
        }, 300);
      }
    }
  }

  // Initialize LoadingManager instance
  const loadingManager = new LoadingManager();

  document.addEventListener('DOMContentLoaded', () => {
    // Initialize Material Design Components for the top app bar
    const topAppBarElement = document.querySelector('.mdc-top-app-bar');
    if (topAppBarElement) {
      new mdc.topAppBar.MDCTopAppBar(topAppBarElement);
    }

    // Initialize theme toggle
    initializeTheme();

    // Add scroll listener for batch controls shadow
    const batchControls = document.querySelector('.batch-controls');
    if (batchControls) {
      window.addEventListener('scroll', () => {
        batchControls.classList.toggle('scrolled', window.scrollY > 64);
      });
    }

    // Only proceed if on the main page
    if (document.querySelector('.app-layout')) {
      const settingsManager = new SettingsManager();
      const batchProcessor = new BatchProcessor(settingsManager);
      new ImageCompressor(settingsManager, batchProcessor);
    }

    // Initialize login form if present
    if (document.getElementById('login-form')) {
      initializeLoginForm();
    }
  });

  // SettingsManager class to handle user settings
  class SettingsManager {
    constructor() {
      this.settings = {
        compression: { mode: 'lossless' },
        resize: { mode: 'original', width: null, height: null, maintainAspectRatio: true },
        watermark: {
          text: '',
          position: 'bottom-right',
          font_size: '',
          color: '#00000080',
          opacity: 128
        }
      };
      this.compressionDisplay = null;
      this.resizeModeDisplay = null;
      this.watermarkTextDisplay = null;
      this.watermarkPositionDisplay = null;
      this.resizeDimensionsDisplay = null;
      this.customSizeDisplay = null;

      if (document.querySelector('.app-layout')) {
        this.initializeModals();
        this.initializeDisplays();
        this.loadSettings();
      }
    }

    initializeModals() {
      // Compression Modal Elements
      const compressionModal = document.getElementById('compression-modal');
      const openCompressionBtn = document.getElementById('open-compression-settings');
      const closeCompressionBtn = document.getElementById('close-compression-modal');
      const saveCompressionBtn = document.getElementById('save-compression-settings');

      // Event Listeners for Compression Modal
      if (openCompressionBtn && compressionModal) {
        openCompressionBtn.addEventListener('click', () => this.openModal(compressionModal));
        closeCompressionBtn?.addEventListener('click', () => this.closeModal(compressionModal));
        saveCompressionBtn?.addEventListener('click', () => this.saveCompressionSettings());
      }

      // Resize Modal Elements
      const resizeModal = document.getElementById('resize-modal');
      const openResizeBtn = document.getElementById('open-resize-settings');
      const closeResizeBtn = document.getElementById('close-resize-modal');
      const saveResizeBtn = document.getElementById('save-resize-settings');
      const customSizeRadio = document.getElementById('custom-size');
      const originalSizeRadio = document.getElementById('original-size');
      const customSizeControls = document.querySelector('.custom-size-controls');

      // Event Listeners for Resize Modal
      if (openResizeBtn && resizeModal) {
        openResizeBtn.addEventListener('click', () => this.openModal(resizeModal));
        closeResizeBtn?.addEventListener('click', () => this.closeModal(resizeModal));
        saveResizeBtn?.addEventListener('click', () => this.saveResizeSettings());

        // Handle custom size controls visibility
        if (customSizeRadio && originalSizeRadio && customSizeControls) {
          [customSizeRadio, originalSizeRadio].forEach((radio) => {
              radio.addEventListener('change', () => {
              customSizeControls.classList.toggle('hidden', !customSizeRadio.checked);
              });
          });
        }
      }

      // Watermark Modal Elements
      const watermarkModal = document.getElementById('watermark-modal');
      const openWatermarkBtn = document.getElementById('open-watermark-settings');
      const closeWatermarkBtn = document.getElementById('close-watermark-modal');
      const saveWatermarkBtn = document.getElementById('save-watermark-settings');
      const watermarkOpacitySlider = document.getElementById('watermark_opacity');
      const watermarkOpacityValue = document.getElementById('watermark-opacity-value');
      this.watermarkMDCSelect = null; // To store MDCSelect instance for watermark position

      if (openWatermarkBtn && watermarkModal) {
          openWatermarkBtn.addEventListener('click', () => this.openModal(watermarkModal));
          closeWatermarkBtn?.addEventListener('click', () => this.closeModal(watermarkModal));
          saveWatermarkBtn?.addEventListener('click', () => this.saveWatermarkSettings());
          if (watermarkOpacitySlider && watermarkOpacityValue) {
              watermarkOpacitySlider.addEventListener('input', (e) => {
                  watermarkOpacityValue.textContent = e.target.value;
              });
          }
          // Initialize MDC Select for watermark position
          const watermarkSelectElement = watermarkModal.querySelector('.mdc-select');
          if (watermarkSelectElement) {
              this.watermarkMDCSelect = mdc.select.MDCSelect.attachTo(watermarkSelectElement);
              const hiddenInput = watermarkSelectElement.querySelector('input[type="hidden"]');
              if (this.watermarkMDCSelect && hiddenInput) {
                 this.watermarkMDCSelect.listen('MDCSelect:change', () => {
                      hiddenInput.value = this.watermarkMDCSelect.value;
                 });
              }
          }
      }

      // Close modals when clicking outside
      document.querySelectorAll('.modal-overlay').forEach((modal) => {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            this.closeModal(modal);
          }
        });
      });

      // Initialize aspect ratio maintenance
      this.initializeAspectRatio();
    }

    initializeAspectRatio() {
      const maintainAspectRatioCheckbox = document.getElementById('maintain-aspect-ratio');
      const widthInput = document.getElementById('custom-width');
      const heightInput = document.getElementById('custom-height');

      let aspectRatio = null;
      let isUpdating = false;

      const updateDimension = (changedInput, otherInput) => {
        if (!maintainAspectRatioCheckbox.checked || !aspectRatio || isUpdating) return;

        isUpdating = true;
        const newValue = parseInt(changedInput.value, 10);
        if (!isNaN(newValue)) {
          if (changedInput === widthInput) {
            otherInput.value = Math.round(newValue / aspectRatio);
          } else {
            otherInput.value = Math.round(newValue * aspectRatio);
          }
        }
        isUpdating = false;
      };

      if (widthInput && heightInput && maintainAspectRatioCheckbox) {
        widthInput.addEventListener('input', () => updateDimension(widthInput, heightInput));
        heightInput.addEventListener('input', () => updateDimension(heightInput, widthInput));
      }

      // Handle preset buttons
      document.querySelectorAll('.preset-buttons .mdc-button').forEach((button) => {
        button.addEventListener('click', () => {
          const width = parseInt(button.dataset.width, 10);
          const height = parseInt(button.dataset.height, 10);

          if (widthInput && heightInput) {
            widthInput.value = width;
            heightInput.value = height;
            aspectRatio = width / height;
          }

          const customSizeRadio = document.getElementById('custom-size');
          const customSizeControls = document.querySelector('.custom-size-controls');
          if (customSizeRadio) customSizeRadio.checked = true;
          if (customSizeControls) customSizeControls.classList.remove('hidden');
        });
      });
    }

    initializeDisplays() {
      // Initialize display elements for settings summaries
      this.compressionDisplay = document.getElementById('compression-mode-display');
      this.resizeModeDisplay = document.getElementById('resize-mode-display');
      this.resizeDimensionsDisplay = document.getElementById('resize-dimensions-display');
      this.customSizeDisplay = document.querySelector('.custom-size-display');
      this.watermarkTextDisplay = document.getElementById('watermark-text-display');
      this.watermarkPositionDisplay = document.getElementById('watermark-position-display');
    }

    loadSettings() {
      const savedSettings = localStorage.getItem('imageProcessorSettings');
      if (savedSettings) {
        this.settings = JSON.parse(savedSettings);
      }
      // Always update displays and controls, even with default settings
      this.updateDisplays();
      this.applySettingsToControls();
    }

    saveSettings() {
      localStorage.setItem('imageProcessorSettings', JSON.stringify(this.settings));
      this.updateDisplays();
    }

    updateDisplays() {
      // Update compression display
      if (this.compressionDisplay) {
          this.compressionDisplay.textContent = this.getCompressionModeDisplay(this.settings.compression.mode);
      }

      // Update resize display
      if (this.resizeModeDisplay && this.customSizeDisplay && this.resizeDimensionsDisplay) {
          if (this.settings.resize.mode === 'original') {
              this.resizeModeDisplay.textContent = 'Original Size';
              this.customSizeDisplay.classList.add('hidden');
          } else {
              this.resizeModeDisplay.textContent = 'Custom Size';
              this.resizeDimensionsDisplay.textContent = `${this.settings.resize.width || '?'} × ${this.settings.resize.height || '?'}px`;
              this.customSizeDisplay.classList.remove('hidden');
          }
      }

      // Update watermark display
      if (this.watermarkTextDisplay && this.watermarkPositionDisplay) {
          this.watermarkTextDisplay.textContent = this.settings.watermark.text || 'None';
          this.watermarkPositionDisplay.textContent = this.getWatermarkPositionDisplay(this.settings.watermark.position);
      }
    }

    getCompressionModeDisplay(mode) {
      const modes = {
        lossless: 'Lossless',
        web: 'Web Optimized',
        high: 'Maximum Compression',
      };
      return modes[mode] || 'Unknown';
    }

    getWatermarkPositionDisplay(position) {
      const positions = {
          'bottom-right': 'Bottom Right',
          'bottom-left': 'Bottom Left',
          'top-right': 'Top Right',
          'top-left': 'Top Left',
          'center': 'Center',
      };
      return positions[position] || 'Bottom Right';
    }

    applySettingsToControls() {
      // Apply compression settings
      const compressionRadio = document.querySelector(`input[name="compression-type"][value="${this.settings.compression.mode}"]`);
      if (compressionRadio) compressionRadio.checked = true;

      // Apply resize settings
      const resizeRadio = document.querySelector(`input[name="resize-type"][value="${this.settings.resize.mode}"]`);
      if (resizeRadio) resizeRadio.checked = true;

      const customSizeControls = document.querySelector('.custom-size-controls');
      if (this.settings.resize.mode === 'custom') {
        const customWidthInput = document.getElementById('custom-width');
        const customHeightInput = document.getElementById('custom-height');
        const maintainAspectRatioCheckbox = document.getElementById('maintain-aspect-ratio');

        if (customWidthInput && customHeightInput && maintainAspectRatioCheckbox) {
          customWidthInput.value = this.settings.resize.width || '';
          customHeightInput.value = this.settings.resize.height || '';
          maintainAspectRatioCheckbox.checked = this.settings.resize.maintainAspectRatio;
          if (customSizeControls) customSizeControls.classList.remove('hidden');
        }
      } else {
          if (customSizeControls) customSizeControls.classList.add('hidden');
      }


      // Apply watermark settings
      const watermarkTextInput = document.getElementById('watermark_text');
      if (watermarkTextInput) watermarkTextInput.value = this.settings.watermark.text;

      // Set MDCSelect value for watermark position
      if (this.watermarkMDCSelect) {
          this.watermarkMDCSelect.value = this.settings.watermark.position;
      } else { // Fallback if MDCSelect not initialized yet, set hidden input directly
          const watermarkPositionInput = document.getElementById('watermark_position');
          if (watermarkPositionInput) watermarkPositionInput.value = this.settings.watermark.position;
      }

      const watermarkFontSizeInput = document.getElementById('watermark_font_size');
      if (watermarkFontSizeInput) watermarkFontSizeInput.value = this.settings.watermark.font_size;

      const watermarkColorInput = document.getElementById('watermark_color');
      if (watermarkColorInput) watermarkColorInput.value = this.settings.watermark.color;

      const opacitySlider = document.getElementById('watermark_opacity');
      const opacityValueDisplay = document.getElementById('watermark-opacity-value');
      if (opacitySlider) opacitySlider.value = this.settings.watermark.opacity;
      if (opacityValueDisplay) opacityValueDisplay.textContent = this.settings.watermark.opacity;
    }

    saveCompressionSettings() {
      const selectedMode = document.querySelector('input[name="compression-type"]:checked')?.value;
      if (selectedMode) {
        this.settings.compression.mode = selectedMode;
        this.saveSettings();
        this.closeModal(document.getElementById('compression-modal'));
      }
    }

    saveResizeSettings() {
      const selectedMode = document.querySelector('input[name="resize-type"]:checked')?.value;
      const maintainAspectRatioCheckbox = document.getElementById('maintain-aspect-ratio');

      if (selectedMode && maintainAspectRatioCheckbox) {
        this.settings.resize = {
          mode: selectedMode,
          width: null,
          height: null,
          maintainAspectRatio: maintainAspectRatioCheckbox.checked,
        };

        if (selectedMode === 'custom') {
          this.settings.resize.width = parseInt(document.getElementById('custom-width').value, 10) || null;
          this.settings.resize.height = parseInt(document.getElementById('custom-height').value, 10) || null;
        }

        this.saveSettings();
        this.closeModal(document.getElementById('resize-modal'));
      }
    }

    saveWatermarkSettings() {
      const watermarkText = document.getElementById('watermark_text')?.value.trim() || '';
      const watermarkPosition = document.getElementById('watermark_position')?.value || 'bottom-right'; // Hidden input holds MDCSelect value
      const watermarkFontSize = document.getElementById('watermark_font_size')?.value.trim() || '';
      const watermarkColor = document.getElementById('watermark_color')?.value.trim() || '#00000080';
      const watermarkOpacity = parseInt(document.getElementById('watermark_opacity')?.value, 10) || 128;

      this.settings.watermark = {
          text: watermarkText,
          position: watermarkPosition,
          font_size: watermarkFontSize,
          color: watermarkColor,
          opacity: watermarkOpacity,
      };
      this.saveSettings();
      this.closeModal(document.getElementById('watermark-modal'));
    }

    openModal(modal) {
      if (modal) {
          modal.classList.remove('hidden');
          document.body.style.overflow = 'hidden';
      }
    }

    closeModal(modal) {
      if (modal) {
          modal.classList.add('hidden');
          document.body.style.overflow = '';
          this.applySettingsToControls(); // Reset controls to current settings
      }
    }

    getSettings() {
      return this.settings;
    }
  }

  // BatchProcessor class to handle batch processing of images
  class BatchProcessor {
    constructor(settingsManager) {
      this.queue = [];
      this.processing = false;
      this.cancelled = false;
      this.processed = 0;
      this.total = 0;
      this.startTime = null;
      this.chunkSize = 5; // Process 5 images concurrently
      this.settingsManager = settingsManager;

      const progressBarElement = document.getElementById('batch-progress-bar');
      if (progressBarElement) {
        this.progressBar = new mdc.linearProgress.MDCLinearProgress(progressBarElement);
      }

      this.setupCancelButton();
      this.updateCounters();
    }

    setupCancelButton() {
      const cancelButton = document.getElementById('cancel-batch');
      cancelButton?.addEventListener('click', () => this.cancel());
    }

    addToQueue(items) {
      this.queue.push(...items);
      this.updateCounters();
    }

    updateCounters() {
      const totalFilesElement = document.getElementById('total-files-count');
      const selectedFilesElement = document.getElementById('selected-files-count');
      const processedCountElement = document.getElementById('processed-count');
      const totalCountElement = document.getElementById('total-count');

      if (totalFilesElement) totalFilesElement.textContent = document.querySelectorAll('.preview-tile').length;
      if (selectedFilesElement) selectedFilesElement.textContent = document.querySelectorAll('.image-select:checked').length;
      if (processedCountElement) processedCountElement.textContent = this.processed;
      if (totalCountElement) totalCountElement.textContent = this.total;
    }

    showProgress() {
      const progressElement = document.querySelector('.batch-progress');
      if (progressElement && this.progressBar) {
          progressElement.classList.remove('hidden');
          this.progressBar.open();
          this.startTime = Date.now();
      }
    }

    hideProgress() {
      const progressElement = document.querySelector('.batch-progress');
      if (progressElement && this.progressBar) {
          this.progressBar.close();
          setTimeout(() => {
          progressElement.classList.add('hidden');
          }, 300);
      }
    }

    updateProgress() {
      if (this.total === 0 || !this.progressBar) return;

      const progress = this.processed / this.total;
      this.progressBar.progress = progress;

      const timeRemainingElement = document.getElementById('time-remaining');
      if (this.startTime && timeRemainingElement) {
        const elapsed = (Date.now() - this.startTime) / 1000; // seconds
        if (this.processed > 0) {
          const averageTimePerItem = elapsed / this.processed;
          const remainingItems = this.total - this.processed;
          const remainingSeconds = remainingItems * averageTimePerItem;

          if (remainingSeconds > 60) {
            timeRemainingElement.textContent = `About ${Math.ceil(remainingSeconds / 60)} minutes remaining`;
          } else if (remainingSeconds > 0) {
            timeRemainingElement.textContent = `About ${Math.ceil(remainingSeconds)} seconds remaining`;
          } else {
            timeRemainingElement.textContent = 'Finishing up...';
          }
        } else {
          timeRemainingElement.textContent = 'Calculating time...';
        }
      }
    }

    async processQueue(processor) {
      if (this.processing || this.queue.length === 0) return;

      this.processing = true;
      this.cancelled = false;
      this.processed = 0;
      this.total = this.queue.length;

      this.showProgress();
      this.updateCounters(); // Update total count for progress display

      while (this.queue.length > 0 && !this.cancelled) {
        const chunk = this.queue.splice(0, this.chunkSize);
        await Promise.all(
          chunk.map(async (item) => {
            if (this.cancelled) return; // Check cancellation before processing item
            try {
              await processor(item);
              this.processed += 1;
              this.updateProgress();
              this.updateCounters(); // Update processed count
            } catch (error) {
              console.error('Processing error for item:', item, error);
              // Optionally, mark item as failed and continue
              this.processed += 1; // Count as processed to not stall progress
              this.updateProgress();
              this.updateCounters();
            }
          })
        );
      }

      this.processing = false;
      this.hideProgress();
      this.updateCounters(); // Final update
      if (this.cancelled) {
          console.log("Batch processing cancelled.");
      } else {
          console.log("Batch processing complete.");
      }
    }

    cancel() {
      this.cancelled = true;
      this.queue = []; // Clear the queue
      this.hideProgress();
      console.log("Batch processing cancellation requested.");
    }
  }

  // ImageCompressor class to handle image compression and resizing
  class ImageCompressor {
    constructor(settingsManager, batchProcessor) {
        this.selectedFiles = new Set(); // Stores file IDs of selected files
        this.fileMap = new Map(); // Maps file IDs to File objects
        this.template = document.getElementById('image-tile-template');
        this.previewArea = document.getElementById('preview-area');
        this.settingsManager = settingsManager;
        this.batchProcessor = batchProcessor;

        if (this.template && this.previewArea) {
          this.initializeDropZone();
          this.initializeBatchControls();
          this.updateSelectionCount(); // Initial call
        } else {
          console.error("ImageCompressor: Required DOM elements (template or previewArea) not found.");
        }
    }

    initializeDropZone() {
      const dropZone = document.querySelector('.upload-area');
      const fileInput = document.getElementById('file-input');

      if (!dropZone || !fileInput) {
          console.error("Drop zone or file input not found.");
          return;
      }

      ['dragover', 'dragleave', 'drop'].forEach((eventName) => {
        dropZone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
      });

      dropZone.addEventListener('dragover', () => dropZone.classList.add('dragover'));
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
      dropZone.addEventListener('drop', (e) => {
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files) {
          this.handleFiles(e.dataTransfer.files);
        }
      });

      dropZone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        if (e.target.files) {
          this.handleFiles(e.target.files);
          e.target.value = null; // Reset file input
        }
      });
    }

    initializeBatchControls() {
      const selectAllCheckbox = document.getElementById('select-all');
      const processSelectedButton = document.getElementById('process-selected');
      const downloadSelectedButton = document.getElementById('download-selected');

      if (selectAllCheckbox) {
          selectAllCheckbox.addEventListener('change', (e) => {
              const isChecked = e.target.checked;
              document.querySelectorAll('.image-select').forEach((checkbox) => {
                  checkbox.checked = isChecked;
                  this.updateFileSelection(checkbox); // Pass the checkbox element
              });
              // this.updateBatchButtons(); // updateSelectionCount calls this
              // this.updateSelectionCount();
          });
      }

      if (processSelectedButton) {
          processSelectedButton.addEventListener('click', () => this.processSelectedFiles());
      }

      if (downloadSelectedButton) {
          downloadSelectedButton.addEventListener('click', () => this.downloadSelectedFiles());
      }
    }

    handleFiles(files) {
      if (files.length > 0 && this.previewArea) {
        this.previewArea.classList.remove('hidden');
      }

      Array.from(files).forEach((file) => {
        if (file.type.startsWith('image/')) {
          this.createImageTile(file);
        }
      });

      this.batchProcessor.updateCounters();
      this.updateSelectionCount(); // Update counts after adding new files
    }

    createImageTile(file) {
      if (!this.template) return;

      const tileContent = this.template.content.cloneNode(true);
      const container = tileContent.querySelector('.preview-tile');
      if (!container) return;

      const fileId = `file-${Date.now()}-${Math.random().toString(36).substring(2, 9)}-${file.name}`;
      this.fileMap.set(fileId, file);
      container.dataset.fileId = fileId;
      container.dataset.originalFile = file.name; // For display/reference

      const img = new Image();
      img.onload = () => {
        const previewImg = container.querySelector('.preview-image');
        if (previewImg) previewImg.src = img.src;

        const dimensionsEl = container.querySelector('.dimensions');
        if (dimensionsEl) dimensionsEl.textContent = `${img.naturalWidth} × ${img.naturalHeight}px`;

        const aspectRatioEl = container.querySelector('.aspect-ratio');
        if (aspectRatioEl) {
          const aspectRatio = (img.naturalWidth / img.naturalHeight).toFixed(2);
          aspectRatioEl.textContent = aspectRatio;
        }
        URL.revokeObjectURL(img.src); // Clean up object URL
      };
      img.onerror = () => {
          console.error("Error loading image preview for", file.name);
          URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(file);

      const filenameEl = container.querySelector('.filename');
      if (filenameEl) filenameEl.textContent = file.name;

      const fileSizeEl = container.querySelector('.file-size');
      if (fileSizeEl) fileSizeEl.textContent = this.formatFileSize(file.size);

      const previewGrid = document.querySelector('.preview-grid');
      if (previewGrid) {
          previewGrid.appendChild(tileContent);
          // Get the appended container again to ensure event listeners are attached to the live DOM element
          const appendedContainer = previewGrid.querySelector(`[data-file-id="${fileId}"]`);
          if (appendedContainer) {
              this.setupTileControls(appendedContainer);
              this.initializeMDCComponents(appendedContainer);
          }
      }
    }

    setupTileControls(tile) {
      const processButton = tile.querySelector('.process-button');
      const checkbox = tile.querySelector('.image-select');
      const downloadButton = tile.querySelector('.download-button');
      const removeButton = tile.querySelector('.remove-button'); // Assuming a remove button exists

      if (processButton) {
          processButton.addEventListener('click', () => {
              const file = this.getFileForTile(tile);
              if (file) this.processImage(tile, file);
          });
      }
      if (checkbox) {
          checkbox.addEventListener('change', () => {
              this.updateFileSelection(checkbox); // Pass the checkbox element
              // this.updateBatchButtons(); // updateSelectionCount calls this
              // this.updateSelectionCount();
          });
      }
      if (downloadButton) {
          downloadButton.addEventListener('click', () => this.downloadProcessedFile(tile));
      }
      if (removeButton) {
          removeButton.addEventListener('click', () => this.removeTile(tile));
      }
    }

    async processImage(container, file) {
      const progressBar = container.querySelector('.compression-progress'); // Generic progress bar for the tile
      const processButton = container.querySelector('.process-button');
      const downloadButton = container.querySelector('.download-button');

      try {
          if (!file) {
              throw new Error(`No file found for tile (ID: ${container.dataset.fileId})`);
          }
          if (progressBar) progressBar.classList.remove('hidden');
          if (processButton) processButton.disabled = true;
          if (downloadButton) downloadButton.disabled = true; // Disable download until processing is done
          loadingManager.show();

          const formData = new FormData();
          formData.append('file', file);

          const settings = this.settingsManager.getSettings();
          formData.append('compression_mode', settings.compression.mode);
          formData.append('resize_mode', settings.resize.mode);

          if (settings.resize.mode === 'custom') {
              if (settings.resize.width) formData.append('max_width', settings.resize.width);
              if (settings.resize.height) formData.append('max_height', settings.resize.height);
          }

          const watermarkSettings = settings.watermark;
          if (watermarkSettings.text) {
              formData.append('watermark_text', watermarkSettings.text);
              if (watermarkSettings.position) formData.append('watermark_position', watermarkSettings.position);
              if (watermarkSettings.font_size) formData.append('watermark_font_size', watermarkSettings.font_size);
              if (watermarkSettings.color) formData.append('watermark_color', watermarkSettings.color);
              formData.append('watermark_opacity', watermarkSettings.opacity.toString());
          }

          const response = await fetch('/process', { // Unified endpoint
              method: 'POST',
              body: formData,
          });

          if (!response.ok) {
              const errorData = await response.json().catch(() => ({ error: `HTTP error! status: ${response.status}` }));
              throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
          }

          const result = await response.json();

          container.setAttribute('data-processed-data', result.processed_data_key); // Key to retrieve data later
          container.setAttribute('data-processed-filename', result.filename);

          if (downloadButton) downloadButton.disabled = false;

          this.updateProcessingStatus(container, 'processed'); // Generic status
          this.updateFinalInformation(container, result.metadata);

          if (result.warnings && result.warnings.length > 0) {
              this.showWarnings(container, result.warnings);
          }

      } catch (error) {
          console.error('Processing error:', error);
          this.showError(container, `Processing failed: ${error.message}`);
      } finally {
          if (progressBar) progressBar.classList.add('hidden');
          if (processButton) processButton.disabled = false;
          loadingManager.hide();
      }
    }

    async processSelectedFiles() {
      const selectedTiles = Array.from(document.querySelectorAll('.preview-tile'))
          .filter((tile) => {
              const checkbox = tile.querySelector('.image-select');
              return checkbox && checkbox.checked;
          });

      if (selectedTiles.length === 0) {
          alert("No files selected for processing.");
          return;
      }

      const items = selectedTiles.map((tile) => ({
          tile,
          file: this.getFileForTile(tile)
      })).filter(item => item.file); // Ensure file exists

      if (items.length === 0 && selectedTiles.length > 0) {
          alert("Could not find file data for some selected tiles. Please try re-uploading.");
          return;
      }
      if (items.length === 0) return;


      this.batchProcessor.addToQueue(items);
      await this.batchProcessor.processQueue(async (item) => {
          await this.processImage(item.tile, item.file);
      });
    }

    async downloadProcessedFile(container) { // Renamed from downloadCompressedFile for clarity
      try {
          const processedDataKey = container.getAttribute('data-processed-key');
          const filename = container.getAttribute('data-processed-filename');

          if (!processedDataKey || !filename) {
              this.showError(container, 'No processed data available for download.');
              return; // Exit if no data
          }

          loadingManager.show();
          // The backend should handle serving the file based on the key
          const response = await fetch(`/download/${processedDataKey}`); // Endpoint expects the key

          if (response.ok) {
              const blob = await response.blob();
              const url = window.URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.style.display = 'none';
              a.href = url;
              a.download = filename; // Use the filename from processing
              document.body.appendChild(a);
              a.click();
              window.URL.revokeObjectURL(url);
              document.body.removeChild(a);
          } else {
              const errorData = await response.json().catch(() => ({ error: 'Download request failed.'}));
              throw new Error(errorData.error || `Download failed: ${response.status}`);
          }
      } catch (error) {
          console.error('Download error:', error);
          this.showError(container, `Download failed: ${error.message}`);
      } finally {
          loadingManager.hide();
      }
    }

    async downloadSelectedFiles() {
      const filesToDownload = [];
      this.selectedFileIds.forEach(fileId => {
          const tile = document.querySelector(`.preview-tile[data-file-id="${fileId}"]`);
          if (tile) {
              const key = tile.getAttribute('data-processed-key');
              const filename = tile.getAttribute('data-processed-filename');
              if (key && filename) {
                  filesToDownload.push({ key, filename });
              } else {
                  console.warn(`Tile ${fileId} is selected but not processed or missing data.`);
              }
          }
      });

      if (filesToDownload.length === 0) {
          alert('No processed files selected for download.');
          return;
      }

      if (filesToDownload.length === 1) {
          const tile = document.querySelector(`.preview-tile[data-file-id="${Array.from(this.selectedFileIds)[0]}"]`);
          if (tile) await this.downloadProcessedFile(tile);
          return;
      }

      // For multiple files, use JSZip (assuming JSZip is globally available or imported)
      if (typeof JSZip === 'undefined') {
          alert('JSZip library is not loaded. Cannot download multiple files as a zip.');
          console.error('JSZip not found.');
          return;
      }

      const zip = new JSZip();
      try {
          loadingManager.show();
          // Fetch each file to add to the zip. This assumes /download/:key returns the file directly.
          // This could be optimized by a batch download endpoint on the server.
          for (const fileInfo of filesToDownload) {
              const response = await fetch(`/download/${fileInfo.key}`);
              if (response.ok) {
                  const blob = await response.blob();
                  zip.file(fileInfo.filename, blob);
              } else {
                  console.warn(`Failed to fetch ${fileInfo.filename} for zipping. Status: ${response.status}`);
                  // Optionally notify user about specific file failures
              }
          }

          if (Object.keys(zip.files).length === 0) {
              alert("No files could be added to the zip. Download aborted.");
              return;
          }

          const content = await zip.generateAsync({
              type: 'blob',
              compression: 'DEFLATE',
              compressionOptions: { level: 9 },
          });

          const url = URL.createObjectURL(content);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'processed_images.zip';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

      } catch (error) {
          console.error('Error creating zip file:', error);
          alert('Failed to create zip file. Please try again or download files individually.');
      } finally {
          loadingManager.hide();
      }
    }

    getFileForTile(tile) {
      if (!tile || !tile.dataset.fileId) return null;
      return this.fileMap.get(tile.dataset.fileId);
    }

    updateFileSelectionState(checkbox) { // Renamed from updateFileSelection
      const tile = checkbox.closest('.preview-tile');
      if (!tile) return;
      const fileId = tile.dataset.fileId;

      if (checkbox.checked) {
        this.selectedFileIds.add(fileId);
      } else {
        this.selectedFileIds.delete(fileId);
      }
      // The actual UI update (count, button states) is handled by updateSelectionCount
    }

    updateBatchButtonsState() { // Renamed from updateBatchButtons
      const hasSelection = this.selectedFileIds.size > 0;
      const processSelectedButton = document.getElementById('process-selected');
      const downloadSelectedButton = document.getElementById('download-selected');

      if (processSelectedButton) processSelectedButton.disabled = !hasSelection;
      if (downloadSelectedButton) downloadSelectedButton.disabled = !hasSelection;
    }

    updateSelectionCount() {
      const count = this.selectedFileIds.size;
      const selectedFilesElement = document.getElementById('selected-files-count');
      if (selectedFilesElement) {
        selectedFilesElement.textContent = count;
      }
      this.updateBatchButtonsState(); // Update button states whenever selection count changes
      this.batchProcessor.updateCounters(); // Also update batch processor's view of selected files
    }

    showWarnings(container, warnings) {
      const existingWarnings = container.querySelector('.warning-message-area'); // Use a dedicated area
      if (existingWarnings) existingWarnings.innerHTML = ''; // Clear previous
      else return; // No area to show warnings

      const warningHtml = warnings.map(warning => `
        <div class="mdc-chip" role="row">
          <span class="mdc-chip__ripple"></span>
          <i class="material-icons mdc-chip__icon mdc-chip__icon--leading">warning</i>
          <span role="gridcell">
            <span role="button" tabindex="0" class="mdc-chip__primary-action">
              <span class.mdc-chip__text">${warning}</span>
            </span>
          </span>
        </div>
      `).join('');
      existingWarnings.innerHTML = warningHtml;
      existingWarnings.classList.remove('hidden');
      // Initialize MDC Chips if they were dynamically added and not auto-initialized
      existingWarnings.querySelectorAll('.mdc-chip').forEach(el => { try { new mdc.chips.MDCChip(el); } catch(e){} });
    }

    showError(container, message) {
      const errorArea = container.querySelector('.error-message-area'); // Use a dedicated area
      if (!errorArea) {
          console.error("Error display area not found in tile:", message);
          alert(`Error on tile: ${message}`); // Fallback
          return;
      }
      errorArea.innerHTML = `
        <div class="mdc-chip mdc-chip--touch error-chip" role="row">
          <span class="mdc-chip__ripple"></span>
          <i class="material-icons mdc-chip__icon mdc-chip__icon--leading">error</i>
          <span role="gridcell">
            <span role="button" tabindex="-1" class="mdc-chip__primary-action">
              <span class.mdc-chip__text">${message}</span>
            </span>
          </span>
        </div>
      `;
      errorArea.classList.remove('hidden');
      try { new mdc.chips.MDCChip(errorArea.querySelector('.mdc-chip')); } catch(e){}

      setTimeout(() => {
          errorArea.classList.add('hidden');
          errorArea.innerHTML = '';
      }, 7000); // Increased timeout for errors
    }

    updateTileUIAfterProcessing(container, metadata, statusType) { // Renamed from updateFinalInformation
      const processedInfoSection = container.querySelector('.processed-info');
      if (processedInfoSection) processedInfoSection.classList.remove('hidden');

      if (metadata) {
          const finalSizeEl = container.querySelector('.final-size');
          if (finalSizeEl) finalSizeEl.textContent = this.formatFileSize(metadata.compressed_size);

          const finalDimsEl = container.querySelector('.final-dimensions');
          if (finalDimsEl && metadata.final_dimensions) {
              finalDimsEl.textContent = `${metadata.final_dimensions[0]} × ${metadata.final_dimensions[1]}px`;
          }
          const finalAspectRatioEl = container.querySelector('.final-aspect-ratio');
          if (finalAspectRatioEl && metadata.final_dimensions) {
               finalAspectRatioEl.textContent = (metadata.final_dimensions[0] / metadata.final_dimensions[1]).toFixed(2);
          }

          const savingsEl = container.querySelector('.space-saved');
          if (savingsEl && metadata.original_size && metadata.compressed_size) {
              const savings = Math.round((1 - metadata.compressed_size / metadata.original_size) * 100);
              savingsEl.textContent = `${savings}%`;
          }
      }
      this.updateProcessingStatusIndicator(container, statusType); // e.g., 'compressed', 'resized', 'processed'
    }

    formatFileSize(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
    }

    initializeMDCComponentsForTile(tile) { // Renamed from initializeMDCComponents
      tile.querySelectorAll('.mdc-checkbox').forEach(el => { try { new mdc.checkbox.MDCCheckbox(el); } catch(e){} });
      tile.querySelectorAll('.mdc-button').forEach(el => { try { new mdc.ripple.MDCRipple(el); } catch(e){} });
      // Tile-specific progress bar, if any, should be initialized here or when shown
      const tileProgressBarEl = tile.querySelector('.tile-progress-bar .mdc-linear-progress');
      if (tileProgressBarEl) {
          try {
              const progressInstance = new mdc.linearProgress.MDCLinearProgress(tileProgressBarEl);
              // Store instance if needed, e.g., tile.dataset.mdcProgress = progressInstance;
          } catch(e) {
              console.warn("Could not init MDCLinearProgress on tile:", e);
          }
      }
      // Chips for warnings/errors are initialized when shown
    }

    updateProcessingStatusIndicator(container, type) { // Renamed from updateProcessingStatus
      // Example: find a chip or icon and update its text/class
      const statusIndicator = container.querySelector(`.status-indicator.${type}`); // e.g. <span class="status-indicator compressed">Compressed</span>
      if (statusIndicator) {
        statusIndicator.classList.remove('hidden');
        statusIndicator.classList.add('show'); // For potential animation
      }
      // Or, more robustly, update a dedicated status text area
      const statusTextEl = container.querySelector('.tile-status-text');
      if (statusTextEl) {
          statusTextEl.textContent = `${type.charAt(0).toUpperCase() + type.slice(1)}!`; // "Processed!", "Compressed!"
          statusTextEl.classList.remove('hidden');
      }
    }

    removeTile(tile) {
      const fileId = tile.dataset.fileId;
      if (fileId) {
          this.fileMap.delete(fileId);
          this.selectedFileIds.delete(fileId); // Remove from selection if present
      }
      tile.remove();
      this.updateSelectionCount(); // Update counts and button states
      this.batchProcessor.updateCounters(); // Update total file count for batch processor

      if (document.querySelectorAll('.preview-tile').length === 0 && this.previewArea) {
          this.previewArea.classList.add('hidden'); // Hide preview area if no tiles left
      }
    }
  } // End of ImageCompressor class

  // Theme management functions
  function initializeTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const currentTheme = savedTheme || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', currentTheme);
    updateThemeIcon(currentTheme);

    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) themeToggle.addEventListener('click', toggleTheme);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('theme')) { // Only if no user preference is set
        const newTheme = e.matches ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        updateThemeIcon(newTheme);
      }
    });
  }

  function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon(newTheme);

    // Optional: Sync theme with server
    fetch('/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme }),
    }).catch((error) => console.warn('Failed to sync theme with server:', error));
  }

  function updateThemeIcon(theme) {
    const themeIcon = document.getElementById('theme-toggle');
    if (themeIcon) themeIcon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
  }

  // Login form initialization
  function initializeLoginForm() {
    const form = document.getElementById('login-form');
    if (!form) return;

    document.querySelectorAll('#login-form .mdc-text-field').forEach((element) => {
      try { new mdc.textField.MDCTextField(element); } catch(e){}
    });
    document.querySelectorAll('#login-form .mdc-button').forEach((element) => {
      try { new mdc.ripple.MDCRipple(element); } catch(e){}
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      fetch(this.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(this)),
        credentials: 'same-origin', // Important for session handling
      })
      .then((response) => {
        if (response.redirected) {
          window.location.href = response.url;
        } else if (response.ok) {
          // If login is successful but no redirect, might mean it's an SPA update or just a success message
          // For now, assume redirect is the primary success path.
          // If an error message is returned as HTML (e.g. validation error)
          return response.text().then(html => {
              // Attempt to replace form or show error message from HTML
              // This part is highly dependent on server response format for errors
              const errorContainer = document.getElementById('login-error-message'); // Assuming such an element exists
              if (errorContainer) {
                  // A simple way: just put the response text in.
                  // A better way: parse HTML and extract relevant error part.
                  const tempDiv = document.createElement('div');
                  tempDiv.innerHTML = html;
                  const serverError = tempDiv.querySelector('.error-message'); // Or whatever class server uses
                  if (serverError) {
                      errorContainer.innerHTML = serverError.innerHTML;
                      errorContainer.classList.remove('hidden');
                  } else {
                       // Fallback if no specific error message found in HTML
                      errorContainer.textContent = "Login failed. Please check your credentials.";
                      errorContainer.classList.remove('hidden');
                  }
              } else {
                  // If no dedicated error container, might need to reload part of the page or show an alert
                  console.warn("Login error, but no error container found in DOM.");
              }
          });
        } else {
          // Handle other non-OK responses (e.g., 400, 401, 500)
          return response.json().then(err => { // Assuming server sends JSON error for non-200
              const errorContainer = document.getElementById('login-error-message');
              if (errorContainer) {
                  errorContainer.textContent = err.error || "An unknown error occurred.";
                  errorContainer.classList.remove('hidden');
              } else {
                  alert(err.error || "Login failed.");
              }
          }).catch(() => { // If response is not JSON
              const errorContainer = document.getElementById('login-error-message');
              if (errorContainer) {
                  errorContainer.textContent = "Login failed. Server returned an unexpected response.";
                  errorContainer.classList.remove('hidden');
              } else {
                  alert("Login failed. Server returned an unexpected response.");
              }
          });
        }
      })
      .catch((error) => {
        console.error('Login Fetch Error:', error);
        const errorContainer = document.getElementById('login-error-message');
          if (errorContainer) {
              errorContainer.textContent = "A network error occurred. Please try again.";
              errorContainer.classList.remove('hidden');
          } else {
              alert("A network error occurred during login.");
          }
      });
    });
  }
})();

