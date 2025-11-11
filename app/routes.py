from flask import Blueprint, render_template, request, jsonify, send_file, current_app, redirect, url_for, session
import io
from PIL import Image
from werkzeug.utils import secure_filename
from .compression import ImageCompressor
from .auth import RateLimitExceeded
from .validators import (
    validate_file, validate_compression_mode, validate_resize_mode,
    validate_dimensions, validate_quality, validate_boolean_param,
    validate_theme, validate_download_data, sanitize_filename
)
from .forms import LoginForm

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

@main.route('/login', methods=['GET', 'POST'])
def login():
    form = LoginForm()

    if form.validate_on_submit():
        try:
            password = form.password.data
            current_app.logger.debug(f"Login attempt received")
            current_app.logger.debug(f"Session before login: {dict(session)}")

            if current_app.auth.login(password):
                current_app.logger.info("Login successful")
                current_app.logger.debug(f"Session after login: {dict(session)}")
                return redirect(url_for('main.index'))

            current_app.logger.warning("Invalid password attempt")
            return render_template('login.html', form=form, error='Invalid password')

        except RateLimitExceeded as e:
            current_app.logger.warning(f"Rate limit exceeded: {str(e)}")
            return render_template('login.html', form=form, error=str(e))
        except Exception as e:
            current_app.logger.error(f"Login error: {str(e)}")
            current_app.logger.exception("Full traceback:")
            return render_template('login.html', form=form, error='An error occurred. Please try again.')

    # For GET requests or invalid form submission
    if request.method == 'POST' and not form.validate_on_submit():
        # Form validation failed
        if form.errors:
            current_app.logger.warning(f"Form validation errors: {form.errors}")
            error_messages = []
            for field, errors in form.errors.items():
                for error in errors:
                    error_messages.append(error)
            return render_template('login.html', form=form, error=', '.join(error_messages))

    return render_template('login.html', form=form)

@main.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('main.login'))

@main.route('/')
@current_app.auth.login_required
def index():
    return render_template('index.html')

@main.route('/process', methods=['POST'])
@current_app.auth.login_required
def process_image():
    # Validate file
    file = request.files.get('file')
    is_valid, error_msg = validate_file(file)
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    # Get processing parameters
    compression_mode = request.form.get('compression_mode', 'lossless')
    resize_mode = request.form.get('resize_mode', 'original')
    max_width = request.form.get('max_width', type=int)
    max_height = request.form.get('max_height', type=int)
    quality = request.form.get('quality', type=int)
    use_webp_str = request.form.get('use_webp', 'false')

    # Validate compression mode
    is_valid, error_msg = validate_compression_mode(compression_mode)
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    # Validate resize mode
    is_valid, error_msg = validate_resize_mode(resize_mode)
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    # Validate dimensions
    is_valid, error_msg = validate_dimensions(max_width, max_height)
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    # Validate quality
    is_valid, error_msg = validate_quality(quality)
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    # Validate boolean parameter
    is_valid, error_msg = validate_boolean_param(use_webp_str)
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    use_webp = use_webp_str.lower() == 'true'

    try:
        # Read the uploaded file
        image_data = file.read()

        # Validate the image (now returns opened image)
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

        # Process the image using pre-opened image (OPTIMIZATION: avoid reopening)
        compressed_data, metadata = compressor.compress_image(
            image_data,
            compression_mode,
            max_width if resize_mode == 'custom' else None,
            max_height if resize_mode == 'custom' else None,
            quality,
            use_webp,
            preloaded_image=validation.image
        )

        # Convert to hex (OPTIMIZATION: removed redundant validation)
        hex_data = compressed_data.hex()

        # Sanitize filename and update extension based on format
        filename = sanitize_filename(file.filename)
        base_name = filename.rsplit('.', 1)[0]
        extension = '.webp' if use_webp else '.jpg'
        new_filename = base_name + extension

        return jsonify({
            'message': 'File processed successfully',
            'metadata': {
                **metadata,
                'encoding': 'hex'
            },
            'compressed_data': hex_data,
            'filename': new_filename,
            'warnings': validation.warnings
        }), 200

    except Exception as e:
        current_app.logger.error(f"Processing failed: {str(e)}")
        return jsonify({'error': str(e)}), 500

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

            # Validate the image (now returns opened image)
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

            # Compress the image using pre-opened image (OPTIMIZATION: avoid reopening)
            compressed_data, metadata = compressor.compress_image(
                image_data,
                compression_mode,
                max_width,
                max_height,
                quality,
                preloaded_image=validation.image
            )

            # Convert to hex (OPTIMIZATION: removed redundant validation)
            hex_data = compressed_data.hex()
                
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
        if not data:
            return jsonify({'error': 'No data provided'}), 400

        compressed_data_str = data.get('compressed_data', '')
        filename = data.get('filename', '')

        # Validate download data
        is_valid, error_msg = validate_download_data(compressed_data_str, filename)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        # Log the first few characters of the compressed data for debugging
        current_app.logger.debug(f"First 50 chars of compressed data: {compressed_data_str[:50]}")

        try:
            # Convert hex string back to bytes
            compressed_data = bytes.fromhex(compressed_data_str)
        except ValueError as hex_error:
            current_app.logger.error(f"Hex conversion failed: {str(hex_error)}")
            return jsonify({'error': 'Invalid data encoding'}), 400

        # Sanitize filename
        filename = sanitize_filename(filename)
        
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

            # Validate the image (now returns opened image)
            validation = compressor.validate_image(image_data)
            if not validation.is_valid:
                return jsonify({
                    'error': 'Image validation failed',
                    'details': validation.errors,
                    'warnings': validation.warnings
                }), 400

            # Process image using pre-opened image (OPTIMIZATION: avoid reopening)
            compressed_data, metadata = compressor.compress_image(
                image_data,
                'lossless',
                max_width,
                max_height,
                preloaded_image=validation.image
            )

            # Convert to hex (OPTIMIZATION: removed redundant validation)
            hex_data = compressed_data.hex()
                
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
    data = request.json
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    theme = data.get('theme', '')

    # Validate theme
    is_valid, error_msg = validate_theme(theme)
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    return jsonify({'theme': theme})

@main.route('/test-session')
def test_session():
    session['test'] = 'test value'
    current_app.logger.debug(f"Session contents: {dict(session)}")
    return jsonify({
        'session': dict(session),
        'authenticated': session.get('authenticated', False)
    })