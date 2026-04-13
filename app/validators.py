"""
Input validation module for the image compression application.
Provides validation functions for all user inputs.
"""

import re
from typing import Optional, Tuple
from urllib.parse import urlparse

from PIL import Image, UnidentifiedImageError
from werkzeug.datastructures import FileStorage

# Constants
MAX_FILENAME_LENGTH = 255
MAX_DIMENSION = 10000  # Maximum width/height in pixels
MIN_DIMENSION = 1
ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'webp', 'tiff', 'heic', 'heif'}
ALLOWED_COMPRESSION_MODES = {'lossless', 'web', 'high'}
ALLOWED_RESIZE_MODES = {'original', 'custom'}
ALLOWED_THEMES = {'light', 'dark'}
ALLOWED_OUTPUT_FORMATS = {'auto', 'webp', 'jpeg', 'png'}
MIN_QUALITY = 1
MAX_QUALITY = 100
MAX_WATERMARK_LENGTH = 50
MAX_WATERMARK_QR_URL_LENGTH = 2048
MAX_WATERMARK_IMAGE_SIZE_BYTES = 5 * 1024 * 1024
MAX_WATERMARK_IMAGE_DIMENSION = 4096
MAX_WATERMARK_IMAGE_PIXELS = MAX_WATERMARK_IMAGE_DIMENSION * MAX_WATERMARK_IMAGE_DIMENSION
ALLOWED_WATERMARK_POSITIONS = {'bottom-right', 'bottom-left', 'top-right', 'top-left', 'center', 'tiled'}
ALLOWED_WATERMARK_COLORS = {'white', 'black', 'auto'}
ALLOWED_ROTATIONS = {0, 90, 180, 270}

TRUE_VALUES = {'1', 'true', 'on', 'yes'}
FALSE_VALUES = {'0', 'false', 'off', 'no'}


def validate_file(file: FileStorage) -> Tuple[bool, Optional[str]]:
    """
    Validate uploaded file.

    Args:
        file: The uploaded file

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not file:
        return False, "No file provided"

    if not file.filename:
        return False, "No filename provided"

    # Check filename length
    if len(file.filename) > MAX_FILENAME_LENGTH:
        return False, f"Filename too long (max {MAX_FILENAME_LENGTH} characters)"

    # Check for malicious filename patterns
    if '..' in file.filename or '/' in file.filename or '\\' in file.filename:
        return False, "Invalid filename"

    # Check file extension
    extension = file.filename.lower().rsplit('.', 1)[-1] if '.' in file.filename else ''
    if extension not in ALLOWED_EXTENSIONS:
        return False, f"Invalid file type. Allowed types: {', '.join(ALLOWED_EXTENSIONS)}"

    return True, None


def validate_compression_mode(mode: str) -> Tuple[bool, Optional[str]]:
    """
    Validate compression mode.

    Args:
        mode: The compression mode

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not mode:
        return False, "Compression mode is required"

    if mode not in ALLOWED_COMPRESSION_MODES:
        return False, f"Invalid compression mode. Allowed modes: {', '.join(ALLOWED_COMPRESSION_MODES)}"

    return True, None


def validate_resize_mode(mode: str) -> Tuple[bool, Optional[str]]:
    """
    Validate resize mode.

    Args:
        mode: The resize mode

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not mode:
        return True, None  # Resize mode is optional

    if mode not in ALLOWED_RESIZE_MODES:
        return False, f"Invalid resize mode. Allowed modes: {', '.join(ALLOWED_RESIZE_MODES)}"

    return True, None


def validate_dimensions(width: Optional[int], height: Optional[int]) -> Tuple[bool, Optional[str]]:
    """
    Validate image dimensions.

    Args:
        width: The width in pixels
        height: The height in pixels

    Returns:
        Tuple of (is_valid, error_message)
    """
    if width is not None:
        if not isinstance(width, int) or width < MIN_DIMENSION or width > MAX_DIMENSION:
            return False, f"Invalid width. Must be between {MIN_DIMENSION} and {MAX_DIMENSION}"

    if height is not None:
        if not isinstance(height, int) or height < MIN_DIMENSION or height > MAX_DIMENSION:
            return False, f"Invalid height. Must be between {MIN_DIMENSION} and {MAX_DIMENSION}"

    return True, None


def validate_quality(quality: Optional[int]) -> Tuple[bool, Optional[str]]:
    """
    Validate compression quality.

    Args:
        quality: The quality value (1-100)

    Returns:
        Tuple of (is_valid, error_message)
    """
    if quality is None:
        return True, None  # Quality is optional

    if not isinstance(quality, int) or quality < MIN_QUALITY or quality > MAX_QUALITY:
        return False, f"Invalid quality. Must be between {MIN_QUALITY} and {MAX_QUALITY}"

    return True, None


def validate_output_format(output_format: str) -> Tuple[bool, Optional[str]]:
    """
    Validate output format selection.

    Args:
        output_format: The output format ('auto', 'webp', 'jpeg')

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not output_format:
        return False, "Output format is required"

    if output_format not in ALLOWED_OUTPUT_FORMATS:
        return False, f"Invalid output format. Allowed formats: {', '.join(ALLOWED_OUTPUT_FORMATS)}"

    return True, None


