import base64
import io

from flask import Blueprint, render_template, request, jsonify, send_file, current_app, redirect, url_for, session, Response, stream_with_context
from PIL import Image

from .compression import ImageCompressor, ImageValidationError, BackgroundRemovalError
from .ai_upscale import (
    AIUpscalerError,
    create_ai_job,
    delete_ai_job,
    get_ai_max_upload_bytes,
    iter_ai_stream,
    get_ai_health,
    get_ai_job,
    cancel_ai_job,
    open_ai_artifact_stream,
    open_ai_download_all_stream,
    parse_ai_upscale_settings,
    validate_ai_upscale_upload,
)
from .auth import RateLimitExceeded, login_required
from .validators import (
    validate_file, validate_compression_mode, validate_resize_mode,
    validate_resize_dimensions, validate_quality, validate_output_format,
    validate_theme, validate_download_data, validate_crop_coordinates,
    validate_rotation, sanitize_filename,
    validate_watermark_text, validate_watermark_color, validate_watermark_layer_options,
    validate_watermark_logo, validate_watermark_qr_url, validate_watermark_qr_image,
    MAX_WATERMARK_IMAGE_PIXELS,
    is_safe_ai_identifier,
    parse_boolean_form_value, parse_optional_int_form_value,
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

SAFE_AI_IDENTIFIER_ERROR = {'error': 'Invalid AI upscaling identifier.'}


def _proxy_ai_stream_response(stream, *, as_attachment: bool, default_name: str):
    filename = stream.filename or default_name
    response = Response(
        stream_with_context(iter_ai_stream(stream)),
        mimetype=stream.content_type or 'application/octet-stream',
        direct_passthrough=True,
    )
    if stream.content_length is not None:
        response.content_length = stream.content_length
    response.headers['Cache-Control'] = 'no-store'
    if as_attachment:
        response.headers.set('Content-Disposition', 'attachment', filename=filename)
    response.call_on_close(stream.close)
    return response


def _validate_ai_identifier(identifier: str):
    if not is_safe_ai_identifier((identifier or '').strip()):
        return jsonify(SAFE_AI_IDENTIFIER_ERROR), 400
    return None


def _load_rgba_image(file):
    if not file:
        return None

    stream = file.stream
    pos = stream.tell()
    stream.seek(0)

    try:
        with Image.open(stream) as image:
            width, height = image.size
            if width * height > MAX_WATERMARK_IMAGE_PIXELS:
                raise ValueError('Watermark image exceeds the maximum supported pixel count')

            image.load()
            return image.convert('RGBA')
    finally:
        stream.seek(pos)


def _get_watermark_layer_options(prefix: str):
    return {
        'position': request.form.get(f'watermark_{prefix}_position', 'bottom-right'),
        'opacity': request.form.get(f'watermark_{prefix}_opacity', 50, type=int),
        'size': request.form.get(f'watermark_{prefix}_size', 5, type=int),
        'angle': request.form.get(f'watermark_{prefix}_angle', 0, type=int),
        'tile_density': request.form.get(f'watermark_{prefix}_tile_density', 5, type=int),
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
                        watermark_layers=None, remove_background=False):
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
        watermark_layers=watermark_layers,
        remove_background=remove_background,
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
    max_width_raw = request.form.get('max_width')
    max_height_raw = request.form.get('max_height')
    quality = request.form.get('quality', type=int)
    output_format = request.form.get('output_format', 'auto')
    remove_background_raw = request.form.get('remove_background')

    # Validate resize mode before parsing resize dimensions.
    is_valid, error_msg = validate_resize_mode(resize_mode)
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    is_valid, max_width, error_msg = parse_optional_int_form_value(max_width_raw, 'width')
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    is_valid, max_height, error_msg = parse_optional_int_form_value(max_height_raw, 'height')
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    is_valid, remove_background, error_msg = parse_boolean_form_value(
        remove_background_raw, 'remove_background')
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    if remove_background:
        compression_mode = 'lossless'
        output_format = 'png'
        quality = None

    # Validate compression mode
    is_valid, error_msg = validate_compression_mode(compression_mode)
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    # Validate dimensions
    is_valid, error_msg = validate_resize_dimensions(resize_mode, max_width, max_height)
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
    watermark_text_color = request.form.get('watermark_text_color', 'white')
    watermark_logo = request.files.get('watermark_logo')
    watermark_qr_url = request.form.get('watermark_qr_url', '').strip() or None
    watermark_qr_image = request.files.get('watermark_qr_image')
    watermark_layers = {}

    if watermark_text:
        is_valid, error_msg = validate_watermark_text(watermark_text)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        is_valid, error_msg = validate_watermark_color(watermark_text_color)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        text_options = _get_watermark_layer_options('text')
        is_valid, error_msg = validate_watermark_layer_options(**text_options)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        watermark_layers['text'] = {
            'value': watermark_text,
            'color': watermark_text_color,
            **text_options,
        }

    if watermark_logo:
        is_valid, error_msg = validate_watermark_logo(watermark_logo)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        logo_options = _get_watermark_layer_options('logo')
        is_valid, error_msg = validate_watermark_layer_options(**logo_options)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        watermark_layers['logo'] = logo_options

    if watermark_qr_url or watermark_qr_image:
        is_valid, error_msg = validate_watermark_qr_url(watermark_qr_url)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        is_valid, error_msg = validate_watermark_qr_image(watermark_qr_image)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        qr_options = _get_watermark_layer_options('qr')
        is_valid, error_msg = validate_watermark_layer_options(**qr_options)
        if not is_valid:
            return jsonify({'error': error_msg}), 400

        watermark_layers['qr'] = {
            'url': watermark_qr_url,
            **qr_options,
        }

    try:
        if 'logo' in watermark_layers:
            watermark_layers['logo']['image'] = _load_rgba_image(watermark_logo)

        if 'qr' in watermark_layers:
            watermark_layers['qr']['image'] = _load_rgba_image(watermark_qr_image)

        result, status = _process_image_file(
            file, compression_mode, resize_mode,
            max_width, max_height, quality, output_format,
            watermark_layers=watermark_layers or None,
            remove_background=remove_background,
        )
        return jsonify(result), status

    except BackgroundRemovalError:
        current_app.logger.exception("Background removal failed during /process")
        return jsonify({
            'error': 'Background removal is unavailable right now. Try again or disable Remove Background.'
        }), 503
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        current_app.logger.exception("Processing failed during /process")
        return jsonify({'error': 'Processing failed'}), 500


@main.route('/ai-upscale/health', methods=['GET'])
@login_required
def ai_upscale_health():
    try:
        return jsonify(get_ai_health())
    except AIUpscalerError as e:
        payload = {
            'enabled': bool(current_app.config.get('AI_UPSCALER_ENABLED')),
            'healthy': False,
            'state': 'error',
            'backend': None,
            'reason': e.message,
            'details': {},
        }
        payload.update(e.payload)
        return jsonify(payload), e.status_code


def _build_ai_upscale_error_payload(error: AIUpscalerError) -> dict:
    payload = {
        'error': error.payload.get('user_message') or error.message,
    }
    payload.update(error.payload)
    return payload


@main.route('/ai-upscale/jobs', methods=['POST'])
@login_required
def ai_upscale_create_job():
    if not current_app.config.get('AI_UPSCALER_ENABLED'):
        return jsonify({
            'error': 'AI upscaling is disabled in configuration.',
            'code': 'ai_upscale_disabled',
        }), 503

    file = request.files.get('file')
    is_valid, error_msg = validate_file(file)
    if not is_valid:
        return jsonify({'error': error_msg}), 400

    try:
        settings = parse_ai_upscale_settings(request.form)
        file.stream.seek(0)
        image_bytes = file.stream.read(get_ai_max_upload_bytes() + 1)
        validate_ai_upscale_upload(file, image_bytes, settings)
        result = create_ai_job(
            file_bytes=image_bytes,
            filename=file.filename,
            content_type=file.mimetype,
            settings=settings,
        )
        return jsonify(result), 202
    except AIUpscalerError as e:
        return jsonify(_build_ai_upscale_error_payload(e)), e.status_code


@main.route('/ai-upscale/jobs/<job_id>', methods=['GET'])
@login_required
def ai_upscale_get_job(job_id):
    invalid = _validate_ai_identifier(job_id)
    if invalid:
        return invalid
    try:
        return jsonify(get_ai_job(job_id))
    except AIUpscalerError as e:
        return jsonify(_build_ai_upscale_error_payload(e)), e.status_code


@main.route('/ai-upscale/jobs/<job_id>/cancel', methods=['POST'])
@login_required
def ai_upscale_cancel_job(job_id):
    invalid = _validate_ai_identifier(job_id)
    if invalid:
        return invalid
    try:
        return jsonify(cancel_ai_job(job_id))
    except AIUpscalerError as e:
        return jsonify(_build_ai_upscale_error_payload(e)), e.status_code


@main.route('/ai-upscale/jobs/<job_id>', methods=['DELETE'])
@login_required
def ai_upscale_delete_job(job_id):
    invalid = _validate_ai_identifier(job_id)
    if invalid:
        return invalid
    try:
        return jsonify(delete_ai_job(job_id))
    except AIUpscalerError as e:
        return jsonify(_build_ai_upscale_error_payload(e)), e.status_code


@main.route('/ai-upscale/artifacts/<artifact_id>/preview', methods=['GET'])
@login_required
def ai_upscale_preview_artifact(artifact_id):
    invalid = _validate_ai_identifier(artifact_id)
    if invalid:
        return invalid
    try:
        stream = open_ai_artifact_stream(artifact_id, kind='preview')
        return _proxy_ai_stream_response(stream, as_attachment=False, default_name=f'{artifact_id}-preview')
    except AIUpscalerError as e:
        return jsonify(_build_ai_upscale_error_payload(e)), e.status_code


@main.route('/ai-upscale/artifacts/<artifact_id>/download', methods=['GET'])
@login_required
def ai_upscale_download_artifact(artifact_id):
    invalid = _validate_ai_identifier(artifact_id)
    if invalid:
        return invalid
    try:
        stream = open_ai_artifact_stream(artifact_id, kind='download')
        return _proxy_ai_stream_response(stream, as_attachment=True, default_name=f'{artifact_id}-upscaled')
    except AIUpscalerError as e:
        return jsonify(_build_ai_upscale_error_payload(e)), e.status_code


@main.route('/ai-upscale/download-all', methods=['POST'])
@login_required
def ai_upscale_download_all():
    data = request.json or {}
    artifacts = data.get('artifacts')
    if not isinstance(artifacts, list) or not artifacts:
        return jsonify({'error': 'No AI upscaled artifacts provided'}), 400

    normalized_artifacts = []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            return jsonify({'error': 'Invalid AI artifact list'}), 400
        artifact_id = (artifact.get('artifact_id') or '').strip()
        filename = sanitize_filename((artifact.get('filename') or '').strip())
        if not artifact_id or not filename:
            return jsonify({'error': 'Each AI artifact requires artifact_id and filename'}), 400
        if not is_safe_ai_identifier(artifact_id):
            return jsonify(SAFE_AI_IDENTIFIER_ERROR), 400
        normalized_artifacts.append((artifact_id, filename))
    try:
        stream = open_ai_download_all_stream(
            [{'artifact_id': artifact_id, 'filename': filename} for artifact_id, filename in normalized_artifacts]
        )
        default_name = normalized_artifacts[0][1] if len(normalized_artifacts) == 1 else 'ai_upscaled_images.zip'
        return _proxy_ai_stream_response(stream, as_attachment=True, default_name=default_name)
    except AIUpscalerError as e:
        return jsonify(_build_ai_upscale_error_payload(e)), e.status_code


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
