document.addEventListener('DOMContentLoaded', function() {
    class ImageCompressor {
        constructor() {
            this.selectedFiles = new Set();
            this.template = document.getElementById('image-tile-template');
            this.previewArea = document.getElementById('preview-area');
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

        initializeBatchControls() {
            const selectAll = document.getElementById('select-all');
            const compressSelected = document.getElementById('compress-selected');
            const downloadSelected = document.getElementById('download-selected');

            selectAll.addEventListener('change', (e) => {
                const checkboxes = document.querySelectorAll('.image-select');
                checkboxes.forEach(checkbox => {
                    checkbox.checked = e.target.checked;
                    this.updateFileSelection(checkbox);
                });
                this.updateBatchButtons();
            });

            compressSelected.addEventListener('click', () => this.compressSelectedFiles());
            downloadSelected.addEventListener('click', () => this.downloadSelectedFiles());
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
        }

        createImageTile(file) {
            const tile = document.importNode(this.template.content, true);
            const container = tile.querySelector('.preview-tile');
            
            // Store the original file reference
            container.dataset.originalFile = file.name;

            // Set up image preview and basic info
            const img = tile.querySelector('.preview-image');
            img.src = URL.createObjectURL(file);
            tile.querySelector('.filename').textContent = file.name;
            tile.querySelector('.file-size').textContent = this.formatFileSize(file.size);

            // Set dimensions when image loads
            img.onload = () => {
                tile.querySelector('.dimensions').textContent = 
                    `${img.naturalWidth} × ${img.naturalHeight}px`;
            };

            // Setup event listeners
            this.setupTileControls(tile, file);
            document.querySelector('.preview-grid').appendChild(tile);

            // Initialize MDC components
            this.initializeMDCComponents(tile);
        }

        setupTileControls(tile, file) {
            const container = tile.querySelector('.preview-tile');
            
            // Compress button
            const compressButton = container.querySelector('.compress-button');
            compressButton.addEventListener('click', () => this.compressImage(container, file));

            // Selection checkbox
            const checkbox = container.querySelector('.image-select');
            checkbox.addEventListener('change', () => {
                this.updateFileSelection(checkbox);
                this.updateBatchButtons();
                this.updateSelectionCount();
            });

            // Download button
            const downloadButton = container.querySelector('.download-button');
            downloadButton.addEventListener('click', () => this.downloadCompressedFile(container));
        }

        async compressImage(container, file) {
            const progressBar = container.querySelector('.compression-progress');
            const compressButton = container.querySelector('.compress-button');
            const downloadButton = container.querySelector('.download-button');
            const compressedInfo = container.querySelector('.compressed-info');

            try {
                progressBar.classList.remove('hidden');
                compressButton.disabled = true;

                const formData = new FormData();
                formData.append('file', file);
                
                // Get the global compression mode
                const compressionMode = document.querySelector('input[name="compression-type"]:checked').value;
                formData.append('mode', compressionMode);

                const response = await fetch('/compress', {
                    method: 'POST',
                    body: formData
                });

                const result = await response.json();

                if (response.ok) {
                    // Store compressed data
                    container.dataset.compressedData = result.compressed_data;
                    container.dataset.compressedFilename = result.filename;

                    // Update compressed information
                    container.querySelector('.compressed-size').textContent = 
                        this.formatFileSize(result.metadata.compressed_size);
                    
                    const savings = Math.round((1 - result.metadata.compressed_size / result.metadata.original_size) * 100);
                    container.querySelector('.space-saved').textContent = `${savings}%`;
                    
                    compressedInfo.classList.remove('hidden');
                    downloadButton.disabled = false;

                    if (result.warnings && result.warnings.length > 0) {
                        this.showWarnings(container, result.warnings);
                    }
                } else {
                    throw new Error(result.error || 'Compression failed');
                }
            } catch (error) {
                this.showError(container, error.message);
            } finally {
                progressBar.classList.add('hidden');
                compressButton.disabled = false;
            }
        }

        async compressSelectedFiles() {
            const selectedTiles = Array.from(document.querySelectorAll('.preview-tile'))
                .filter(tile => tile.querySelector('.image-select').checked);

            for (const tile of selectedTiles) {
                const filename = tile.dataset.originalFile;
                const fileInput = document.getElementById('file-input');
                const file = Array.from(fileInput.files).find(f => f.name === filename);
                if (file) {
                    await this.compressImage(tile, file);
                }
            }
        }

        async downloadSelectedFiles() {
            const selectedTiles = Array.from(document.querySelectorAll('.preview-tile'))
                .filter(tile => tile.querySelector('.image-select').checked);

            if (selectedTiles.length === 1) {
                this.downloadCompressedFile(selectedTiles[0]);
            } else if (selectedTiles.length > 1) {
                const zip = new JSZip();
                
                for (const tile of selectedTiles) {
                    if (tile.dataset.compressedData) {
                        const filename = tile.dataset.compressedFilename;
                        zip.file(filename, tile.dataset.compressedData, {base64: true});
                    }
                }

                const content = await zip.generateAsync({type: 'blob'});
                const url = URL.createObjectURL(content);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'compressed_images.zip';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }
        }

        async downloadCompressedFile(container) {
            try {
                const response = await fetch('/download', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        compressed_data: container.dataset.compressedData,
                        filename: container.dataset.compressedFilename
                    })
                });
                
                if (response.ok) {
                    const blob = await response.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `compressed_${container.dataset.compressedFilename}`;
                    document.body.appendChild(a);
                    a.click();
                    window.URL.revokeObjectURL(url);
                    document.body.removeChild(a);
                } else {
                    throw new Error('Download failed');
                }
            } catch (error) {
                this.showError(container, 'Failed to download the compressed image');
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
            const hasSelection = this.selectedFiles.size > 0;
            
            compressSelected.disabled = !hasSelection;
            downloadSelected.disabled = !hasSelection;
        }

        updateSelectionCount() {
            const count = this.selectedFiles.size;
            const countElement = document.querySelector('.selection-count');
            if (countElement) {
                countElement.textContent = count > 0 ? `${count} image${count > 1 ? 's' : ''} selected` : '';
            }
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
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error-message';
            errorDiv.innerHTML = `
                <div class="mdc-chip error-chip">
                    <i class="material-icons mdc-chip__icon mdc-chip__icon--leading">error</i>
                    <span class="mdc-chip__text">${message}</span>
                </div>
            `;

            container.appendChild(errorDiv);
            setTimeout(() => errorDiv.remove(), 5000);
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
        }
    }

    // Initialize theme toggle
    initializeTheme();

    // Initialize the compressor
    new ImageCompressor();
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