def parse_boolean_form_value(value: Optional[str], field_name: str) -> Tuple[bool, Optional[bool], Optional[str]]:
    """
    Parse an optional HTML form boolean field.

    Empty / missing values are treated as False. Non-empty invalid values fail.
    """
    if value is None or value == '':
        return True, False, None

    normalized = value.strip().lower()
    if normalized in TRUE_VALUES:
        return True, True, None
    if normalized in FALSE_VALUES:
        return True, False, None

    return False, None, f"Invalid {field_name} value"


def validate_theme(theme: str) -> Tuple[bool, Optional[str]]:
    """
    Validate theme selection.

    Args:
        theme: The theme name

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not theme:
        return False, "Theme is required"

    if theme not in ALLOWED_THEMES:
        return False, f"Invalid theme. Allowed themes: {', '.join(ALLOWED_THEMES)}"

    return True, None


def validate_download_data(compressed_data: str, filename: str) -> Tuple[bool, Optional[str]]:
    """
    Validate download request data.

    Args:
        compressed_data: Base64-encoded compressed image data
        filename: The filename for download

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not compressed_data:
        return False, "Compressed data is required"

    if not filename:
        return False, "Filename is required"

    # Quick structural check — the route's b64decode() catches actual corruption
    if len(compressed_data) % 4 != 0:
        return False, "Invalid compressed data format"

    # Check filename
    if len(filename) > MAX_FILENAME_LENGTH:
        return False, f"Filename too long (max {MAX_FILENAME_LENGTH} characters)"

    if '..' in filename or '/' in filename or '\\' in filename:
        return False, "Invalid filename"

    return True, None


def validate_watermark_text(text: Optional[str]) -> Tuple[bool, Optional[str]]:
    """
    Validate watermark text. None/empty means no watermark.
    """
    if not text:
        return True, None

    if len(text) > MAX_WATERMARK_LENGTH:
        return False, f"Watermark text too long (max {MAX_WATERMARK_LENGTH} characters)"

    if not all(c.isprintable() for c in text):
        return False, "Watermark text must contain only printable characters"

    return True, None


def validate_watermark_position(position: str) -> Tuple[bool, Optional[str]]:
    """
    Validate watermark position.
    """
    if position not in ALLOWED_WATERMARK_POSITIONS:
        return False, f"Invalid watermark position. Allowed: {', '.join(sorted(ALLOWED_WATERMARK_POSITIONS))}"

    return True, None


def validate_watermark_color(color: str) -> Tuple[bool, Optional[str]]:
    if color not in ALLOWED_WATERMARK_COLORS:
        return False, f"Invalid watermark color. Allowed: {', '.join(sorted(ALLOWED_WATERMARK_COLORS))}"

    return True, None


def validate_watermark_layer_options(position: str,
                                     opacity: int,
                                     size: int,
                                     angle: int = 0,
                                     tile_density: int = 5) -> Tuple[bool, Optional[str]]:
    """
    Validate per-layer watermark transform options.
    """
    is_valid, error_msg = validate_watermark_position(position)
    if not is_valid:
        return False, error_msg

    if not isinstance(opacity, int) or opacity < 10 or opacity > 100:
        return False, "Watermark opacity must be between 10 and 100"

    if not isinstance(size, int) or size < 1 or size > 20:
        return False, "Watermark size must be between 1 and 20"

    if not isinstance(tile_density, int) or tile_density < 1 or tile_density > 10:
        return False, "Watermark tile density must be between 1 and 10"

    if not isinstance(angle, int) or angle < -180 or angle > 180:
        return False, "Watermark angle must be between -180 and 180"

    return True, None


