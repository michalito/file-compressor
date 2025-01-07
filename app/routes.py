from flask import Blueprint, render_template, request, jsonify, send_file, current_app, redirect, url_for, session
import io
from PIL import Image
from werkzeug.utils import secure_filename
from .compression import ImageCompressor
from .auth import RateLimitExceeded

main = Blueprint('main', __name__)

# Initialize with 50MB limit
compressor = ImageCompressor(max_file_size_mb=50)

# MIME type mapping
MIME_TYPES = {
    'JPEG': 'image/jpeg',
    'PNG': 'image/png',
    'WEBP': 'image/webp',
    'TIFF': 'image/tiff'
}

def validate_hex_output(hex_string: str) -> bool:
    """Validate that a string is valid hexadecimal"""
    try:
        # Try to convert back to bytes to validate
        bytes.fromhex(hex_string)
        return True
    except ValueError:
        return False

@main.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        try:
            if current_app.auth.login(request.form.get('password', '')):
                return redirect(url_for('main.index'))
            return render_template('login.html', error='Invalid password')
        except RateLimitExceeded as e:
            return render_template('login.html', error=str(e))
    return render_template('login.html')

@main.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('main.login'))

@main.route('/')
@current_app.auth.login_required
def index():
    return render_template('index.html')

@main.route('/compress', methods=['POST'])
@current_app.auth.login_required
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
            
            # Convert to hex and validate
            hex_data = compressed_data.hex()
            if not validate_hex_output(hex_data):
                raise ValueError("Invalid hex output generated")
                
            return jsonify({
                'message': 'File processed successfully',
                'metadata': {
                    **metadata,
                    'encoding': 'hex'
                },
                'compressed_data': hex_data,
                'filename': secure_filename(file.filename),
                'warnings': validation.warnings
            }), 200
        
        except Exception as e:
            current_app.logger.error(f"Compression failed: {str(e)}")
            return jsonify({'error': str(e)}), 500
        
    return jsonify({'error': 'Invalid file type'}), 400

@main.route('/download', methods=['POST'])
@current_app.auth.login_required
def download_file():
    """Handle download of compressed images directly from memory"""
    try:
        data = request.json
        if not data or 'compressed_data' not in data or 'filename' not in data:
            current_app.logger.error("Invalid request data structure")
            return jsonify({'error': 'Invalid request data'}), 400
            
        # Log the first few characters of the compressed data for debugging
        compressed_data_str = data['compressed_data']
        current_app.logger.debug(f"First 50 chars of compressed data: {compressed_data_str[:50]}")
        
        try:
            # Convert hex string back to bytes
            compressed_data = bytes.fromhex(compressed_data_str)
        except ValueError as hex_error:
            current_app.logger.error(f"Hex conversion failed: {str(hex_error)}")
            current_app.logger.error(f"Data type: {type(compressed_data_str)}")
            return jsonify({'error': 'Invalid data encoding'}), 400
            
        filename = secure_filename(data['filename'])
        
        # Determine the mime type from the file extension
        file_ext = filename.rsplit('.', 1)[-1].upper()
        if file_ext == 'JPG':
            file_ext = 'JPEG'
        mime_type = MIME_TYPES.get(file_ext, 'application/octet-stream')
        
        # Create in-memory file
        file_obj = io.BytesIO(compressed_data)
        file_obj.seek(0)
        
        # Send file directly from memory with correct mime type
        return send_file(
            file_obj,
            as_attachment=True,
            download_name=f"compressed_{filename}",
            mimetype=mime_type
        )
        
    except Exception as e:
        current_app.logger.error(f"Download failed: {str(e)}")
        return jsonify({'error': 'Download failed'}), 500

@main.route('/resize', methods=['POST'])
@current_app.auth.login_required
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

            # Process image
            compressed_data, metadata = compressor.compress_image(
                image_data,
                'lossless',
                max_width,
                max_height
            )
            
            # Convert to hex and validate
            hex_data = compressed_data.hex()
            if not validate_hex_output(hex_data):
                raise ValueError("Invalid hex output generated")
                
            return jsonify({
                'message': 'File processed successfully',
                'metadata': {
                    **metadata,
                    'encoding': 'hex'
                },
                'compressed_data': hex_data,
                'filename': secure_filename(file.filename),
                'warnings': validation.warnings
            }), 200
            
        except Exception as e:
            current_app.logger.error(f"Resize failed: {str(e)}")
            return jsonify({'error': str(e)}), 500
        
    return jsonify({'error': 'Invalid file type'}), 400

@main.route('/theme', methods=['POST'])
@current_app.auth.login_required
def toggle_theme():
    theme = request.json.get('theme')
    if theme not in ['light', 'dark']:
        return jsonify({'error': 'Invalid theme'}), 400
    return jsonify({'theme': theme})