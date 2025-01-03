# app/compression/image_processor.py
from PIL import Image
import io
from typing import Tuple, Dict, Optional, List
from dataclasses import dataclass

class CompressionError(Exception):
    """Base class for compression-related errors"""
    pass

class FileSizeError(CompressionError):
    """Raised when file size exceeds maximum limit"""
    pass

class FormatError(CompressionError):
    """Raised when image format is not supported"""
    pass

class ImageValidationError(CompressionError):
    """Raised when image validation fails"""
    pass

@dataclass
class ValidationResult:
    is_valid: bool
    errors: List[str]
    warnings: List[str]

class ImageCompressor:
    def __init__(self, max_file_size_mb: int = 10):
        self.max_file_size = max_file_size_mb * 1024 * 1024  # Convert MB to bytes
        self.compression_modes = {
            'lossless': self._compress_lossless,
            'web': self._compress_web,
            'high': self._compress_high
        }

    def validate_image(self, image_data: bytes) -> ValidationResult:
        """
        Validate image data before processing.
        
        Args:
            image_data: Raw image data in bytes
            
        Returns:
            ValidationResult object containing validation status and any errors/warnings
        """
        errors = []
        warnings = []
        
        # Check file size
        if len(image_data) > self.max_file_size:
            errors.append(f"File size exceeds maximum limit of {self.max_file_size // (1024 * 1024)}MB")
        
        try:
            # Try to open the image to validate format
            img = Image.open(io.BytesIO(image_data))
            
            # Check format
            if img.format not in ['JPEG', 'PNG', 'WEBP', 'TIFF']:
                errors.append(f"Unsupported image format: {img.format}")
            
            # Check dimensions
            width, height = img.size
            if width * height > 40000000:  # e.g., larger than 8000x5000
                warnings.append("Image dimensions are very large and may require significant processing time")
            
            # Check color mode
            if img.mode not in ['RGB', 'RGBA', 'L']:
                warnings.append(f"Unusual color mode: {img.mode}. Conversion may affect quality")
                
        except Exception as e:
            errors.append(f"Invalid image file: {str(e)}")
        
        return ValidationResult(
            is_valid=len(errors) == 0,
            errors=errors,
            warnings=warnings
        )

    def _compress_lossless(self, img: Image.Image, quality: Optional[int] = None) -> Image.Image:
        """
        Lossless compression - maintains original quality while reducing file size.
        - Keeps original format
        - Uses PIL's optimize flag
        - Suitable for professional photography or when quality is critical
        """
        return img

    def _compress_web(self, img: Image.Image, quality: Optional[int] = None) -> Image.Image:
        """
        Web optimization - balanced compression for general web use.
        - Uses WebP with moderate compression
        - Maintains good visual quality
        - Preserves transparency when present
        - Targets ~200-300KB for typical images
        """
        if img.mode in ('RGBA', 'LA'):
            return img.convert('RGBA')
        return img.convert('RGB')

    def _compress_high(self, img: Image.Image, quality: Optional[int] = None) -> Image.Image:
        """
        High compression - maximum size reduction.
        - Uses WebP with aggressive compression
        - Accepts more quality loss for smaller files
        - Converts transparency to white background
        - Targets <100KB for typical images
        """
        # For high compression, we'll still use WebP but with more aggressive settings
        if img.mode in ('RGBA', 'LA'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'RGBA':
                background.paste(img, mask=img.split()[3])
            else:
                background.paste(img, mask=img.split()[1])
            return background
        return img.convert('RGB')

    def compress_image(
        self,
        image_data: bytes,
        mode: str,
        max_width: Optional[int] = None,
        max_height: Optional[int] = None,
        quality: Optional[int] = None
    ) -> Tuple[bytes, Dict]:
        """
        Compress an image using the specified mode and parameters.
        """
        img = Image.open(io.BytesIO(image_data))
        original_format = img.format
        original_size = len(image_data)
        original_dimensions = img.size

        # Resize if dimensions are provided
        if max_width or max_height:
            img = self._resize_image(img, max_width, max_height)

        # Apply compression based on mode
        compressed_img = self.compression_modes[mode](img, quality)
        
        # Define compression parameters based on mode
        if mode == 'lossless':
            save_format = original_format
            save_params = {
                'format': save_format,
                'optimize': True,
                'quality': quality if quality is not None else 95
            }
            # Add specific parameters for PNG
            if save_format == 'PNG':
                save_params.update({
                    'optimize': True,
                    'compress_level': 9  # Maximum PNG compression
                })
            # Add specific parameters for JPEG
            elif save_format in ['JPEG', 'JPG']:
                save_params.update({
                    'optimize': True,
                    'quality': quality if quality is not None else 95,
                    'progressive': True
                })
                
        elif mode == 'web':
            save_format = 'WEBP'
            save_params = {
                'format': save_format,
                'method': 4,  # 0-6, higher means better quality but slower
                'quality': quality if quality is not None else 75,  # Good balance
                'lossless': False,
                'exact': False  # Allow inexact color matching for better compression
            }
        else:  # high compression
            save_format = 'WEBP'
            save_params = {
                'format': save_format,
                'method': 6,  # Maximum compression effort
                'quality': quality if quality is not None else 40,  # Aggressive compression
                'lossless': False,
                'exact': False,
                'minimize_size': True  # Ensure minimum file size
            }

        # Save to bytes with appropriate parameters
        output_buffer = io.BytesIO()
        compressed_img.save(output_buffer, **save_params)
        compressed_data = output_buffer.getvalue()

        # Calculate compression ratio
        compression_ratio = round(len(compressed_data) / original_size * 100, 2)
        
        # If high compression didn't achieve better compression than web mode,
        # try even more aggressive settings
        if mode == 'high' and compression_ratio > 50:  # If less than 50% reduction
            save_params['quality'] = 30
            output_buffer = io.BytesIO()
            compressed_img.save(output_buffer, **save_params)
            compressed_data = output_buffer.getvalue()
            compression_ratio = round(len(compressed_data) / original_size * 100, 2)

        metadata = {
            'original_size': original_size,
            'compressed_size': len(compressed_data),
            'original_dimensions': original_dimensions,
            'final_dimensions': compressed_img.size,
            'compression_ratio': compression_ratio,
            'format': save_format
        }

        return compressed_data, metadata

    def _resize_image(self, img: Image.Image, max_width: Optional[int], max_height: Optional[int]) -> Image.Image:
        """Resize image maintaining aspect ratio"""
        if not max_width and not max_height:
            return img

        width, height = img.size
        aspect_ratio = width / height

        if max_width and max_height:
            if width > max_width or height > max_height:
                if max_width / max_height > aspect_ratio:
                    max_width = int(max_height * aspect_ratio)
                else:
                    max_height = int(max_width / aspect_ratio)
        elif max_width:
            max_height = int(max_width / aspect_ratio)
        else:  # max_height only
            max_width = int(max_height * aspect_ratio)

        if max_width < width or max_height < height:
            img = img.resize((max_width, max_height), Image.Resampling.LANCZOS)

        return img

    def _remove_transparency(self, img: Image.Image) -> Image.Image:
        """Convert RGBA image to RGB with white background"""
        if img.mode in ('RGBA', 'LA'):
            background = Image.new('RGB', img.size, 'white')
            if img.mode == 'RGBA':
                background.paste(img, mask=img.split()[3])
            else:
                background.paste(img, mask=img.split()[1])
            return background
        return img