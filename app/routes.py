from flask import Blueprint, render_template, request, jsonify, send_file, current_app
import io
from PIL import Image
from werkzeug.utils import secure_filename
from .compression import ImageCompressor

main = Blueprint('main', __name__)

# Initialize with 10MB limit
compressor = ImageCompressor(max_file_size_mb=50)

@main.route('/')
def index():
    return render_template('index.html')

@main.route('/compress', methods=['POST'])
def compress_image():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
        
    if file and file.filename.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.tiff')):
        # Get compression parameters
        compression_mode = request.form.get('mode', 'lossless')
        max_width = request.form.get('max_width', type=int)
        max_height = request.form.get('max_height', type=int)
        quality = request.form.get('quality', type=int)
        
        try:
            # Read the uploaded file
            image_data = file.read()
            
            # Validate the image
            validation = compressor.validate_image(image_data)
            if not validation.is_valid:
                return jsonify({
                    'error': 'Image validation failed',
                    'details': validation.errors,
                    'warnings': validation.warnings
                }), 400
            
            # Process warnings
            if validation.warnings:
                current_app.logger.warning(f"Image processing warnings for {file.filename}: {validation.warnings}")
            
            # Compress the image
            compressed_data, metadata = compressor.compress_image(
                image_data,
                compression_mode,
                max_width,
                max_height,
                quality
            )
            
            # Return compressed data directly with metadata
            return jsonify({
                'message': 'File processed successfully',
                'metadata': metadata,
                'compressed_data': compressed_data.hex(),  # Convert bytes to hex string for JSON
                'filename': secure_filename(file.filename),
                'warnings': validation.warnings
            }), 200
            
        except Exception as e:
            return jsonify({'error': str(e)}), 500
        
    return jsonify({'error': 'Invalid file type'}), 400

@main.route('/download', methods=['POST'])
def download_file():
    """Handle download of compressed images directly from memory"""
    try:
        data = request.json
        if not data or 'compressed_data' not in data or 'filename' not in data:
            return jsonify({'error': 'Invalid request data'}), 400
            
        # Convert hex string back to bytes
        compressed_data = bytes.fromhex(data['compressed_data'])
        filename = secure_filename(data['filename'])
        
        # Create in-memory file
        file_obj = io.BytesIO(compressed_data)
        file_obj.seek(0)
        
        # Send file directly from memory
        return send_file(
            file_obj,
            as_attachment=True,
            download_name=f"compressed_{filename}",
            mimetype='image/jpeg'  # Adjust based on actual file type
        )
        
    except Exception as e:
        current_app.logger.error(f"Download failed: {str(e)}")
        return jsonify({'error': 'Download failed'}), 500

@main.route('/resize', methods=['POST'])
def resize_image():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
        
    if file and file.filename.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.tiff')):
        try:
            # Read the uploaded file
            image_data = file.read()
            
            # Get resize parameters
            max_width = request.form.get('max_width', type=int)
            max_height = request.form.get('max_height', type=int)
            
            # Validate the image
            validation = compressor.validate_image(image_data)
            if not validation.is_valid:
                return jsonify({
                    'error': 'Image validation failed',
                    'details': validation.errors,
                    'warnings': validation.warnings
                }), 400

            # Use the compressor's methods to handle the resize
            compressed_data, metadata = compressor.compress_image(
                image_data,
                'lossless',
                max_width,
                max_height
            )
            
            # Ensure metadata has all required fields
            metadata.update({
                'original_size': len(image_data),
                'compressed_size': len(compressed_data)
            })
            
            return jsonify({
                'message': 'File resized successfully',
                'resized_data': compressed_data.hex(),
                'filename': secure_filename(file.filename),
                'metadata': metadata,
                'warnings': validation.warnings
            }), 200
            
        except Exception as e:
            current_app.logger.error(f"Resize failed: {str(e)}")
            return jsonify({'error': str(e)}), 500
        
    return jsonify({'error': 'Invalid file type'}), 400

@main.route('/theme', methods=['POST'])
def toggle_theme():
    theme = request.json.get('theme')
    if theme not in ['light', 'dark']:
        return jsonify({'error': 'Invalid theme'}), 400
    return jsonify({'theme': theme})