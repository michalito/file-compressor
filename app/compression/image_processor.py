from PIL import Image, ImageOps, ImageCms
import io
import logging
from typing import Tuple, Dict, Optional, List
from dataclasses import dataclass

logger = logging.getLogger(__name__)


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
    image: Optional[Image.Image] = None  # Return the opened image to avoid reopening


class ImageCompressor:
    def __init__(self, max_file_size_mb: int = 10):
        self.max_file_size = max_file_size_mb * 1024 * 1024  # Convert MB to bytes
        self.compression_modes = {
            'lossless': self._compress_lossless,
            'web': self._compress_web,
            'high': self._compress_high
        }

    def _apply_exif_orientation(self, img: Image.Image) -> Image.Image:
        """Physically rotate pixels to match EXIF orientation tag."""
        original_format = img.format
        try:
            transposed = ImageOps.exif_transpose(img)
            if transposed is not None:
                transposed.format = original_format
                return transposed
        except Exception:
            logger.debug("Could not apply EXIF orientation, using image as-is")
        return img

    def _normalize_color_mode(self, img: Image.Image) -> Image.Image:
        """Convert non-standard color modes to RGB/RGBA."""
        original_format = img.format
        original_mode = img.mode

        if img.mode in ('RGB', 'RGBA', 'LA', 'L'):
            return img

        if img.mode == 'CMYK':
            img = img.convert('RGB')
        elif img.mode in ('P', 'PA'):
            if 'transparency' in img.info or img.mode == 'PA':
                img = img.convert('RGBA')
            else:
                img = img.convert('RGB')
        elif img.mode == 'I':
            img = img.convert('L').convert('RGB')
        elif img.mode == '1':
            img = img.convert('L').convert('RGB')
        else:
            img = img.convert('RGB')

        img.format = original_format
        logger.info("Converted color mode %s → %s", original_mode, img.mode)
        return img

    def _convert_to_srgb(self, img: Image.Image) -> Image.Image:
        """Convert non-sRGB ICC profiles to sRGB for correct web display."""
        icc_profile = img.info.get('icc_profile')
        if not icc_profile or img.mode not in ('RGB', 'RGBA'):
            return img

        original_format = img.format
        try:
            input_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
            srgb_profile = ImageCms.createProfile('sRGB')
            img = ImageCms.profileToProfile(
                img, input_profile, srgb_profile,
                outputMode=img.mode
            )
            img.format = original_format
        except Exception:
            logger.debug("Could not convert ICC profile to sRGB, using image as-is")

        return img

    def validate_image(self, image_data: bytes) -> ValidationResult:
        """
        Validate image data before processing.
        Returns ValidationResult with opened image to avoid reopening.
        """
        errors = []
        warnings = []
        img = None

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
            img = None

        return ValidationResult(
            is_valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
            image=img if len(errors) == 0 else None
        )

    def _remove_transparency(self, img: Image.Image) -> Image.Image:
        """Convert RGBA/LA image to RGB with white background"""
        if img.mode in ('RGBA', 'LA'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'RGBA':
                background.paste(img, mask=img.split()[3])
            else:
                background.paste(img, mask=img.split()[1])
            return background
        return img

    def _has_transparency(self, img: Image.Image) -> bool:
        """Check if image has actual transparent pixels (not just an alpha channel)."""
        if img.mode == 'RGBA':
            alpha = img.split()[3]
            extrema = alpha.getextrema()
            return extrema[0] < 255  # Has at least one non-fully-opaque pixel
        if img.mode == 'LA':
            alpha = img.split()[1]
            extrema = alpha.getextrema()
            return extrema[0] < 255
        return False

    def _save_as_png(self, img: Image.Image, strip_metadata: bool = True) -> bytes:
        """Save image as optimized PNG."""
        output = io.BytesIO()
        save_params = {'format': 'PNG', 'optimize': True, 'compress_level': 9}
        if not strip_metadata:
            icc_profile = img.info.get('icc_profile')
            if icc_profile:
                save_params['icc_profile'] = icc_profile
        img.save(output, **save_params)
        return output.getvalue()

    def _save_as_webp_lossless(self, img: Image.Image, strip_metadata: bool = True) -> bytes:
        """Save image as lossless WebP (for format conversion without quality loss)."""
        output = io.BytesIO()
        if img.mode in ('RGBA', 'LA'):
            processed = img if img.mode == 'RGBA' else img.convert('RGBA')
        elif img.mode == 'RGB':
            processed = img
        else:
            processed = img.convert('RGB')
        save_params = {'format': 'WEBP', 'lossless': True, 'quality': 80}
        if not strip_metadata:
            icc_profile = img.info.get('icc_profile')
            if icc_profile:
                save_params['icc_profile'] = icc_profile
        processed.save(output, **save_params)
        return output.getvalue()

    def _save_as_jpeg_quality(self, img: Image.Image, quality: Optional[int] = None,
                              strip_metadata: bool = True) -> bytes:
        """Save image as high-quality JPEG (for format conversion with minimal loss)."""
        output = io.BytesIO()
        processed = self._remove_transparency(img)
        if processed.mode != 'RGB':
            processed = processed.convert('RGB')
        save_params = {
            'format': 'JPEG',
            'quality': quality if quality is not None else 95,
            'optimize': True,
            'progressive': True,
        }
        # 'keep' subsampling only valid when source is JPEG
        if img.format in ('JPEG', 'JPG'):
            save_params['subsampling'] = 'keep'
        if not strip_metadata:
            if img.info.get('exif'):
                save_params['exif'] = img.info['exif']
            icc_profile = img.info.get('icc_profile')
            if icc_profile:
                save_params['icc_profile'] = icc_profile
        processed.save(output, **save_params)
        return output.getvalue()

    def _compress_lossless(self, img: Image.Image, quality: Optional[int] = None, use_webp: bool = False) -> bytes:
        """
        Lossless compression - maintains original quality while reducing file size.
        Note: use_webp parameter is ignored in lossless mode as it preserves original format.
        """
        output = io.BytesIO()
        save_format = img.format if img.format else 'PNG'

        save_params = {
            'format': save_format,
            'optimize': True,
        }

        if save_format == 'PNG':
            save_params['compress_level'] = 9
        elif save_format in ['JPEG', 'JPG']:
            save_params['quality'] = quality if quality is not None else 95
            save_params['progressive'] = True
            save_params['subsampling'] = 'keep'
            if img.info.get('exif'):
                save_params['exif'] = img.info['exif']
            icc_profile = img.info.get('icc_profile')
            if icc_profile:
                save_params['icc_profile'] = icc_profile
        elif save_format == 'WEBP':
            save_params['lossless'] = True
            save_params['quality'] = 80  # compression effort for lossless
        elif save_format == 'TIFF':
            save_params['compression'] = 'tiff_adobe_deflate'
            icc_profile = img.info.get('icc_profile')
            if icc_profile:
                save_params['icc_profile'] = icc_profile

        img.save(output, **save_params)
        return output.getvalue()

    def _compress_web(self, img: Image.Image, quality: Optional[int] = None, use_webp: bool = True) -> bytes:
        """
        Web optimization - balanced compression for web use.
        """
        output = io.BytesIO()

        if use_webp:
            # WebP supports RGBA, keep transparency
            if img.mode in ('RGBA', 'LA'):
                processed_img = img if img.mode == 'RGBA' else img.convert('RGBA')
            elif img.mode == 'RGB':
                processed_img = img
            else:
                processed_img = img.convert('RGB')
        else:
            # JPEG doesn't support transparency — composite onto white
            processed_img = self._remove_transparency(img)
            if processed_img.mode != 'RGB':
                processed_img = processed_img.convert('RGB')

        if use_webp:
            processed_img.save(
                output,
                format='WEBP',
                quality=quality if quality is not None else 75,
                method=4,
                lossless=False,
                exact=False,
                exif=b'',
                icc_profile=b''
            )
        else:
            processed_img.save(
                output,
                format='JPEG',
                quality=quality if quality is not None else 85,
                optimize=True,
                progressive=True,
                subsampling='4:2:0',
                exif=b'',
                icc_profile=b''
            )

        return output.getvalue()

    def _compress_high(self, img: Image.Image, quality: Optional[int] = None, use_webp: bool = False) -> bytes:
        """
        High compression - maximum size reduction.
        """
        output = io.BytesIO()

        if use_webp:
            # WebP supports RGBA, keep transparency
            if img.mode in ('RGBA', 'LA'):
                processed_img = img if img.mode == 'RGBA' else img.convert('RGBA')
            elif img.mode == 'RGB':
                processed_img = img
            else:
                processed_img = img.convert('RGB')
        else:
            # JPEG doesn't support transparency — composite onto white
            processed_img = self._remove_transparency(img)
            if processed_img.mode != 'RGB':
                processed_img = processed_img.convert('RGB')

        if use_webp:
            processed_img.save(
                output,
                format='WEBP',
                quality=quality if quality is not None else 40,
                method=6,
                lossless=False,
                exact=False,
                minimize_size=True,
                exif=b'',
                icc_profile=b''
            )
        else:
            processed_img.save(
                output,
                format='JPEG',
                quality=quality if quality is not None else 60,
                optimize=True,
                progressive=True,
                subsampling='4:2:0',
                exif=b'',
                icc_profile=b''
            )

        return output.getvalue()

    def compress_image(
        self,
        image_data: bytes,
        mode: str,
        max_width: Optional[int] = None,
        max_height: Optional[int] = None,
        quality: Optional[int] = None,
        output_format: str = 'auto',
        preloaded_image: Optional[Image.Image] = None
    ) -> Tuple[bytes, Dict]:
        """
        Compress an image using the specified mode and parameters.

        output_format: 'auto', 'webp', or 'jpeg'. In auto mode, transparent
        images are output as WebP to preserve transparency; opaque images
        become JPEG.  Ignored in lossless mode.
        """
        # Use preloaded image if available, otherwise open it
        if preloaded_image is not None:
            img = preloaded_image
        else:
            img = Image.open(io.BytesIO(image_data))

        # Apply EXIF orientation correction before anything else
        img = self._apply_exif_orientation(img)

        # Normalize non-standard color modes (CMYK, P, PA, I, 1)
        img = self._normalize_color_mode(img)

        # Convert to sRGB for web/high modes (lossless preserves original profile)
        if mode in ('web', 'high'):
            img = self._convert_to_srgb(img)

        original_format = img.format
        original_size = len(image_data)
        original_dimensions = img.size

        # Resolve output_format to use_webp / target_png bools
        format_warnings: List[str] = []
        has_transparency = self._has_transparency(img)
        target_png = False

        if mode == 'lossless' and output_format == 'auto':
            use_webp = False  # Preserves original format
        elif output_format == 'png':
            target_png = True
            use_webp = False
        elif output_format == 'webp':
            use_webp = True
        elif output_format == 'jpeg':
            use_webp = False
            if has_transparency:
                format_warnings.append(
                    "JPEG does not support transparency — transparent areas will become white"
                )
        else:  # 'auto' (non-lossless)
            use_webp = has_transparency
            if has_transparency:
                format_warnings.append(
                    "Transparent image detected — using WebP to preserve transparency"
                )

        # Resize if dimensions are provided
        if max_width or max_height:
            img = self._resize_image(img, max_width, max_height)

        # Apply compression based on mode
        # For explicit format targets, bypass mode dispatch with format-specific methods
        strip_metadata = mode != 'lossless'
        if target_png:
            compressed_data = self._save_as_png(img, strip_metadata=strip_metadata)
        elif mode == 'lossless' and output_format == 'webp':
            compressed_data = self._save_as_webp_lossless(img, strip_metadata=False)
        elif mode == 'lossless' and output_format == 'jpeg':
            compressed_data = self._save_as_jpeg_quality(img, quality, strip_metadata=False)
        else:
            compressed_data = self.compression_modes[mode](img, quality, use_webp)

        # Calculate compression ratio and prepare metadata
        compression_ratio = round(len(compressed_data) / original_size * 100, 2)

        # If high compression didn't achieve better than 50% reduction,
        # try more aggressive settings (don't increase quality above what was asked)
        if mode == 'high' and not target_png and compression_ratio > 50:
            retry_quality = min(quality, 30) if quality is not None else 30
            retry_data = self._compress_high(img, quality=retry_quality, use_webp=use_webp)
            retry_ratio = round(len(retry_data) / original_size * 100, 2)
            if retry_ratio < compression_ratio:
                compressed_data = retry_data
                compression_ratio = retry_ratio
                format_warnings.append(
                    "Applied aggressive compression retry to achieve target size reduction"
                )
            else:
                logger.info("High compression retry did not improve ratio (%.1f%% → %.1f%%)",
                            compression_ratio, retry_ratio)

        # Determine actual output format based on mode and settings
        if target_png:
            resolved_format = 'PNG'
        elif mode == 'lossless' and output_format in ('webp', 'jpeg'):
            resolved_format = output_format.upper()
        elif mode == 'lossless':
            resolved_format = original_format or 'PNG'
        elif use_webp:
            resolved_format = 'WEBP'
        else:
            resolved_format = 'JPEG'

        metadata = {
            'original_size': original_size,
            'compressed_size': len(compressed_data),
            'original_dimensions': original_dimensions,
            'final_dimensions': img.size,
            'compression_ratio': compression_ratio,
            'format': resolved_format,
            'original_format': original_format,
            'format_warnings': format_warnings
        }

        return compressed_data, metadata

    def _resize_image(self, img: Image.Image, max_width: Optional[int], max_height: Optional[int]) -> Image.Image:
        """Resize image maintaining aspect ratio"""
        if not max_width and not max_height:
            return img

        width, height = img.size
        if height == 0:
            return img
        aspect_ratio = width / height

        if max_width and max_height:
            if width > max_width or height > max_height:
                if max_width / max_height > aspect_ratio:
                    max_width = max(1, round(max_height * aspect_ratio))
                else:
                    max_height = max(1, round(max_width / aspect_ratio))
        elif max_width:
            max_height = max(1, round(max_width / aspect_ratio))
        else:  # max_height only
            max_width = max(1, round(max_height * aspect_ratio))

        if max_width < width or max_height < height:
            img = img.resize((max_width, max_height), Image.Resampling.LANCZOS)

        return img
