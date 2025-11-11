"""
Input validation module for the image compression application.
Provides validation functions for all user inputs.
"""

import re
from typing import Optional, Tuple
from werkzeug.datastructures import FileStorage

# Constants
MAX_FILENAME_LENGTH = 255
MAX_DIMENSION = 10000  # Maximum width/height in pixels
MIN_DIMENSION = 1
ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'webp', 'tiff', 'heic'}
ALLOWED_COMPRESSION_MODES = {'lossless', 'web', 'high'}
ALLOWED_RESIZE_MODES = {'original', 'custom'}
ALLOWED_THEMES = {'light', 'dark'}
MIN_QUALITY = 1
MAX_QUALITY = 100

# Regex patterns
FILENAME_PATTERN = re.compile(r'^[\w\-. ]+$')
DIMENSION_PATTERN = re.compile(r'^\d+$')


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


def validate_boolean_param(value: str) -> Tuple[bool, Optional[str]]:
    """
    Validate boolean parameter.

    Args:
        value: String representation of boolean

    Returns:
        Tuple of (is_valid, error_message)
    """
    if value.lower() not in ['true', 'false']:
        return False, "Invalid boolean value. Must be 'true' or 'false'"

    return True, None


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
        compressed_data: Hex-encoded compressed image data
        filename: The filename for download

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not compressed_data:
        return False, "Compressed data is required"

    if not filename:
        return False, "Filename is required"

    # Validate hex data
    try:
        bytes.fromhex(compressed_data[:100])  # Check first 100 chars
    except ValueError:
        return False, "Invalid compressed data format"

    # Check filename
    if len(filename) > MAX_FILENAME_LENGTH:
        return False, f"Filename too long (max {MAX_FILENAME_LENGTH} characters)"

    if '..' in filename or '/' in filename or '\\' in filename:
        return False, "Invalid filename"

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