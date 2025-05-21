from PIL import Image, ImageDraw, ImageFont
import io
from typing import Tuple, Dict, Optional, List, Union
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
        use_webp: bool = False,
        watermark_text: Optional[str] = None,
        watermark_options: Optional[Dict] = None
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

        # Add watermark if text is provided
        if watermark_text:
            # Ensure image is in a mode that supports alpha for watermarking
            if img.mode not in ('RGBA', 'LA'):
                img = img.convert('RGBA')
            # Pass watermark_options as keyword arguments to add_watermark
            # If watermark_options is None, pass an empty dict to use default values
            self.add_watermark(img, watermark_text, **(watermark_options or {}))

        # Apply compression based on mode
        if mode == 'lossless':
            compressed_data = self._compress_lossless(img, quality=quality)
        elif mode == 'web':
            compressed_data = self._compress_web(img, quality=quality, use_webp=use_webp)
        elif mode == 'high':
            # For 'high' mode, determine if WebP should be used based on the 'use_webp' flag.
            # _compress_high itself might default to WebP, but this flag can override.
            compressed_data = self._compress_high(img, quality=quality, use_webp=use_webp)
        else:
            raise ValueError(f"Unknown compression mode: {mode}")
        
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

    def add_watermark(
        self,
        image: Image.Image,
        text: str,
        position: Union[Tuple[int, int], str] = 'bottom-right',
        font_path: Optional[str] = None,
        font_size: int = 36,
        color: Tuple[int, int, int, int] = (255, 255, 255, 128), # Default: semi-transparent white
        opacity: Optional[int] = None # Overrides alpha in color if provided (0-255)
    ):
        """
        Adds a text watermark to an image.
        """
        if image.mode != 'RGBA': # Ensure image can handle alpha for opacity
            image = image.convert('RGBA')

        draw = ImageDraw.Draw(image, 'RGBA') # Create a drawing context

        # Determine the final color and opacity for the text
        final_color_rgb = color[:3]
        # Use opacity arg if provided, else use alpha from color tuple, else default (128 from default color)
        alpha = opacity if opacity is not None else (color[3] if len(color) == 4 else 128)
        alpha = max(0, min(255, int(alpha))) # Clamp alpha to 0-255
        final_color = final_color_rgb + (alpha,)

        # Load font
        try:
            if font_path:
                font = ImageFont.truetype(font_path, font_size)
            else: # Try common system fonts before Pillow's default bitmap font
                common_fonts = ["arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf", "Helvetica.ttf"]
                font_loaded = False
                for cf_name in common_fonts:
                    try:
                        font = ImageFont.truetype(cf_name, font_size)
                        font_loaded = True
                        break
                    except IOError:
                        continue
                if not font_loaded:
                    font = ImageFont.load_default()
                    print(f"Warning: Common system fonts not found. Using default Pillow bitmap font. `font_size` may not apply accurately.")
        except IOError: # Catch error if specified font_path is not found
            font = ImageFont.load_default()
            print(f"Warning: Font not found at '{font_path}'. Using default Pillow bitmap font. `font_size` may not apply accurately.")
        
        # Calculate text size using textbbox for accuracy if available
        try:
            # For Pillow 9.2.0+ textbbox is preferred. anchor 'lt' means (x,y) is top-left of bbox.
            bbox = draw.textbbox((0, 0), text, font=font, anchor='lt')
            text_width = bbox[2] - bbox[0]
            text_height = bbox[3] - bbox[1]
        except (TypeError, AttributeError): # Fallback for older Pillow versions
            # textsize is less accurate but widely available
            text_size_legacy = draw.textsize(text, font=font)
            text_width = text_size_legacy[0]
            text_height = text_size_legacy[1]

        img_width, img_height = image.size
        margin = 10 # Margin from image edges

        # Determine (x, y) coordinates for the top-left of the text
        if isinstance(position, str):
            pos_keyword = position.lower()
            if pos_keyword == 'center':
                x = (img_width - text_width) / 2
                y = (img_height - text_height) / 2
            elif pos_keyword == 'top-left':
                x = margin
                y = margin
            elif pos_keyword == 'top-right':
                x = img_width - text_width - margin
                y = margin
            elif pos_keyword == 'bottom-left':
                x = margin
                y = img_height - text_height - margin
            elif pos_keyword == 'bottom-right':
                x = img_width - text_width - margin
                y = img_height - text_height - margin
            else: # Default to bottom-right for unknown keywords
                print(f"Warning: Unknown position keyword '{position}'. Defaulting to bottom-right.")
                x = img_width - text_width - margin
                y = img_height - text_height - margin
        elif isinstance(position, tuple) and len(position) == 2 and all(isinstance(coord, (int, float)) for coord in position):
            x, y = position
        else: # Default to bottom-right for invalid position types
            print(f"Warning: Invalid position '{position}'. Defaulting to bottom-right.")
            x = img_width - text_width - margin
            y = img_height - text_height - margin

        # Ensure coordinates are integers for drawing
        draw_x, draw_y = int(x), int(y)

        # Draw the text
        # The (draw_x, draw_y) is the top-left starting point of the text.
        draw.text((draw_x, draw_y), text, font=font, fill=final_color)
        return image # Return the modified image
