class LoadingManager {
    constructor() {
        this.loader = document.getElementById('global-loader');
        this.progressBar = null;
        if (this.loader) {
            const progressElement = this.loader.querySelector('.mdc-linear-progress');
            this.progressBar = new mdc.linearProgress.MDCLinearProgress(progressElement);
        }
        this.activeRequests = 0;
    }

    show() {
        this.activeRequests++;
        if (this.loader && this.progressBar) {
            this.loader.classList.remove('hidden');
            this.progressBar.open();
            this.progressBar.determinate = false;
        }
    }

    hide() {
        this.activeRequests--;
        if (this.activeRequests <= 0) {
            this.activeRequests = 0;
            if (this.loader && this.progressBar) {
                this.progressBar.close();
                setTimeout(() => {
                    this.loader.classList.add('hidden');
                }, 300);
            }
        }
    }
}

let loadingManager;
document.addEventListener('DOMContentLoaded', function() {
    loadingManager = new LoadingManager();
    // Initialize Material Design Components for top app bar
    const topAppBar = document.querySelector('.mdc-top-app-bar');
    if (topAppBar) {
        new mdc.topAppBar.MDCTopAppBar(topAppBar);
    }

        
    // Initialize theme toggle
    initializeTheme();

    // Add scroll listener for batch controls shadow
    const batchControls = document.querySelector('.batch-controls');
    if (batchControls) {
        window.addEventListener('scroll', () => {
            if (window.scrollY > 64) {
                batchControls.classList.add('scrolled');
            } else {
                batchControls.classList.remove('scrolled');
            }
        });
    }

    class SettingsManager {
        constructor() {
            this.settings = {
                compression: {
                    mode: 'lossless'
                },
                resize: {
                    mode: 'original',
                    width: null,
                    height: null,
                    maintainAspectRatio: true
                }
            };

            // Only initialize if we're on the main page
            if (document.querySelector('.app-layout')) {
                this.initializeModals();
                this.initializeDisplays();
                this.loadSettings();
            }
        }

        initializeModals() {
            // Compression Modal
            const compressionModal = document.getElementById('compression-modal');
            const openCompressionBtn = document.getElementById('open-compression-settings');
            const closeCompressionBtn = document.getElementById('close-compression-modal');
            const saveCompressionBtn = document.getElementById('save-compression-settings');

            if (openCompressionBtn && compressionModal) {
                openCompressionBtn.addEventListener('click', () => this.openModal(compressionModal));
                closeCompressionBtn?.addEventListener('click', () => this.closeModal(compressionModal));
                saveCompressionBtn?.addEventListener('click', () => this.saveCompressionSettings());
            }

            // Resize Modal
            const resizeModal = document.getElementById('resize-modal');
            const openResizeBtn = document.getElementById('open-resize-settings');
            const closeResizeBtn = document.getElementById('close-resize-modal');
            const saveResizeBtn = document.getElementById('save-resize-settings');
            const customSizeRadio = document.getElementById('custom-size');
            const originalSizeRadio = document.getElementById('original-size');
            const customSizeControls = document.querySelector('.custom-size-controls');

            openResizeBtn.addEventListener('click', () => this.openModal(resizeModal));
            closeResizeBtn.addEventListener('click', () => this.closeModal(resizeModal));
            saveResizeBtn.addEventListener('click', () => this.saveResizeSettings());

            // Handle custom size controls visibility
            [customSizeRadio, originalSizeRadio].forEach(radio => {
                radio.addEventListener('change', () => {
                    customSizeControls.classList.toggle('hidden', !customSizeRadio.checked);
                });
            });

            // Close modals when clicking outside
            document.querySelectorAll('.modal-overlay').forEach(modal => {
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
            const maintainAspectRatio = document.getElementById('maintain-aspect-ratio');
            const widthInput = document.getElementById('custom-width');
            const heightInput = document.getElementById('custom-height');
            
            let aspectRatio = null;
            let isUpdating = false;

            function updateDimension(changedInput, otherInput) {
                if (!maintainAspectRatio.checked || !aspectRatio || isUpdating) return;
                
                isUpdating = true;
                const newValue = parseInt(changedInput.value);
                if (newValue && aspectRatio) {
                    if (changedInput === widthInput) {
                        otherInput.value = Math.round(newValue / aspectRatio);
                    } else {
                        otherInput.value = Math.round(newValue * aspectRatio);
                    }
                }
                isUpdating = false;
            }

            widthInput.addEventListener('input', () => updateDimension(widthInput, heightInput));
            heightInput.addEventListener('input', () => updateDimension(heightInput, widthInput));

            // Handle preset buttons
            document.querySelectorAll('.preset-buttons .mdc-button').forEach(button => {
                button.addEventListener('click', () => {
                    const width = parseInt(button.dataset.width);
                    const height = parseInt(button.dataset.height);
                    
                    widthInput.value = width;
                    heightInput.value = height;
                    aspectRatio = width / height;

                    document.getElementById('custom-size').checked = true;
                    document.querySelector('.custom-size-controls').classList.remove('hidden');
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
            // Load settings from localStorage
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
                this.resizeDimensionsDisplay.textContent = 
                    `${this.settings.resize.width} × ${this.settings.resize.height}px`;
                this.customSizeDisplay.classList.remove('hidden');
            }
        }

        getCompressionModeDisplay(mode) {
            const modes = {
                'lossless': 'Lossless',
                'web': 'Web Optimized',
                'high': 'Maximum Compression'
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
                document.getElementById('custom-width').value = this.settings.resize.width || '';
                document.getElementById('custom-height').value = this.settings.resize.height || '';
                document.getElementById('maintain-aspect-ratio').checked = this.settings.resize.maintainAspectRatio;
                document.querySelector('.custom-size-controls').classList.remove('hidden');
            }
        }

        saveCompressionSettings() {
            const selectedMode = document.querySelector('input[name="compression-type"]:checked').value;
            this.settings.compression.mode = selectedMode;
            this.saveSettings();
            this.closeModal(document.getElementById('compression-modal'));
        }

        saveResizeSettings() {
            const selectedMode = document.querySelector('input[name="resize-type"]:checked').value;
            this.settings.resize = {
                mode: selectedMode,
                width: null,
                height: null,
                maintainAspectRatio: document.getElementById('maintain-aspect-ratio').checked
            };

            if (selectedMode === 'custom') {
                this.settings.resize.width = parseInt(document.getElementById('custom-width').value) || null;
                this.settings.resize.height = parseInt(document.getElementById('custom-height').value) || null;
            }

            this.saveSettings();
            this.closeModal(document.getElementById('resize-modal'));
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

    class BatchProcessor {
        constructor() {
            this.queue = [];
            this.processing = false;
            this.cancelled = false;
            this.processed = 0;
            this.total = 0;
            this.startTime = null;
            
            this.progressBar = new mdc.linearProgress.MDCLinearProgress(
                document.getElementById('batch-progress-bar')
            );
            
            this.setupCancelButton();
        }
        
        setupCancelButton() {
            const cancelButton = document.getElementById('cancel-batch');
            cancelButton.addEventListener('click', () => this.cancel());
        }
        
        addToQueue(items) {
            this.queue.push(...items);
            this.updateCounters();
        }
        
        updateCounters() {
            const totalFiles = document.getElementById('total-files-count');
            const selectedFiles = document.getElementById('selected-files-count');
            const processedCount = document.getElementById('processed-count');
            const totalCount = document.getElementById('total-count');
            
            totalFiles.textContent = document.querySelectorAll('.preview-tile').length;
            selectedFiles.textContent = document.querySelectorAll('.image-select:checked').length;
            processedCount.textContent = this.processed;
            totalCount.textContent = this.total;
        }
        
        showProgress() {
            const progress = document.querySelector('.batch-progress');
            progress.classList.remove('hidden');
            this.progressBar.open();
            this.startTime = Date.now();
        }
        
        hideProgress() {
            const progress = document.querySelector('.batch-progress');
            this.progressBar.close();
            setTimeout(() => {
                progress.classList.add('hidden');
            }, 300);
        }
        
        updateProgress() {
            if (this.total === 0) return;
            
            const progress = this.processed / this.total;
            this.progressBar.progress = progress;
            
            // Update time remaining
            if (this.startTime) {
                const elapsed = (Date.now() - this.startTime) / 1000;
                const averageTimePerItem = elapsed / this.processed;
                const remaining = (this.total - this.processed) * averageTimePerItem;
                
                const timeRemaining = document.getElementById('time-remaining');
                timeRemaining.textContent = remaining > 60 
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
                const item = this.queue.shift();
                try {
                    await processor(item);
                    this.processed++;
                    this.updateProgress();
                    this.updateCounters();
                } catch (error) {
                    console.error('Processing error:', error);
                }
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

    class ImageCompressor {
        constructor() {
            this.selectedFiles = new Set();
            this.template = document.getElementById('image-tile-template');
            this.previewArea = document.getElementById('preview-area');
            this.settingsManager = new SettingsManager();
            this.batchProcessor = new BatchProcessor();
            this.initializeDropZone();
            this.initializeBatchControls();
            this.updateSelectionCount();
        }

        initializeDropZone() {
            const dropZone = document.querySelector('.upload-area');
            const fileInput = document.getElementById('file-input');

            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.classList.add('dragover');
            });

            dropZone.addEventListener('dragleave', () => {
                dropZone.classList.remove('dragover');
            });

            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('dragover');
                this.handleFiles(e.dataTransfer.files);
            });

            dropZone.addEventListener('click', () => {
                fileInput.click();
            });

            fileInput.addEventListener('change', (e) => {
                this.handleFiles(e.target.files);
            });
        }

        initializeResizeControls() {
            const customSizeRadio = document.getElementById('custom-size');
            const originalSizeRadio = document.getElementById('original-size');
            const customSizeControls = document.querySelector('.custom-size-controls');
            const maintainAspectRatio = document.getElementById('maintain-aspect-ratio');
            const widthInput = document.getElementById('custom-width');
            const heightInput = document.getElementById('custom-height');
            const resizeSelected = document.getElementById('resize-selected');

            // Skip initialization if elements don't exist
            if (!customSizeRadio || !originalSizeRadio || !customSizeControls) {
                return;
            }

            // Toggle custom size controls visibility
            [customSizeRadio, originalSizeRadio].forEach(radio => {
                radio.addEventListener('change', () => {
                    customSizeControls.style.display = customSizeRadio.checked ? 'block' : 'none';
                });
            });

            // Initialize MDC components
            document.querySelectorAll('.mdc-text-field').forEach(textField => {
                new mdc.textField.MDCTextField(textField);
            });

            if (widthInput && heightInput && maintainAspectRatio) {
                let aspectRatio = null;
                let isUpdating = false;

                function updateDimension(changedInput, otherInput) {
                    if (!maintainAspectRatio.checked || !aspectRatio || isUpdating) return;
                    
                    isUpdating = true;
                    const newValue = parseInt(changedInput.value);
                    if (newValue && aspectRatio) {
                        if (changedInput === widthInput) {
                            otherInput.value = Math.round(newValue / aspectRatio);
                        } else {
                            otherInput.value = Math.round(newValue * aspectRatio);
                        }
                    }
                    isUpdating = false;
                }

                widthInput.addEventListener('input', () => updateDimension(widthInput, heightInput));
                heightInput.addEventListener('input', () => updateDimension(heightInput, widthInput));

                // Update aspect ratio when image loads
                document.querySelectorAll('.preview-image').forEach(img => {
                    img.addEventListener('load', () => {
                        aspectRatio = img.naturalWidth / img.naturalHeight;
                    });
                });
            }

            // Handle preset buttons
            document.querySelectorAll('.preset-buttons .mdc-button').forEach(button => {
                new mdc.ripple.MDCRipple(button);
                
                button.addEventListener('click', () => {
                    const width = button.dataset.width;
                    const height = button.dataset.height;
                    
                    if (widthInput && heightInput) {
                        widthInput.value = width;
                        heightInput.value = height;
                    }
                    
                    if (originalSizeRadio.checked) {
                        customSizeRadio.checked = true;
                        customSizeControls.style.display = 'block';
                    }
                });
            });

            // Initialize resize selected button
            if (resizeSelected) {
                resizeSelected.addEventListener('click', () => this.resizeSelectedFiles());
            }
        }

        initializeBatchControls() {
            const selectAll = document.getElementById('select-all');
            const compressSelected = document.getElementById('compress-selected');
            const downloadSelected = document.getElementById('download-selected');
            const resizeSelected = document.getElementById('resize-selected');
        
            selectAll.addEventListener('change', (e) => {
                const checkboxes = document.querySelectorAll('.image-select');
                checkboxes.forEach(checkbox => {
                    checkbox.checked = e.target.checked;
                    this.updateFileSelection(checkbox);
                });
                this.updateBatchButtons();
                this.updateSelectionCount();
            });
        
            compressSelected.addEventListener('click', () => this.compressSelectedFiles());
            downloadSelected.addEventListener('click', () => this.downloadSelectedFiles());
            if (resizeSelected) {
                resizeSelected.addEventListener('click', () => this.resizeSelectedFiles());
            }
        }

        // Helper method to get file for tile
        getFileForTile(tile) {
            const filename = tile.dataset.originalFile;
            const fileInput = document.getElementById('file-input');
            return Array.from(fileInput.files).find(f => f.name === filename);
        }

        handleFiles(files) {
            if (files.length > 0) {
                this.previewArea.classList.remove('hidden');
            }
            
            Array.from(files).forEach(file => {
                if (file.type.startsWith('image/')) {
                    this.createImageTile(file);
                }
            });
            
            this.batchProcessor.updateCounters();
        }

        createImageTile(file) {
            const tile = document.importNode(this.template.content, true);
            const container = tile.querySelector('.preview-tile');
            
            // Store the original file reference
            container.dataset.originalFile = file.name;
        
            // Set up image preview and basic info
            const img = new Image(); 
            img.onload = () => {
                // Update the preview image
                const previewImg = container.querySelector('.preview-image');
                previewImg.src = img.src;
                
                // Calculate aspect ratio
                const aspectRatio = (img.naturalWidth / img.naturalHeight).toFixed(2);
                
                // Update dimensions and aspect ratio
                container.querySelector('.dimensions').textContent = 
                    `${img.naturalWidth} × ${img.naturalHeight}px`;
                container.querySelector('.aspect-ratio').textContent = aspectRatio;
                
                // Cleanup
                URL.revokeObjectURL(img.src);
            };
            
            // Set the source after defining onload
            img.src = URL.createObjectURL(file);
            
            // Set other info
            container.querySelector('.filename').textContent = file.name;
            container.querySelector('.file-size').textContent = this.formatFileSize(file.size);
        
            // Add to document
            document.querySelector('.preview-grid').appendChild(tile);
        
            // Get the actually appended container
            const appendedContainer = document.querySelector(`[data-original-file="${file.name}"]`);
        
            // Setup event listeners
            this.setupTileControls(appendedContainer, file);
        
            // Initialize MDC components
            this.initializeMDCComponents(appendedContainer);
        }

        setupTileControls(tile, file) {
            // The tile passed in is already the preview-tile container
            const container = tile;  // tile is already the .preview-tile element
            
            // Compress button
            const compressButton = container.querySelector('.compress-button');
            if (compressButton) {
                compressButton.addEventListener('click', () => this.compressImage(container, file));
            }
        
            // Resize button
            const resizeButton = container.querySelector('.resize-button');
            if (resizeButton) {
                resizeButton.addEventListener('click', () => this.resizeImage(container, file));
            }
        
            // Selection checkbox
            const checkbox = container.querySelector('.image-select');
            if (checkbox) {
                checkbox.addEventListener('change', () => {
                    this.updateFileSelection(checkbox);
                    this.updateBatchButtons();
                    this.updateSelectionCount();
                });
            }
        
            // Download button
            const downloadButton = container.querySelector('.download-button');
            if (downloadButton) {
                downloadButton.addEventListener('click', () => this.downloadCompressedFile(container));
            }
        }

        updateProcessingStatus(container, type) {
            const statusIndicator = container.querySelector(`.status-indicator.${type}`);
            statusIndicator.classList.remove('hidden');
            setTimeout(() => {
                statusIndicator.classList.add('show');
            }, 50);
        }

        async compressImage(container, file) {
            const progressBar = container.querySelector('.compression-progress');
            const compressButton = container.querySelector('.compress-button');
            const downloadButton = container.querySelector('.download-button');
        
            try {
                progressBar.classList.remove('hidden');
                compressButton.disabled = true;
                loadingManager.show();
        
                const formData = new FormData();
                formData.append('file', file);
                
                // Get settings from the settings manager
                const settings = this.settingsManager.getSettings();
                formData.append('mode', settings.compression.mode);
        
                const response = await fetch('/compress', {
                    method: 'POST',
                    body: formData
                });
        
                const result = await response.json();
        
                if (response.ok) {
                    // Store the compressed data
                    container.setAttribute('data-compressed-data', result.compressed_data);
                    container.setAttribute('data-compressed-filename', result.filename);
                    
                    // Enable download button
                    downloadButton.disabled = false;
                    
                    // Debug log
                    console.log('Stored compressed data (first 50 chars):', result.compressed_data.substring(0, 50));
                    console.log('Stored filename:', result.filename);
        
                    this.updateProcessingStatus(container, 'compressed');
            
                    const processedInfo = container.querySelector('.processed-info');
                    processedInfo.classList.remove('hidden');
            
                    // Update final information
                    const finalWidth = result.metadata.final_dimensions[0];
                    const finalHeight = result.metadata.final_dimensions[1];
                    const finalAspectRatio = (finalWidth / finalHeight).toFixed(2);
            
                    container.querySelector('.final-size').textContent = 
                        this.formatFileSize(result.metadata.compressed_size);
                    container.querySelector('.final-dimensions').textContent = 
                        `${finalWidth} × ${finalHeight}px`;
                    container.querySelector('.final-aspect-ratio').textContent = finalAspectRatio;
                    
                    const savings = Math.round((1 - result.metadata.compressed_size / result.metadata.original_size) * 100);
                    container.querySelector('.space-saved').textContent = `${savings}%`;
                    
                    if (result.warnings && result.warnings.length > 0) {
                        this.showWarnings(container, result.warnings);
                    }
                } else {
                    throw new Error(result.error || 'Compression failed');
                }
            } catch (error) {
                console.error('Compression error:', error);
                this.showError(container, error.message);
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
                
                // Get settings from the settings manager
                const settings = this.settingsManager.getSettings();
                if (settings.resize.mode === 'custom') {
                    if (settings.resize.width) formData.append('max_width', settings.resize.width);
                    if (settings.resize.height) formData.append('max_height', settings.resize.height);
                }
        
                const response = await fetch('/resize', {
                    method: 'POST',
                    body: formData
                });
        
                const result = await response.json();
        
                if (response.ok) {
                    // Store the compressed data - note we now use compressed_data consistently
                    container.setAttribute('data-compressed-data', result.compressed_data);
                    container.setAttribute('data-compressed-filename', result.filename);
                    
                    // Enable download button
                    downloadButton.disabled = false;
                    
                    // Debug log
                    console.log('Stored resized data (first 50 chars):', result.compressed_data.substring(0, 50));
                    console.log('Stored filename:', result.filename);
        
                    this.updateProcessingStatus(container, 'resized');
        
                    const processedInfo = container.querySelector('.processed-info');
                    processedInfo.classList.remove('hidden');
        
                    // Update final information
                    const finalWidth = result.metadata.final_dimensions[0];
                    const finalHeight = result.metadata.final_dimensions[1];
                    const finalAspectRatio = (finalWidth / finalHeight).toFixed(2);
        
                    container.querySelector('.final-size').textContent = 
                        this.formatFileSize(result.metadata.compressed_size);
                    container.querySelector('.final-dimensions').textContent = 
                        `${finalWidth} × ${finalHeight}px`;
                    container.querySelector('.final-aspect-ratio').textContent = finalAspectRatio;
                    
                    const savings = Math.round((1 - result.metadata.compressed_size / result.metadata.original_size) * 100);
                    container.querySelector('.space-saved').textContent = `${savings}%`;
        
                    downloadButton.disabled = false;
        
                    if (result.warnings && result.warnings.length > 0) {
                        this.showWarnings(container, result.warnings);
                    }
                } else {
                    throw new Error(result.error || 'Resize failed');
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

        async resizeSelectedFiles() {
            const selectedTiles = Array.from(document.querySelectorAll('.preview-tile'))
                .filter(tile => tile.querySelector('.image-select').checked);
                
            const items = selectedTiles.map(tile => ({
                tile,
                file: this.getFileForTile(tile),
                type: 'resize'
            }));
            
            this.batchProcessor.addToQueue(items);
            await this.batchProcessor.processQueue(async (item) => {
                await this.resizeImage(item.tile, item.file);
            });
        }

        async compressSelectedFiles() {
            const selectedTiles = Array.from(document.querySelectorAll('.preview-tile'))
                .filter(tile => tile.querySelector('.image-select').checked);
                
            const items = selectedTiles.map(tile => ({
                tile,
                file: this.getFileForTile(tile),
                type: 'compress'
            }));
            
            this.batchProcessor.addToQueue(items);
            await this.batchProcessor.processQueue(async (item) => {
                await this.compressImage(item.tile, item.file);
            });
        }

        async downloadSelectedFiles() {
            const selectedTiles = Array.from(document.querySelectorAll('.preview-tile'))
                .filter(tile => tile.querySelector('.image-select').checked);
        
            if (selectedTiles.length === 1) {
                this.downloadCompressedFile(selectedTiles[0]);
            } else if (selectedTiles.length > 1) {
                const zip = new JSZip();
                
                for (const tile of selectedTiles) {
                    const compressedData = tile.getAttribute('data-compressed-data');
                    const filename = tile.getAttribute('data-compressed-filename');
                    
                    if (compressedData && filename) {
                        // Convert hex string to binary data
                        const binaryData = new Uint8Array(
                            compressedData.match(/.{1,2}/g)
                            .map(byte => parseInt(byte, 16))
                        );
                        zip.file(filename, binaryData);
                    }
                }
        
                try {
                    loadingManager.show();
                    const content = await zip.generateAsync({
                        type: 'blob',
                        compression: 'DEFLATE',
                        compressionOptions: {
                            level: 9
                        }
                    });
                    
                    const url = URL.createObjectURL(content);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'compressed_images.zip';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    loadingManager.hide();
                } catch (error) {
                    console.error('Error creating zip file:', error);
                    // Show error to user
                    alert('Failed to create zip file. Please try again.');
                }
            }
        }

        async downloadCompressedFile(container) {
            try {
                const compressedData = container.getAttribute('data-compressed-data');
                const filename = container.getAttribute('data-compressed-filename');
                
                // Debug log
                console.log('Downloading - compressed data first 50 chars:', compressedData?.substring(0, 50));
                console.log('Downloading - filename:', filename);
        
                if (!compressedData || !filename) {
                    throw new Error('Missing compressed data or filename');
                }
        
                const response = await fetch('/download', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        compressed_data: compressedData,
                        filename: filename
                    })
                });
                
                if (response.ok) {
                    const blob = await response.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `compressed_${filename}`;
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
            const compressSelected = document.getElementById('compress-selected');
            const downloadSelected = document.getElementById('download-selected');
            const resizeSelected = document.getElementById('resize-selected');
            const hasSelection = this.selectedFiles.size > 0;
            
            if (compressSelected) compressSelected.disabled = !hasSelection;
            if (downloadSelected) downloadSelected.disabled = !hasSelection;
            if (resizeSelected) resizeSelected.disabled = !hasSelection;
        }

        updateSelectionCount() {
            const count = this.selectedFiles.size;
            const selectedFiles = document.getElementById('selected-files-count');
            if (selectedFiles) {
                selectedFiles.textContent = count;
            }
            this.updateBatchButtons();
        }

        showWarnings(container, warnings) {
            const existingWarnings = container.querySelector('.warning-message');
            if (existingWarnings) {
                existingWarnings.remove();
            }

            const warningDiv = document.createElement('div');
            warningDiv.className = 'warning-message';
            warningDiv.innerHTML = warnings.map(warning => `
                <div class="mdc-chip">
                    <i class="material-icons mdc-chip__icon mdc-chip__icon--leading">warning</i>
                    <span class="mdc-chip__text">${warning}</span>
                </div>
            `).join('');

            container.appendChild(warningDiv);
        }

        showError(container, message) {
            const existingError = container.querySelector('.error-message');
            if (existingError) {
                existingError.remove();
            }

            const errorDiv = document.createElement('div');
            errorDiv.className = 'error-message';
            errorDiv.innerHTML = `
                <div class="mdc-chip error-chip">
                    <i class="material-icons mdc-chip__icon mdc-chip__icon--leading">error</i>
                    <span class="mdc-chip__text">${message}</span>
                </div>
            `;

            container.appendChild(errorDiv);
            setTimeout(() => {
                const currentError = container.querySelector('.error-message');
                if (currentError) {
                    currentError.remove();
                }
            }, 5000);
        }

        formatFileSize(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        initializeMDCComponents(tile) {
            tile.querySelectorAll('.mdc-checkbox').forEach(el => new mdc.checkbox.MDCCheckbox(el));
            tile.querySelectorAll('.mdc-button').forEach(el => new mdc.ripple.MDCRipple(el));
            tile.querySelectorAll('.mdc-linear-progress').forEach(el => new mdc.linearProgress.MDCLinearProgress(el));
            tile.querySelectorAll('.mdc-chip').forEach(el => new mdc.chips.MDCChip(el));
        }
    }

    // Only initialize compressor if we're on the main page
    if (document.querySelector('.app-layout')) {
        // Initialize the compressor
        new ImageCompressor();
    }

    // Initialize login form if we're on the login page
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        initializeLoginForm();
    }
});

// Theme management
function initializeTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    if (savedTheme) {
        document.documentElement.setAttribute('data-theme', savedTheme);
        updateThemeIcon(savedTheme);
    } else if (prefersDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
        updateThemeIcon('dark');
    }

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
        },
        body: JSON.stringify({ theme: newTheme })
    }).catch(error => console.error('Failed to sync theme with server:', error));
}

function updateThemeIcon(theme) {
    const themeIcon = document.getElementById('theme-toggle');
    themeIcon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
}

// Separate login form initialization
function initializeLoginForm() {
    const form = document.getElementById('login-form');
    
    // Initialize Material Components
    document.querySelectorAll('.mdc-text-field').forEach(element => {
        new mdc.textField.MDCTextField(element);
    });
    
    document.querySelectorAll('.mdc-button').forEach(element => {
        new mdc.ripple.MDCRipple(element);
    });

    form.addEventListener('submit', function(e) {
        e.preventDefault();
        
        fetch(this.action, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(new FormData(this)),
            credentials: 'same-origin'
        })
        .then(response => {
            if (response.redirected) {
                window.location.href = response.url;
            } else {
                return response.text();
            }
        })
        .then(html => {
            if (html) {
                document.documentElement.innerHTML = html;
                // Reinitialize Material Components after DOM update
                document.querySelectorAll('.mdc-text-field').forEach(element => {
                    new mdc.textField.MDCTextField(element);
                });
                document.querySelectorAll('.mdc-button').forEach(element => {
                    new mdc.ripple.MDCRipple(element);
                });
            }
        })
        .catch(error => {
            console.error('Error:', error);
        });
    });
}