from PIL import Image, ImageOps, ImageCms, ImageDraw, ImageFont
import io
import logging
import threading
from pathlib import Path
from functools import lru_cache
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


class BackgroundRemovalError(CompressionError):
    """Raised when background removal fails"""
    pass


@dataclass
class ValidationResult:
    is_valid: bool
    errors: List[str]
    warnings: List[str]
    image: Optional[Image.Image] = None  # Return the opened image to avoid reopening


class ImageCompressor:
    _FONT_PATH = Path(__file__).parent / 'fonts' / 'Inter-SemiBold.ttf'
    MAX_PIXELS = 40_000_000  # ~8000×5000 — reject to prevent decompression bombs
    _background_session = None
    _background_session_lock = threading.Lock()

    def __init__(self, max_file_size_mb: int = 10):
        self.max_file_size = max_file_size_mb * 1024 * 1024  # Convert MB to bytes
        self.compression_modes = {
            'lossless': self._compress_lossless,
            'web': self._compress_web,
            'high': self._compress_high
        }

    @staticmethod
    @lru_cache(maxsize=32)
    def _get_font(size: int) -> ImageFont.FreeTypeFont:
        """Load and cache font at the given pixel size (thread-safe via lru_cache)."""
        return ImageFont.truetype(str(ImageCompressor._FONT_PATH), size)

    @staticmethod
    def _get_text_watermark_font_px(width: int, height: int, relative_size: int) -> int:
        return max(12, int(min(width, height) * relative_size * 0.5 / 100))

    @staticmethod
    def _get_text_watermark_margin(font_px: int) -> int:
        return int(font_px * 0.75)

    @staticmethod
    def _get_image_watermark_max_side(width: int, height: int, relative_size: int) -> int:
        return max(24, round(min(width, height) * relative_size * 1.2 / 100))

    @staticmethod
    def _get_image_watermark_margin(width: int, height: int) -> int:
        return max(12, round(min(width, height) * 0.02))

    @staticmethod
    def _measure_text_bbox(text: str, font: ImageFont.FreeTypeFont) -> Tuple[int, int]:
        tmp_draw = ImageDraw.Draw(Image.new('RGBA', (1, 1), (0, 0, 0, 0)))
        bbox = tmp_draw.textbbox((0, 0), text, font=font)
        return bbox[2] - bbox[0], bbox[3] - bbox[1]

    @staticmethod
    def _get_tile_spacing(stamp_w: int, stamp_h: int, tile_density: int) -> Tuple[int, int]:
        spacing_mult = 4.0 - (tile_density - 1) * (2.9 / 9)
        return (
            max(stamp_w + 1, int(stamp_w * spacing_mult)),
            max(stamp_h + 1, int(stamp_h * spacing_mult)),
        )

    @classmethod
    def _paste_tiled_stamp(cls, overlay: Image.Image, stamp: Image.Image,
                           img_w: int, img_h: int, tile_density: int) -> None:
        spacing_x, spacing_y = cls._get_tile_spacing(stamp.width, stamp.height, tile_density)

        for row, y in enumerate(range(-stamp.height, img_h + stamp.height, spacing_y)):
            x_offset = (spacing_x // 2) * (row % 2)
            for x in range(-stamp.width + x_offset, img_w + stamp.width, spacing_x):
                overlay.paste(stamp, (x, y), stamp)

    def _apply_text_watermark(self, img: Image.Image, text: str, position: str = 'bottom-right',
                              opacity: int = 50, color: str = 'white',
                              relative_size: int = 5,
                              tile_density: int = 5,
                              angle: int = 0) -> Tuple[Image.Image, bool]:
        """Apply text watermark onto the image using an RGBA overlay.
        Returns (image, was_applied) tuple.
        angle: rotation in degrees, positive = clockwise visual rotation."""
        w, h = img.size

        # Skip if image too small
        if min(w, h) < 50:
            logger.info("Image too small for watermark (%dx%d), skipping", w, h)
            return img, False

        # Calculate font size relative to shorter dimension
        font_px = self._get_text_watermark_font_px(w, h, relative_size)
        font = self._get_font(font_px)

        # Resolve color
        if color == 'auto':
            fill_rgb = self._auto_watermark_color(img, position, font, text, font_px)
        else:
            fill_rgb = (255, 255, 255) if color == 'white' else (0, 0, 0)

        shadow_rgb = (0, 0, 0) if fill_rgb == (255, 255, 255) else (255, 255, 255)

        # Scale opacity
        main_alpha = int(255 * opacity / 100)
        shadow_alpha = int(main_alpha * 0.5)
        shadow_offset = max(1, font_px // 20)

        # Create RGBA overlay
        original_mode = img.mode
        if img.mode != 'RGBA':
            img = img.convert('RGBA')

        overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))

        if position == 'tiled':
            self._draw_tiled_watermark(overlay, text, font, font_px, w, h,
                                       fill_rgb, main_alpha, shadow_rgb, shadow_alpha,
                                       shadow_offset, tile_density, angle)
        else:
            draw = ImageDraw.Draw(overlay)
            # Single watermark
            tw, th = self._measure_text_bbox(text, font)
            margin = self._get_text_watermark_margin(font_px)

            if angle == 0:
                # No rotation — draw directly (preserves exact current rendering)
                x, y = self._calc_watermark_position(position, w, h, tw, th, margin)
                draw.text((x + shadow_offset, y + shadow_offset), text,
                          font=font, fill=(*shadow_rgb, shadow_alpha))
                draw.text((x, y), text, font=font, fill=(*fill_rgb, main_alpha))
            else:
                # Create a stamp, rotate, and paste at calculated position
                stamp_w = tw + font_px
                stamp_h = th + font_px
                stamp = Image.new('RGBA', (stamp_w, stamp_h), (0, 0, 0, 0))
                stamp_draw = ImageDraw.Draw(stamp)
                tx = (stamp_w - tw) // 2
                ty = (stamp_h - th) // 2
                stamp_draw.text((tx + shadow_offset, ty + shadow_offset), text,
                                font=font, fill=(*shadow_rgb, shadow_alpha))
                stamp_draw.text((tx, ty), text, font=font, fill=(*fill_rgb, main_alpha))

                # Negate angle for PIL's CCW convention (positive = clockwise visual)
                rotated = stamp.rotate(-angle, expand=True, resample=Image.Resampling.BICUBIC)
                rw, rh = rotated.size

                # Calculate position using rotated dimensions
                x, y = self._calc_watermark_position(position, w, h, rw, rh, margin)
                overlay.paste(rotated, (x, y), rotated)

        img = Image.alpha_composite(img, overlay)

        # Convert back to original mode if needed
        if original_mode != 'RGBA':
            img = img.convert(original_mode)

        return img, True

    def _auto_watermark_color(self, img: Image.Image, position: str,
                              font: ImageFont.FreeTypeFont, text: str,
                              font_px: int) -> Tuple[int, int, int]:
        """Sample the target area luminance and pick white or black for contrast."""
        w, h = img.size
        rgb_img = img.convert('RGB') if img.mode != 'RGB' else img

        if position == 'tiled' or position == 'center':
            # Sample center region
            cx, cy = w // 2, h // 2
            region_size = min(w, h) // 4
            box = (max(0, cx - region_size), max(0, cy - region_size),
                   min(w, cx + region_size), min(h, cy + region_size))
        else:
            # Sample the corner where watermark will be placed
            margin = self._get_text_watermark_margin(font_px)
            # Use a rough text size estimate
            sample_w = min(w // 3, len(text) * font_px)
            sample_h = font_px * 2

            if 'right' in position:
                x1 = max(0, w - margin - sample_w)
                x2 = w
            else:
                x1 = 0
                x2 = min(w, margin + sample_w)

            if 'bottom' in position:
                y1 = max(0, h - margin - sample_h)
                y2 = h
            else:
                y1 = 0
                y2 = min(h, margin + sample_h)

            box = (x1, y1, x2, y2)

        region = rgb_img.crop(box)
        # Average luminance (simple grayscale average)
        gray = region.convert('L')
        avg_luminance = self._average_luminance(gray)

        return (255, 255, 255) if avg_luminance < 128 else (0, 0, 0)

    @staticmethod
    def _calc_watermark_position(position: str, img_w: int, img_h: int,
                                 text_w: int, text_h: int, margin: int) -> Tuple[int, int]:
        """Calculate (x, y) for watermark placement."""
        positions = {
            'bottom-right': (img_w - text_w - margin, img_h - text_h - margin),
            'bottom-left': (margin, img_h - text_h - margin),
            'top-right': (img_w - text_w - margin, margin),
            'top-left': (margin, margin),
            'center': ((img_w - text_w) // 2, (img_h - text_h) // 2),
        }
        return positions.get(position, positions['bottom-right'])

    @staticmethod
    def _draw_tiled_watermark(overlay: Image.Image, text: str,
                              font: ImageFont.FreeTypeFont, font_px: int,
                              img_w: int, img_h: int,
                              fill_rgb: Tuple[int, int, int], main_alpha: int,
                              shadow_rgb: Tuple[int, int, int], shadow_alpha: int,
                              shadow_offset: int, tile_density: int = 5,
                              angle: int = 0):
        """Draw repeating watermark text across the entire image.
        angle: rotation in degrees, positive = clockwise visual rotation."""
        tw, th = ImageCompressor._measure_text_bbox(text, font)

        # Negate angle for PIL's CCW convention (positive = clockwise visual)
        pil_angle = -angle

        # Padded stamp canvas
        stamp_w = tw + font_px
        stamp_h = th + font_px
        stamp = Image.new('RGBA', (stamp_w, stamp_h), (0, 0, 0, 0))
        stamp_draw = ImageDraw.Draw(stamp)

        # Center text in stamp
        tx = (stamp_w - tw) // 2
        ty = (stamp_h - th) // 2

        stamp_draw.text((tx + shadow_offset, ty + shadow_offset), text,
                        font=font, fill=(*shadow_rgb, shadow_alpha))
        stamp_draw.text((tx, ty), text, font=font, fill=(*fill_rgb, main_alpha))

        # Rotate stamp
        rotated = stamp.rotate(pil_angle, expand=True, resample=Image.Resampling.BICUBIC)
        ImageCompressor._paste_tiled_stamp(overlay, rotated, img_w, img_h, tile_density)

    @staticmethod
    def _scaled_watermark_size(img: Image.Image, max_side: int) -> Tuple[int, int]:
        width, height = img.size
        longest_side = max(width, height) or 1
        scale = min(1.0, max_side / longest_side)
        return max(1, round(width * scale)), max(1, round(height * scale))

    def _create_image_watermark_stamp(self, img: Image.Image, max_side: int, opacity: int) -> Image.Image:
        rgba = img.convert('RGBA')
        width, height = self._scaled_watermark_size(rgba, max_side)
        if rgba.size != (width, height):
            rgba = rgba.resize((width, height), Image.Resampling.LANCZOS)

        if opacity < 100:
            alpha = rgba.getchannel('A').point(lambda value: int(value * opacity / 100))
            rgba.putalpha(alpha)

        return rgba

    def _apply_image_watermark(self, img: Image.Image,
                               stamp_source: Image.Image,
                               position: str = 'bottom-right',
                               opacity: int = 50,
                               relative_size: int = 5,
                               tile_density: int = 5,
                               angle: int = 0) -> Tuple[Image.Image, bool]:
        w, h = img.size

        if min(w, h) < 50:
            logger.info("Image too small for watermark (%dx%d), skipping", w, h)
            return img, False

        max_side = self._get_image_watermark_max_side(w, h, relative_size)
        stamp = self._create_image_watermark_stamp(stamp_source, max_side, opacity)
        rotated = stamp.rotate(-angle, expand=True, resample=Image.Resampling.BICUBIC) if angle else stamp

        original_mode = img.mode
        if img.mode != 'RGBA':
            img = img.convert('RGBA')

        overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))

        if position == 'tiled':
            self._paste_tiled_stamp(overlay, rotated, w, h, tile_density)
        else:
            margin = self._get_image_watermark_margin(w, h)
            x, y = self._calc_watermark_position(position, w, h, rotated.width, rotated.height, margin)
            overlay.paste(rotated, (x, y), rotated)

        img = Image.alpha_composite(img, overlay)

        if original_mode != 'RGBA':
            img = img.convert(original_mode)

        return img, True

    def _apply_watermark_layers(self, img: Image.Image,
                                watermark_layers: Optional[Dict[str, Dict]]) -> Tuple[Image.Image, bool, List[str]]:
        if not watermark_layers:
            return img, False, []

        applied_layers: List[str] = []

        text_layer = watermark_layers.get('text')
        if text_layer and text_layer.get('value'):
            img, applied = self._apply_text_watermark(
                img,
                text_layer['value'],
                text_layer.get('position', 'bottom-right'),
                text_layer.get('opacity', 50),
                text_layer.get('color', 'white'),
                text_layer.get('size', 5),
                text_layer.get('tile_density', 5),
                text_layer.get('angle', 0),
            )
            if applied:
                applied_layers.append('text')

        logo_layer = watermark_layers.get('logo')
        if logo_layer and logo_layer.get('image') is not None:
            img, applied = self._apply_image_watermark(
                img,
                logo_layer['image'],
                logo_layer.get('position', 'bottom-right'),
                logo_layer.get('opacity', 50),
                logo_layer.get('size', 5),
                logo_layer.get('tile_density', 5),
                logo_layer.get('angle', 0),
            )
            if applied:
                applied_layers.append('logo')

        qr_layer = watermark_layers.get('qr')
        if qr_layer and qr_layer.get('image') is not None and qr_layer.get('url'):
            img, applied = self._apply_image_watermark(
                img,
                qr_layer['image'],
                qr_layer.get('position', 'bottom-right'),
                qr_layer.get('opacity', 50),
                qr_layer.get('size', 5),
                qr_layer.get('tile_density', 5),
                qr_layer.get('angle', 0),
            )
            if applied:
                applied_layers.append('qr')

        return img, bool(applied_layers), applied_layers

    @staticmethod
    def _average_luminance(gray_image: Image.Image) -> float:
        histogram = gray_image.histogram()
        total_pixels = max(1, sum(histogram))
        total_luminance = sum(value * count for value, count in enumerate(histogram))
        return total_luminance / total_pixels

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

    @classmethod
    def _get_background_removal_session(cls):
        """Create the rembg session lazily per worker process."""
        if cls._background_session is not None:
            return cls._background_session

        with cls._background_session_lock:
            if cls._background_session is not None:
                return cls._background_session

            try:
                from rembg import new_session
            except ImportError as exc:
                logger.exception("rembg dependency is unavailable during session initialization")
                raise BackgroundRemovalError("Background removal dependency is unavailable") from exc

            try:
                cls._background_session = new_session()
            except Exception as exc:
                logger.exception("Could not initialize rembg background removal session")
                raise BackgroundRemovalError("Could not initialize background removal model") from exc

        return cls._background_session

    def _apply_background_removal(self, img: Image.Image) -> Tuple[Image.Image, List[str]]:
        """Remove the image background and return an RGBA result."""
        try:
            from rembg import remove
        except ImportError as exc:
            logger.exception("rembg dependency is unavailable during background removal")
            raise BackgroundRemovalError("Background removal dependency is unavailable") from exc

        session = self._get_background_removal_session()

        # rembg.remove() accepts PIL Images directly and returns a PIL Image,
        # avoiding an unnecessary PNG encode → decode round-trip.
        prepared = img if img.mode in ('RGB', 'RGBA') else img.convert('RGB')

        try:
            removed = remove(prepared, session=session, post_process_mask=True)
        except Exception as exc:
            logger.exception("rembg background removal call failed")
            raise BackgroundRemovalError("Background removal failed") from exc

        if removed.mode != 'RGBA':
            removed = removed.convert('RGBA')
        removed.format = 'PNG'

        warnings: List[str] = []
        if not self._has_transparency(removed):
            warnings.append(
                "Background removal completed, but no transparent pixels were detected"
            )

        return removed, warnings

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

            # MPO (Multi-Picture Object) is JPEG with extra frames (common in smartphone photos)
            if img.format == 'MPO':
                img.format = 'JPEG'

            # HEIF/HEIC: remap to PNG for lossless pixel preservation
            # (pillow-heif decodes to standard RGB/RGBA; we never output HEIF)
            if img.format == 'HEIF':
                img._source_format = 'HEIF'
                img.format = 'PNG'

            # Check format
            if img.format not in ['JPEG', 'PNG', 'WEBP', 'TIFF']:
                errors.append(f"Unsupported image format: {img.format}")

            # Reject decompression bombs
            width, height = img.size
            if width * height > self.MAX_PIXELS:
                errors.append(
                    f"Image dimensions too large ({width}x{height}). "
                    f"Maximum is {self.MAX_PIXELS:,} pixels"
                )

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
        preloaded_image: Optional[Image.Image] = None,
        watermark_layers: Optional[Dict[str, Dict]] = None,
        remove_background: bool = False,
    ) -> Tuple[bytes, Dict]:
        """
        Compress an image using the specified mode and parameters.

        output_format: 'auto', 'webp', 'jpeg', or 'png'. In auto mode, transparent
        images are output as WebP to preserve transparency; opaque images
        become JPEG.  Ignored in lossless mode.
        """
        # Use preloaded image if available, otherwise open it
        if preloaded_image is not None:
            img = preloaded_image
            # Capture true source format before transforms may discard it
            source_format = getattr(img, '_source_format', None)
        else:
            img = Image.open(io.BytesIO(image_data))
            # Remap non-native input formats (mirrors validate_image logic)
            source_format = img.format if img.format == 'HEIF' else None
            if img.format == 'HEIF':
                img.format = 'PNG'

        # Apply EXIF orientation correction before anything else
        img = self._apply_exif_orientation(img)

        # Normalize non-standard color modes (CMYK, P, PA, I, 1)
        img = self._normalize_color_mode(img)

        # Convert to sRGB when lossy processing or ML background removal is used.
        if mode in ('web', 'high') or remove_background:
            img = self._convert_to_srgb(img)

        original_format = img.format
        original_size = len(image_data)
        original_dimensions = img.size

        # Resize if dimensions are provided
        if max_width or max_height:
            img = self._resize_image(img, max_width, max_height)

        format_warnings: List[str] = []
        background_removed = False
        if remove_background:
            img, background_warnings = self._apply_background_removal(img)
            format_warnings.extend(background_warnings)
            background_removed = self._has_transparency(img)
            target_png = True
            use_webp = False
        else:
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

        # Apply watermark after resize, before compression
        watermark_applied = False
        applied_watermark_layers: List[str] = []
        if watermark_layers:
            img, watermark_applied, applied_watermark_layers = self._apply_watermark_layers(
                img,
                watermark_layers,
            )

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
            'original_format': source_format or original_format,
            'format_warnings': format_warnings,
            'background_removed': background_removed,
            'watermarked': watermark_applied,
            'watermark_layers': applied_watermark_layers,
        }

        return compressed_data, metadata

    def crop_image(self, image_data: bytes, x: int, y: int,
                   width: int, height: int,
                   preloaded_image: Optional[Image.Image] = None) -> Tuple[bytes, Dict]:
        """
        Crop an already-processed image and re-encode in the same format.
        Coordinates are in actual image pixels.
        Returns (cropped_bytes, metadata).
        """
        img = preloaded_image if preloaded_image is not None else Image.open(io.BytesIO(image_data))
        original_format = img.format or 'PNG'
        original_size = len(image_data)
        original_dimensions = img.size

        img_w, img_h = img.size
        if x < 0 or y < 0 or width < 1 or height < 1:
            raise ImageValidationError("Invalid crop coordinates")
        if x + width > img_w or y + height > img_h:
            raise ImageValidationError(
                f"Crop region ({x},{y},{width},{height}) exceeds image bounds ({img_w}x{img_h})"
            )

        cropped = img.crop((x, y, x + width, y + height))

        # Re-encode in the same format with high quality
        output = io.BytesIO()
        fmt = original_format.upper()
        if fmt in ('JPEG', 'JPG'):
            save_img = self._remove_transparency(cropped)
            if save_img.mode != 'RGB':
                save_img = save_img.convert('RGB')
            save_img.save(output, format='JPEG', quality=95,
                          optimize=True, progressive=True)
            resolved_format = 'JPEG'
        elif fmt == 'WEBP':
            if cropped.mode not in ('RGB', 'RGBA'):
                cropped = cropped.convert('RGB')
            cropped.save(output, format='WEBP', quality=95, method=4)
            resolved_format = 'WEBP'
        elif fmt == 'TIFF':
            cropped.save(output, format='TIFF', compression='tiff_adobe_deflate')
            resolved_format = 'TIFF'
        else:
            cropped.save(output, format='PNG', optimize=True, compress_level=9)
            resolved_format = 'PNG'

        cropped_data = output.getvalue()

        is_full_image = (x == 0 and y == 0 and width == img_w and height == img_h)
        metadata = {
            'original_size': original_size,
            'compressed_size': len(cropped_data),
            'original_dimensions': original_dimensions,
            'final_dimensions': (width, height),
            'format': resolved_format,
            'cropped': not is_full_image,
        }

        return cropped_data, metadata

    def rotate_image(self, img: Image.Image, angle: int) -> Image.Image:
        """
        Rotate an image by 90-degree increments (clockwise).
        Uses Image.transpose() for lossless rotation without interpolation.

        Args:
            img: PIL Image object
            angle: Rotation angle (0, 90, 180, 270) in degrees clockwise

        Returns:
            Rotated PIL Image object with format preserved
        """
        if angle == 0:
            return img

        original_format = img.format

        # PIL's transpose rotates counter-clockwise, so we invert:
        # CW 90  -> PIL ROTATE_270
        # CW 180 -> PIL ROTATE_180
        # CW 270 -> PIL ROTATE_90
        transpose_map = {
            90: Image.Transpose.ROTATE_270,
            180: Image.Transpose.ROTATE_180,
            270: Image.Transpose.ROTATE_90,
        }

        operation = transpose_map.get(angle)
        if operation is None:
            raise ImageValidationError(f"Invalid rotation angle: {angle}")

        rotated = img.transpose(operation)
        rotated.format = original_format
        return rotated

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