def _validate_watermark_png_file(file: FileStorage, label: str) -> Tuple[bool, Optional[str]]:
    if not file or not file.filename:
        return False, f"{label} is required"

    if file.mimetype not in ('image/png', 'application/octet-stream'):
        return False, f"{label} must be a PNG image"

    stream = file.stream
    pos = stream.tell()
    try:
        stream.seek(0, 2)
        size_bytes = stream.tell()
        stream.seek(0)

        if not size_bytes:
            return False, f"{label} is required"

        if size_bytes > MAX_WATERMARK_IMAGE_SIZE_BYTES:
            return False, f"{label} must be 5 MB or smaller"

        with Image.open(stream) as img:
            if img.format != 'PNG':
                return False, f"{label} must be a PNG image"

            width, height = img.size
    except (UnidentifiedImageError, OSError):
        return False, f"{label} is not a valid PNG image"
    finally:
        stream.seek(pos)

    if width > MAX_WATERMARK_IMAGE_DIMENSION or height > MAX_WATERMARK_IMAGE_DIMENSION:
        return False, f"{label} must be {MAX_WATERMARK_IMAGE_DIMENSION}px or smaller on each side"

    if width * height > MAX_WATERMARK_IMAGE_PIXELS:
        return False, f"{label} exceeds the maximum supported pixel count"

    return True, None


def validate_watermark_logo(file: FileStorage) -> Tuple[bool, Optional[str]]:
    return _validate_watermark_png_file(file, 'Watermark logo')


def validate_watermark_qr_url(url: Optional[str]) -> Tuple[bool, Optional[str]]:
    value = (url or '').strip()
    if not value:
        return False, "QR watermark URL is required"

    if len(value) > MAX_WATERMARK_QR_URL_LENGTH:
        return False, f"QR watermark URL must be {MAX_WATERMARK_QR_URL_LENGTH} characters or fewer"

    parsed = urlparse(value)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        return False, "QR watermark URL must be an absolute http:// or https:// URL"

    return True, None


def validate_watermark_qr_image(file: FileStorage) -> Tuple[bool, Optional[str]]:
    return _validate_watermark_png_file(file, 'QR watermark image')


def validate_crop_coordinates(x: int, y: int, width: int, height: int,
                              image_width: int, image_height: int) -> Tuple[bool, Optional[str]]:
    """
    Validate crop coordinates against image dimensions.

    Args:
        x, y: Top-left corner of crop region
        width, height: Size of crop region
        image_width, image_height: Actual image dimensions

    Returns:
        Tuple of (is_valid, error_message)
    """
    for name, val in [('x', x), ('y', y), ('width', width), ('height', height)]:
        if not isinstance(val, int) or val < 0:
            return False, f"Crop {name} must be a non-negative integer"

    if width < 1 or height < 1:
        return False, "Crop width and height must be at least 1 pixel"

    if x + width > image_width:
        return False, "Crop region exceeds image width"

    if y + height > image_height:
        return False, "Crop region exceeds image height"

    return True, None


def validate_rotation(rotation: int) -> Tuple[bool, Optional[str]]:
    """
    Validate rotation angle.

    Args:
        rotation: Rotation angle in degrees (clockwise)

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not isinstance(rotation, int) or isinstance(rotation, bool):
        return False, "Rotation must be an integer"

    if rotation not in ALLOWED_ROTATIONS:
        return False, f"Rotation must be one of {sorted(ALLOWED_ROTATIONS)}"

    return True, None


def sanitize_filename(filename: str) -> str:
    """
    Sanitize a filename to remove potentially dangerous characters.

    Args:
        filename: The original filename

    Returns:
        Sanitized filename
    """
    # Remove path separators and parent directory references
    filename = filename.replace('/', '').replace('\\', '').replace('..', '')

    # Remove any non-alphanumeric characters except dots, hyphens, and underscores
    filename = re.sub(r'[^\w\-.]', '_', filename)

    # Limit length
    if len(filename) > MAX_FILENAME_LENGTH:
        name, ext = filename.rsplit('.', 1) if '.' in filename else (filename, '')
        max_name_length = MAX_FILENAME_LENGTH - len(ext) - 1 if ext else MAX_FILENAME_LENGTH
        filename = f"{name[:max_name_length]}.{ext}" if ext else name[:max_name_length]

    return filename
