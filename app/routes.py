import base64
import io

from flask import Blueprint, render_template, request, jsonify, send_file, current_app, redirect, url_for, session

from .compression import ImageCompressor, ImageValidationError
from .auth import RateLimitExceeded, login_required
from .validators import (
    validate_file, validate_compression_mode, validate_resize_mode,
    validate_dimensions, validate_quality, validate_output_format,
    validate_theme, validate_download_data, validate_crop_coordinates,
    validate_rotation, sanitize_filename,
    validate_watermark_text, validate_watermark_position, validate_watermark_options
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

# Extension mapping for output formats
FORMAT_EXTENSIONS = {
    'JPEG': '.jpg',
    'PNG': '.png',
    'WEBP': '.webp',
    'TIFF': '.tiff'
}


@main.route('/login', methods=['GET', 'POST'])
def login():
    form = LoginForm()

    if form.validate_on_submit():
        try:
            password = form.password.data

            if current_app.auth.login(password):
                return redirect(url_for('main.index'))

            return render_template('login.html', form=form, error='Invalid password')

        except RateLimitExceeded as e:
            current_app.logger.warning(f"Rate limit exceeded: {e}")
            return render_template('login.html', form=form, error=str(e))
        except Exception as e:
            current_app.logger.error(f"Login error: {e}")
            return render_template('login.html', form=form, error='An error occurred. Please try again.')

    # For GET requests or invalid form submission
    if request.method == 'POST' and not form.validate_on_submit():
        if form.errors:
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
@login_required
def index():
    return render_template('index.html')


def _process_image_file(file, compression_mode, resize_mode, max_width, max_height, quality, output_format,
                        watermark_text=None, watermark_position='bottom-right',
                        watermark_opacity=50, watermark_color='white', watermark_size=5,
                        watermark_tile_density=5, watermark_angle=0):
    """Validate, compress, encode, and build response for a single image file.

    Returns (response_dict, status_code) tuple.
    """
    image_data = file.read()

    validation = compressor.validate_image(image_data)
    if not validation.is_valid:
        return {
            'error': 'Image validation failed',
            'details': validation.errors,
            'warnings': validation.warnings
        }, 400

    if validation.warnings:
        current_app.logger.warning(f"Image warnings for {file.filename}: {validation.warnings}")

    compressed_data, metadata = compressor.compress_image(
        image_data,
        compression_mode,
        max_width if resize_mode == 'custom' else None,
        max_height if resize_mode == 'custom' else None,
        quality,
        output_format=output_format,
        preloaded_image=validation.image,
        watermark_text=watermark_text,
        watermark_position=watermark_position,
        watermark_opacity=watermark_opacity,
        watermark_color=watermark_color,
        watermark_size=watermark_size,
        watermark_tile_density=watermark_tile_density,
        watermark_angle=watermark_angle,
    )

    # Encode as base64
    b64_data = base64.b64encode(compressed_data).decode('ascii')

    # Derive extension from actual output format
    resolved_format = metadata.get('format', 'JPEG')
    extension = FORMAT_EXTENSIONS.get(resolved_format, '.jpg')

    filename = sanitize_filename(file.filename)
    base_name = filename.rsplit('.', 1)[0]
    new_filename = base_name + extension

    # Merge format warnings into the top-level warnings list
    warnings = list(validation.warnings)
    format_warnings = metadata.pop('format_warnings', [])
    warnings.extend(format_warnings)

    return {
        'message': 'File processed successfully',
        'metadata': {
            **metadata,
            'encoding': 'base64'
        },
        'compressed_data': b64_data,
        'filename': new_filename,
        'warnings': warnings
    }, 200


@main.route('/process', methods=['POST'])
@login_required
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
    output_format = request.form.get('output_format', 'auto')

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

    # Validate output format
    is_valid, error_msg = validate_output_format(output_format)
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    # Get watermark parameters (optional)
    watermark_text = request.form.get('watermark_text', '').strip() or None
    watermark_position = request.form.get('watermark_position', 'bottom-right')
    watermark_opacity = request.form.get('watermark_opacity', 50, type=int)
    watermark_color = request.form.get('watermark_color', 'white')
    watermark_size = request.form.get('watermark_size', 5, type=int)
    watermark_tile_density = request.form.get('watermark_tile_density', 5, type=int)
    watermark_angle = request.form.get('watermark_angle', 0, type=int)

    # Validate watermark params if text is provided
    if watermark_text:
        is_valid, error_msg = validate_watermark_text(watermark_text)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        is_valid, error_msg = validate_watermark_position(watermark_position)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        is_valid, error_msg = validate_watermark_options(watermark_opacity, watermark_size, watermark_color, watermark_tile_density, watermark_angle)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

    try:
        result, status = _process_image_file(
            file, compression_mode, resize_mode,
            max_width, max_height, quality, output_format,
            watermark_text=watermark_text,
            watermark_position=watermark_position,
            watermark_opacity=watermark_opacity,
            watermark_color=watermark_color,
            watermark_size=watermark_size,
            watermark_tile_density=watermark_tile_density,
            watermark_angle=watermark_angle,
        )
        return jsonify(result), status

    except Exception as e:
        current_app.logger.error(f"Processing failed: {e}")
        return jsonify({'error': 'Processing failed'}), 500


@main.route('/download', methods=['POST'])
@login_required
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

        try:
            compressed_data = base64.b64decode(compressed_data_str)
        except Exception:
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

        return send_file(
            file_obj,
            as_attachment=True,
            download_name=f"compressed_{filename}",
            mimetype=mime_type
        )

    except Exception as e:
        current_app.logger.error(f"Download failed: {e}")
        return jsonify({'error': 'Download failed'}), 500


@main.route('/crop', methods=['POST'])
@login_required
def crop_image():
    """Crop and/or rotate an already-processed image."""
    try:
        data = request.json
        if not data:
            return jsonify({'error': 'No data provided'}), 400

        compressed_data_str = data.get('compressed_data', '')
        filename = data.get('filename', '')
        crop = data.get('crop') or {}

        # Extract optional rotation (defaults to 0 for backward compatibility)
        try:
            rotation = int(data.get('rotation', 0))
        except (TypeError, ValueError):
            return jsonify({'error': 'Invalid rotation value'}), 400

        # Validate base64 data and filename
        is_valid, error_msg = validate_download_data(compressed_data_str, filename)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        # Validate rotation angle
        is_valid, error_msg = validate_rotation(rotation)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        # Extract crop coordinates
        try:
            crop_x = int(crop.get('x', -1))
            crop_y = int(crop.get('y', -1))
            crop_w = int(crop.get('width', 0))
            crop_h = int(crop.get('height', 0))
        except (TypeError, ValueError):
            return jsonify({'error': 'Invalid crop coordinates'}), 400

        # Decode base64
        try:
            image_bytes = base64.b64decode(compressed_data_str)
        except Exception:
            return jsonify({'error': 'Invalid data encoding'}), 400

        # Validate image (size, format, dimensions) — same guards as /process
        validation = compressor.validate_image(image_bytes)
        if not validation.is_valid:
            return jsonify({
                'error': 'Image validation failed',
                'details': validation.errors,
            }), 400

        img = validation.image
        pre_rotation_dims = img.size

        # Apply rotation before crop (coordinates are relative to rotated image)
        if rotation != 0:
            img = compressor.rotate_image(img, rotation)

        img_w, img_h = img.size

        # Validate crop coordinates against (possibly rotated) image dimensions
        is_valid, error_msg = validate_crop_coordinates(
            crop_x, crop_y, crop_w, crop_h, img_w, img_h)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        # Perform the crop, reusing the (possibly rotated) image
        cropped_data, metadata = compressor.crop_image(
            image_bytes, crop_x, crop_y, crop_w, crop_h,
            preloaded_image=img)

        # When rotation was applied, crop_image records the rotated image's
        # dimensions as original_dimensions.  Fix it to reflect the actual
        # input so the API response is self-consistent for any caller.
        if rotation != 0:
            metadata['original_dimensions'] = pre_rotation_dims

        # Encode result as base64
        b64_data = base64.b64encode(cropped_data).decode('ascii')

        # Sanitize filename
        filename = sanitize_filename(filename)

        return jsonify({
            'compressed_data': b64_data,
            'filename': filename,
            'metadata': {
                **metadata,
                'rotated': rotation != 0,
                'encoding': 'base64',
            },
        }), 200

    except ImageValidationError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        current_app.logger.error(f"Crop failed: {e}")
        return jsonify({'error': 'Crop failed'}), 500


@main.route('/theme', methods=['POST'])
@login_required
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
