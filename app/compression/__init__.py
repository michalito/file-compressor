# app/compression/__init__.py
from pillow_heif import register_heif_opener
register_heif_opener()

from .image_processor import ImageCompressor, ImageValidationError, BackgroundRemovalError

__all__ = ['ImageCompressor', 'ImageValidationError', 'BackgroundRemovalError']