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

    def _compress_lossless(self, img: Image.Image, quality: Optional[int] = None) -> bytes:
        """
        Lossless compression - maintains original quality while reducing file size.
        """
        output = io.BytesIO()
        save_format = img.format if img.format else 'PNG'
        
        save_params = {
            'format': save_format,
            'optimize': True,
            'quality': quality if quality is not None else 95
        }
        
        # Add specific parameters for PNG
        if save_format == 'PNG':
            save_params.update({
                'optimize': True,
                'compress_level': 9
            })
        # Add specific parameters for JPEG
        elif save_format in ['JPEG', 'JPG']:
            save_params.update({
                'optimize': True,
                'quality': quality if quality is not None else 95,
                'progressive': True
            })
            
        img.save(output, **save_params)
        return output.getvalue()

    def _compress_web(self, img: Image.Image, quality: Optional[int] = None, use_webp: bool = True) -> bytes:
        """
        Web optimization - balanced compression for web use.
        """
        output = io.BytesIO()
        
        # Convert to appropriate mode
        if img.mode in ('RGBA', 'LA'):
            processed_img = img.convert('RGBA' if use_webp else 'RGB')
        else:
            processed_img = img.convert('RGB')
            
        if use_webp:
            # Save as WebP with web-optimized settings
            processed_img.save(
                output, 
                format='WEBP',
                quality=quality if quality is not None else 75,
                method=4,  # 0-6, higher means better compression but slower
                lossless=False,
                exact=False
            )
        else:
            # Save as JPEG with optimized settings
            processed_img.save(
                output,
                format='JPEG',
                quality=quality if quality is not None else 85,
                optimize=True,
                progressive=True
            )
        
        return output.getvalue()

    def _compress_high(self, img: Image.Image, quality: Optional[int] = None, use_webp: bool = False) -> bytes:
        """
        High compression - maximum size reduction.
        """
        output = io.BytesIO()
        
        # Convert RGBA images to RGB with white background
        if img.mode in ('RGBA', 'LA'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'RGBA':
                background.paste(img, mask=img.split()[3])
            else:
                background.paste(img, mask=img.split()[1])
            processed_img = background
        else:
            processed_img = img.convert('RGB')
            
        # Save as WebP with maximum compression
        processed_img.save(
            output,
            format='WEBP',
            quality=quality if quality is not None else 40,
            method=6,  # Maximum compression effort
            lossless=False,
            exact=False,
            minimize_size=True
        )
        
        return output.getvalue()

    def compress_image(
        self,
        image_data: bytes,
        mode: str,
        max_width: Optional[int] = None,
        max_height: Optional[int] = None,
        quality: Optional[int] = None,
        use_webp: bool = False
    ) -> Tuple[bytes, Dict]:
        """
        Compress an image using the specified mode and parameters.
        """
        # Open the image
        img = Image.open(io.BytesIO(image_data))
        original_format = img.format
        original_size = len(image_data)
        original_dimensions = img.size

        # Resize if dimensions are provided
        if max_width or max_height:
            img = self._resize_image(img, max_width, max_height)

        # Apply compression based on mode
        compressed_data = self.compression_modes[mode](img, quality, use_webp)
        
        # Calculate compression ratio and prepare metadata
        compression_ratio = round(len(compressed_data) / original_size * 100, 2)
        
        # If high compression didn't achieve better than 50% reduction,
        # try more aggressive settings
        if mode == 'high' and compression_ratio > 50:
            compressed_data = self._compress_high(img, quality=30)
            compression_ratio = round(len(compressed_data) / original_size * 100, 2)

        metadata = {
            'original_size': original_size,
            'compressed_size': len(compressed_data),
            'original_dimensions': original_dimensions,
            'final_dimensions': img.size,
            'compression_ratio': compression_ratio,
            'format': 'WEBP' if mode in ['web', 'high'] else original_format
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