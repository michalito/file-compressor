// Wrap the entire code in an IIFE or module to prevent polluting the global namespace
(() => {
    // Helper function to get CSRF token
    function getCSRFToken() {
        const token = document.querySelector('meta[name="csrf-token"]');
        return token ? token.getAttribute('content') : '';
    }

    // OPTIMIZATION: Debounce helper to reduce unnecessary function calls
    function debounce(func, wait) {
      let timeout;
      return function executedFunction(...args) {
        const later = () => {
          clearTimeout(timeout);
          func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
      };
    }

    // OPTIMIZATION: Fast hex-to-binary conversion helper
    function hexToUint8Array(hexString) {
      const length = hexString.length / 2;
      const uint8Array = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        uint8Array[i] = parseInt(hexString.substr(i * 2, 2), 16);
      }
      return uint8Array;
    }

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
  
      // Add scroll listener for batch controls shadow (OPTIMIZATION: debounced)
      const batchControls = document.querySelector('.batch-controls');
      if (batchControls) {
        const handleScroll = debounce(() => {
          batchControls.classList.toggle('scrolled', window.scrollY > 64);
        }, 150);
        window.addEventListener('scroll', handleScroll);
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
        };
        this.compressionDisplay = null;
        this.resizeModeDisplay = null;
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
          [customSizeRadio, originalSizeRadio].forEach((radio) => {
            radio.addEventListener('change', () => {
              customSizeControls.classList.toggle('hidden', !customSizeRadio.checked);
            });
          });
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
            customSizeControls.classList.remove('hidden');
          });
        });
      }
  
      initializeDisplays() {
        // Initialize display elements for settings summaries
        this.compressionDisplay = document.getElementById('compression-mode-display');
        this.resizeModeDisplay = document.getElementById('resize-mode-display');
        this.resizeDimensionsDisplay = document.getElementById('resize-dimensions-display');
        this.customSizeDisplay = document.querySelector('.custom-size-display');
      }
  
      loadSettings() {
        const savedSettings = localStorage.getItem('imageProcessorSettings');
        if (savedSettings) {
          this.settings = JSON.parse(savedSettings);
          this.updateDisplays();
          this.applySettingsToControls();
        }
      }
  
      saveSettings() {
        localStorage.setItem('imageProcessorSettings', JSON.stringify(this.settings));
        this.updateDisplays();
      }
  
      updateDisplays() {
        // Update compression display
        this.compressionDisplay.textContent = this.getCompressionModeDisplay(this.settings.compression.mode);
  
        // Update resize display
        if (this.settings.resize.mode === 'original') {
          this.resizeModeDisplay.textContent = 'Original Size';
          this.customSizeDisplay.classList.add('hidden');
        } else {
          this.resizeModeDisplay.textContent = 'Custom Size';
          this.resizeDimensionsDisplay.textContent = `${this.settings.resize.width} × ${this.settings.resize.height}px`;
          this.customSizeDisplay.classList.remove('hidden');
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
  
      applySettingsToControls() {
        // Apply compression settings
        const compressionRadio = document.querySelector(`input[name="compression-type"][value="${this.settings.compression.mode}"]`);
        if (compressionRadio) compressionRadio.checked = true;
  
        // Apply resize settings
        const resizeRadio = document.querySelector(`input[name="resize-type"][value="${this.settings.resize.mode}"]`);
        if (resizeRadio) resizeRadio.checked = true;
  
        if (this.settings.resize.mode === 'custom') {
          const customWidthInput = document.getElementById('custom-width');
          const customHeightInput = document.getElementById('custom-height');
          const maintainAspectRatioCheckbox = document.getElementById('maintain-aspect-ratio');
          const customSizeControls = document.querySelector('.custom-size-controls');
  
          if (customWidthInput && customHeightInput && maintainAspectRatioCheckbox) {
            customWidthInput.value = this.settings.resize.width || '';
            customHeightInput.value = this.settings.resize.height || '';
            maintainAspectRatioCheckbox.checked = this.settings.resize.maintainAspectRatio;
            customSizeControls.classList.remove('hidden');
          }
        }
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
        if (selectedMode) {
          this.settings.resize = {
            mode: selectedMode,
            width: null,
            height: null,
            maintainAspectRatio: document.getElementById('maintain-aspect-ratio').checked,
          };
  
          if (selectedMode === 'custom') {
            this.settings.resize.width = parseInt(document.getElementById('custom-width').value, 10) || null;
            this.settings.resize.height = parseInt(document.getElementById('custom-height').value, 10) || null;
          }
  
          this.saveSettings();
          this.closeModal(document.getElementById('resize-modal'));
        }
      }
  
      openModal(modal) {
        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
      }
  
      closeModal(modal) {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
        this.applySettingsToControls(); // Reset controls to current settings
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
        this.chunkSize = 5;
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
  
        totalFilesElement.textContent = document.querySelectorAll('.preview-tile').length;
        selectedFilesElement.textContent = document.querySelectorAll('.image-select:checked').length;
        processedCountElement.textContent = this.processed;
        totalCountElement.textContent = this.total;
      }
  
      showProgress() {
        const progressElement = document.querySelector('.batch-progress');
        progressElement.classList.remove('hidden');
        this.progressBar.open();
        this.startTime = Date.now();
      }
  
      hideProgress() {
        const progressElement = document.querySelector('.batch-progress');
        this.progressBar.close();
        setTimeout(() => {
          progressElement.classList.add('hidden');
        }, 300);
      }
  
      updateProgress() {
        if (this.total === 0) return;
  
        const progress = this.processed / this.total;
        this.progressBar.progress = progress;
  
        if (this.startTime) {
          const elapsed = (Date.now() - this.startTime) / 1000;
          const averageTimePerItem = elapsed / this.processed;
          const remaining = (this.total - this.processed) * averageTimePerItem;
  
          const timeRemainingElement = document.getElementById('time-remaining');
          timeRemainingElement.textContent =
            remaining > 60
              ? `About ${Math.ceil(remaining / 60)} minutes remaining`
              : `About ${Math.ceil(remaining)} seconds remaining`;
        }
      }
  
      async processQueue(processor) {
        if (this.processing || this.queue.length === 0) return;
  
        this.processing = true;
        this.cancelled = false;
        this.processed = 0;
        this.total = this.queue.length;
  
        this.showProgress();
  
        while (this.queue.length > 0 && !this.cancelled) {
          const chunk = this.queue.splice(0, this.chunkSize);
          await Promise.all(
            chunk.map(async (item) => {
              try {
                await processor(item);
                this.processed += 1;
                this.updateProgress();
                this.updateCounters();
              } catch (error) {
                console.error('Processing error:', error);
              }
            })
          );
        }
  
        this.processing = false;
        this.hideProgress();
        this.updateCounters();
      }
  
      cancel() {
        this.cancelled = true;
        this.queue = [];
        this.hideProgress();
      }
    }

    // ImageCompressor class to handle image compression and resizing
    class ImageCompressor {
      constructor(settingsManager, batchProcessor) {
          this.selectedFiles = new Set();
          this.fileMap = new Map();
          this.compressedDataMap = new Map(); // OPTIMIZATION: Store compressed data in Map, not DOM
          this.template = document.getElementById('image-tile-template');
          this.previewArea = document.getElementById('preview-area');
          this.settingsManager = settingsManager;
          this.batchProcessor = batchProcessor;
          this.initializeDropZone();
          this.initializeBatchControls();
          this.updateSelectionCount();
      }
  
      initializeDropZone() {
        const dropZone = document.querySelector('.upload-area');
        const fileInput = document.getElementById('file-input');
  
        ['dragover', 'dragleave', 'drop'].forEach((eventName) => {
          dropZone.addEventListener(eventName, (e) => e.preventDefault());
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
                    this.updateFileSelection(checkbox);
                });
                this.updateBatchButtons();
                this.updateSelectionCount();
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
        if (files.length > 0) {
          this.previewArea.classList.remove('hidden');
        }
  
        Array.from(files).forEach((file) => {
          if (file.type.startsWith('image/')) {
            this.createImageTile(file);
          }
        });
  
        this.batchProcessor.updateCounters();
      }
  
      createImageTile(file) {
        const tileContent = this.template.content.cloneNode(true);
        const container = tileContent.querySelector('.preview-tile');
  
        const fileId = `file-${Date.now()}-${file.name}`;
        this.fileMap.set(fileId, file);
        container.dataset.fileId = fileId;
        container.dataset.originalFile = file.name;
  
        const img = new Image();
        img.onload = () => {
          const previewImg = container.querySelector('.preview-image');
          previewImg.src = img.src;
  
          const aspectRatio = (img.naturalWidth / img.naturalHeight).toFixed(2);
          container.querySelector('.dimensions').textContent = `${img.naturalWidth} × ${img.naturalHeight}px`;
          container.querySelector('.aspect-ratio').textContent = aspectRatio;
  
          URL.revokeObjectURL(img.src);
        };
        img.src = URL.createObjectURL(file);
  
        container.querySelector('.filename').textContent = file.name;
        container.querySelector('.file-size').textContent = this.formatFileSize(file.size);
  
        const previewGrid = document.querySelector('.preview-grid');
        previewGrid.appendChild(tileContent);
  
        const appendedContainer = previewGrid.querySelector(`[data-file-id="${fileId}"]`);
        if (appendedContainer) {
          this.setupTileControls(appendedContainer, file);
          this.initializeMDCComponents(appendedContainer);
        }
      }
  
      setupTileControls(tile, file) {
        const processButton = tile.querySelector('.process-button');
        const checkbox = tile.querySelector('.image-select');
        const downloadButton = tile.querySelector('.download-button');

        processButton.addEventListener('click', () => this.processImage(tile, file));
        checkbox.addEventListener('change', () => {
            this.updateFileSelection(checkbox);
            this.updateBatchButtons();
            this.updateSelectionCount();
        });
        downloadButton.addEventListener('click', () => this.downloadCompressedFile(tile));
      }

      async processImage(container, file) {
        const progressBar = container.querySelector('.compression-progress');
        const processButton = container.querySelector('.process-button');
        const downloadButton = container.querySelector('.download-button');
    
        try {
            if (!file) {
                throw new Error(`No file found for ${container.dataset.originalFile}`);
            }
            progressBar.classList.remove('hidden');
            processButton.disabled = true;
            loadingManager.show();
    
            const formData = new FormData();
            formData.append('file', file);
    
            // Get settings from both modals
            const settings = this.settingsManager.getSettings();
            formData.append('compression_mode', settings.compression.mode);
            formData.append('resize_mode', settings.resize.mode);
            
            if (settings.resize.mode === 'custom') {
                formData.append('max_width', settings.resize.width);
                formData.append('max_height', settings.resize.height);
            }
    
            formData.append('csrf_token', getCSRFToken());
            const response = await fetch('/process', {
                method: 'POST',
                body: formData,
            });
    
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }
    
            const result = await response.json();

            // OPTIMIZATION: Store compressed data in Map instead of DOM attribute
            const fileId = container.dataset.fileId;
            this.compressedDataMap.set(fileId, {
                data: result.compressed_data,
                filename: result.filename
            });
            container.setAttribute('data-compressed-filename', result.filename);

            downloadButton.disabled = false;
    
            // Update both processing status indicators
            this.updateProcessingStatus(container, 'compressed');
            if (settings.resize.mode === 'custom') {
                this.updateProcessingStatus(container, 'resized');
            }
    
            this.updateFinalInformation(container, result.metadata);
    
            if (result.warnings && result.warnings.length > 0) {
                this.showWarnings(container, result.warnings);
            }
        } catch (error) {
            console.error('Processing error:', error);
            this.showError(container, `Processing failed: ${error.message}`);
        } finally {
            progressBar.classList.add('hidden');
            processButton.disabled = false;
            loadingManager.hide();
        }
      }

      async processSelectedFiles() {
        const selectedTiles = Array.from(document.querySelectorAll('.preview-tile'))
            .filter((tile) => tile.querySelector('.image-select').checked);

        const items = selectedTiles.map((tile) => ({
            tile,
            file: this.getFileForTile(tile)
        }));

        this.batchProcessor.addToQueue(items);
        await this.batchProcessor.processQueue(async (item) => {
            await this.processImage(item.tile, item.file);
        });
      }
  
      async compressImage(container, file) {
        const progressBar = container.querySelector('.compression-progress');
        const compressButton = container.querySelector('.compress-button');
        const downloadButton = container.querySelector('.download-button');
  
        try {
          if (!file) {
            throw new Error(`No file found for ${container.dataset.originalFile}`);
          }
          progressBar.classList.remove('hidden');
          compressButton.disabled = true;
          loadingManager.show();
  
          const formData = new FormData();
          formData.append('file', file);
  
          const settings = this.settingsManager.getSettings();
          formData.append('mode', settings.compression.mode);
          formData.append('csrf_token', getCSRFToken());

          const response = await fetch('/compress', {
            method: 'POST',
            body: formData,
          });
  
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
          }
  
          const result = await response.json();

          // OPTIMIZATION: Store compressed data in Map instead of DOM attribute
          const fileId = container.dataset.fileId;
          this.compressedDataMap.set(fileId, {
              data: result.compressed_data,
              filename: result.filename
          });
          container.setAttribute('data-compressed-filename', result.filename);

          downloadButton.disabled = false;

          this.updateProcessingStatus(container, 'compressed');
  
          this.updateFinalInformation(container, result.metadata);
  
          if (result.warnings && result.warnings.length > 0) {
            this.showWarnings(container, result.warnings);
          }
        } catch (error) {
          console.error('Compression error:', error);
          this.showError(container, `Compression failed: ${error.message}`);
        } finally {
          progressBar.classList.add('hidden');
          compressButton.disabled = false;
          loadingManager.hide();
        }
      }

      async resizeImage(container, file) {
        const progressBar = container.querySelector('.compression-progress');
        const resizeButton = container.querySelector('.resize-button');
        const downloadButton = container.querySelector('.download-button');
  
        try {
          loadingManager.show();
          progressBar.classList.remove('hidden');
          resizeButton.disabled = true;
  
          const formData = new FormData();
          formData.append('file', file);
  
          const settings = this.settingsManager.getSettings();
          if (settings.resize.mode === 'custom') {
            if (settings.resize.width) formData.append('max_width', settings.resize.width);
            if (settings.resize.height) formData.append('max_height', settings.resize.height);
          }
          formData.append('csrf_token', getCSRFToken());

          const response = await fetch('/resize', {
            method: 'POST',
            body: formData,
          });
  
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
          }
  
          const result = await response.json();

          // OPTIMIZATION: Store compressed data in Map instead of DOM attribute
          const fileId = container.dataset.fileId;
          this.compressedDataMap.set(fileId, {
              data: result.compressed_data,
              filename: result.filename
          });
          container.setAttribute('data-compressed-filename', result.filename);

          this.updateProcessingStatus(container, 'resized');
          downloadButton.disabled = false;
          this.updateFinalInformation(container, result.metadata);
  
          if (result.warnings && result.warnings.length > 0) {
            this.showWarnings(container, result.warnings);
          }
        } catch (error) {
          console.error('Resize error:', error);
          this.showError(container, error.message);
        } finally {
          progressBar.classList.add('hidden');
          resizeButton.disabled = false;
          loadingManager.hide();
        }
      }

      async downloadCompressedFile(container) {
        try {
            // OPTIMIZATION: Retrieve compressed data from Map instead of DOM
            const fileId = container.dataset.fileId;
            const compressedInfo = this.compressedDataMap.get(fileId);

            if (!compressedInfo || !compressedInfo.data || !compressedInfo.filename) {
                throw new Error('Missing compressed data or filename');
            }

            const compressedData = compressedInfo.data;
            const filename = compressedInfo.filename;

            const response = await fetch('/download', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCSRFToken(),
                },
                body: JSON.stringify({
                    compressed_data: compressedData,
                    filename: filename,
                }),
            });

            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `processed_${filename}`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
            } else {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Download failed');
            }
        } catch (error) {
            console.error('Download error:', error);
            this.showError(container, error.message);
        }
      }

      async compressSelectedFiles() {
        const selectedTiles = Array.from(document.querySelectorAll('.preview-tile'))
          .filter((tile) => tile.querySelector('.image-select').checked);
  
        const items = selectedTiles.map((tile) => ({
          tile,
          file: this.getFileForTile(tile),
          type: 'compress',
        }));
  
        this.batchProcessor.addToQueue(items);
        await this.batchProcessor.processQueue(async (item) => {
          await this.compressImage(item.tile, item.file);
        });
      }
  
      async resizeSelectedFiles() {
        const selectedTiles = Array.from(document.querySelectorAll('.preview-tile'))
          .filter((tile) => tile.querySelector('.image-select').checked);
  
        const items = selectedTiles.map((tile) => ({
          tile,
          file: this.getFileForTile(tile),
          type: 'resize',
        }));
  
        this.batchProcessor.addToQueue(items);
        await this.batchProcessor.processQueue(async (item) => {
          await this.resizeImage(item.tile, item.file);
        });
      }
  
      async downloadSelectedFiles() {
        const selectedTiles = Array.from(document.querySelectorAll('.preview-tile'))
            .filter((tile) => tile.querySelector('.image-select').checked);

        if (selectedTiles.length === 1) {
            await this.downloadCompressedFile(selectedTiles[0]);
        } else if (selectedTiles.length > 1) {
            const zip = new JSZip();

            try {
                loadingManager.show();

                for (const tile of selectedTiles) {
                    // OPTIMIZATION: Retrieve from Map and use fast hex conversion
                    const fileId = tile.dataset.fileId;
                    const compressedInfo = this.compressedDataMap.get(fileId);

                    if (compressedInfo && compressedInfo.data && compressedInfo.filename) {
                        const binaryData = hexToUint8Array(compressedInfo.data);
                        zip.file(compressedInfo.filename, binaryData);
                    }
                }

                const content = await zip.generateAsync({
                    type: 'blob',
                    compression: 'DEFLATE',
                    compressionOptions: {
                        level: 9,
                    },
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
                alert('Failed to create zip file. Please try again.');
            } finally {
                loadingManager.hide();
            }
        }
      }

      getFileForTile(tile) {
        const fileId = tile.dataset.fileId;
        return this.fileMap.get(fileId);
      }
  
      updateFileSelection(checkbox) {
        const tile = checkbox.closest('.preview-tile');
        const filename = tile.dataset.originalFile;
  
        if (checkbox.checked) {
          this.selectedFiles.add(filename);
        } else {
          this.selectedFiles.delete(filename);
        }
      }
  
      updateBatchButtons() {
        const hasSelection = this.selectedFiles.size > 0;
        const processSelectedButton = document.getElementById('process-selected');
        const downloadSelectedButton = document.getElementById('download-selected');

        if (processSelectedButton) processSelectedButton.disabled = !hasSelection;
        if (downloadSelectedButton) downloadSelectedButton.disabled = !hasSelection;
      }
  
      updateSelectionCount() {
        const count = this.selectedFiles.size;
        const selectedFilesElement = document.getElementById('selected-files-count');
        if (selectedFilesElement) {
          selectedFilesElement.textContent = count;
        }
        this.updateBatchButtons();
      }
  
      showWarnings(container, warnings) {
        const existingWarnings = container.querySelector('.warning-message');
        existingWarnings?.remove();
  
        const warningDiv = document.createElement('div');
        warningDiv.className = 'warning-message';
        warningDiv.innerHTML = warnings
          .map(
            (warning) => `
          <div class="mdc-chip">
            <i class="material-icons mdc-chip__icon mdc-chip__icon--leading">warning</i>
            <span class="mdc-chip__text">${warning}</span>
          </div>
        `
          )
          .join('');
  
        container.appendChild(warningDiv);
      }
  
      showError(container, message) {
        const existingError = container.querySelector('.error-message');
        existingError?.remove();
  
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.innerHTML = `
          <div class="mdc-chip error-chip">
            <i class="material-icons mdc-chip__icon mdc-chip__icon--leading">error</i>
            <span class="mdc-chip__text">${message}</span>
          </div>
        `;
  
        container.appendChild(errorDiv);
        setTimeout(() => container.querySelector('.error-message')?.remove(), 5000);
      }
  
      updateFinalInformation(container, metadata) {
        const processedInfo = container.querySelector('.processed-info');
        processedInfo.classList.remove('hidden');
  
        const finalWidth = metadata.final_dimensions[0];
        const finalHeight = metadata.final_dimensions[1];
        const finalAspectRatio = (finalWidth / finalHeight).toFixed(2);
  
        container.querySelector('.final-size').textContent = this.formatFileSize(metadata.compressed_size);
        container.querySelector('.final-dimensions').textContent = `${finalWidth} × ${finalHeight}px`;
        container.querySelector('.final-aspect-ratio').textContent = finalAspectRatio;
  
        const savings = Math.round((1 - metadata.compressed_size / metadata.original_size) * 100);
        container.querySelector('.space-saved').textContent = `${savings}%`;
      }
  
      formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
      }
  
      initializeMDCComponents(tile) {
        tile.querySelectorAll('.mdc-checkbox').forEach((el) => new mdc.checkbox.MDCCheckbox(el));
        tile.querySelectorAll('.mdc-button').forEach((el) => new mdc.ripple.MDCRipple(el));
        tile.querySelectorAll('.mdc-linear-progress').forEach((el) => new mdc.linearProgress.MDCLinearProgress(el));
        tile.querySelectorAll('.mdc-chip').forEach((el) => new mdc.chips.MDCChip(el));
      }

      updateProcessingStatus(container, type) {
        const statusIndicator = container.querySelector(`.status-indicator.${type}`);
        statusIndicator.classList.remove('hidden');
        setTimeout(() => statusIndicator.classList.add('show'), 50);
      }

      removeTile(tile) {
        const fileId = tile.dataset.fileId;
        this.fileMap.delete(fileId);
        this.compressedDataMap.delete(fileId); // OPTIMIZATION: Clean up compressed data
        tile.remove();
      }
      // ... Additional methods for resizing images, downloading files, and updating UI ...
    }
  
    // Theme management functions
    function initializeTheme() {
      const savedTheme = localStorage.getItem('theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  
      const currentTheme = savedTheme || (prefersDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', currentTheme);
      updateThemeIcon(currentTheme);
  
      const themeToggle = document.getElementById('theme-toggle');
      themeToggle.addEventListener('click', toggleTheme);
  
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
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
  
      fetch('/theme', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': getCSRFToken(),
        },
        body: JSON.stringify({ theme: newTheme }),
      }).catch((error) => console.error('Failed to sync theme with server:', error));
    }
  
    function updateThemeIcon(theme) {
      const themeIcon = document.getElementById('theme-toggle');
      themeIcon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
    }
  
    // Login form initialization
    function initializeLoginForm() {
      const form = document.getElementById('login-form');
  
      document.querySelectorAll('.mdc-text-field').forEach((element) => {
        new mdc.textField.MDCTextField(element);
      });
  
      document.querySelectorAll('.mdc-button').forEach((element) => {
        new mdc.ripple.MDCRipple(element);
      });
  
      form.addEventListener('submit', function (e) {
        e.preventDefault();
  
        fetch(this.action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(this)),
          credentials: 'same-origin',
        })
          .then((response) => {
            if (response.redirected) {
              window.location.href = response.url;
            } else {
              return response.text();
            }
          })
          .then((html) => {
            if (html) {
              document.documentElement.innerHTML = html;
              initializeLoginForm();
            }
          })
          .catch((error) => {
            console.error('Error:', error);
          });
      });
    }
  })();
  