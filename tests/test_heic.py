"""Tests for HEIC/HEIF input support: validation, compression modes, crop, and routes."""
import base64
import io
import json

import pytest
from PIL import Image
from werkzeug.datastructures import FileStorage

from app.compression.image_processor import ImageCompressor
from app.validators import validate_file


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_heif_image(size=(300, 200), color=(0, 128, 0), mode='RGB'):
    """Create an in-memory HEIF image and return its bytes.

    Uses pillow-heif write capability purely for test fixture generation.
    """
    img = Image.new(mode, size, color)
    buf = io.BytesIO()
    img.save(buf, format='HEIF', quality=90)
    return buf.getvalue()


def make_file_storage(image_bytes, filename='photo.heic'):
    """Wrap image bytes in a FileStorage object for validate_file()."""
    return FileStorage(
        stream=io.BytesIO(image_bytes),
        filename=filename,
        content_type='image/heic',
    )


def b64(image_bytes):
    return base64.b64encode(image_bytes).decode('ascii')


# ===========================================================================
# validate_file — extension gate
# ===========================================================================

class TestValidateFileExtension:

    def test_heic_extension_accepted(self):
        data = make_heif_image()
        fs = make_file_storage(data, 'photo.heic')
        ok, err = validate_file(fs)
        assert ok is True and err is None

    def test_heif_extension_accepted(self):
        data = make_heif_image()
        fs = make_file_storage(data, 'photo.heif')
        ok, err = validate_file(fs)
        assert ok is True and err is None

    def test_heic_uppercase_accepted(self):
        data = make_heif_image()
        fs = make_file_storage(data, 'IMG_1234.HEIC')
        ok, err = validate_file(fs)
        assert ok is True and err is None


# ===========================================================================
# validate_image — format remap
# ===========================================================================

class TestValidateImage:

    @pytest.fixture(autouse=True)
    def _compressor(self):
        self.compressor = ImageCompressor(max_file_size_mb=50)

    def test_heif_remapped_to_png(self):
        """HEIF format should be remapped to PNG for lossless preservation."""
        data = make_heif_image()
        result = self.compressor.validate_image(data)
        assert result.is_valid is True
        assert result.image is not None
        assert result.image.format == 'PNG'

    def test_heif_image_dimensions_preserved(self):
        """Image dimensions survive the decode without loss."""
        data = make_heif_image(size=(640, 480))
        result = self.compressor.validate_image(data)
        assert result.image.size == (640, 480)

    def test_heif_rgb_mode(self):
        """Standard HEIC decodes to RGB mode."""
        data = make_heif_image(mode='RGB')
        result = self.compressor.validate_image(data)
        assert result.image.mode == 'RGB'

    def test_heif_no_errors_or_warnings(self):
        data = make_heif_image()
        result = self.compressor.validate_image(data)
        assert result.errors == []


# ===========================================================================
# Compression modes with HEIF input
# ===========================================================================

class TestCompressionModes:

    @pytest.fixture(autouse=True)
    def _compressor(self):
        self.compressor = ImageCompressor(max_file_size_mb=50)

    def _open_heif(self):
        """Return a Pillow Image from HEIF data with format already remapped."""
        data = make_heif_image(size=(300, 200), color=(100, 150, 200))
        result = self.compressor.validate_image(data)
        return data, result.image

    def test_lossless_auto_outputs_png(self):
        """Lossless + auto format: HEIF input should produce PNG output."""
        data = make_heif_image(size=(200, 150))
        compressed, meta = self.compressor.compress_image(data, mode='lossless')
        assert meta['format'] == 'PNG'
        assert meta['original_format'] == 'HEIF'
        # Verify the output is a valid PNG
        img = Image.open(io.BytesIO(compressed))
        assert img.format == 'PNG'
        assert img.size == (200, 150)

    def test_lossless_explicit_webp(self):
        """Lossless + explicit WebP: output should be lossless WebP."""
        data = make_heif_image(size=(200, 150))
        compressed, meta = self.compressor.compress_image(
            data, mode='lossless', output_format='webp')
        assert meta['format'] == 'WEBP'
        assert meta['original_format'] == 'HEIF'

    def test_lossless_explicit_jpeg(self):
        """Lossless + explicit JPEG: output should be JPEG."""
        data = make_heif_image(size=(200, 150))
        compressed, meta = self.compressor.compress_image(
            data, mode='lossless', output_format='jpeg')
        assert meta['format'] == 'JPEG'
        assert meta['original_format'] == 'HEIF'

    def test_balanced_outputs_jpeg_or_webp(self):
        """Balanced mode: HEIF input converts to JPEG or WebP."""
        data = make_heif_image(size=(200, 150))
        compressed, meta = self.compressor.compress_image(data, mode='web')
        assert meta['format'] in ('JPEG', 'WEBP')
        assert meta['original_format'] == 'HEIF'

    def test_maximum_outputs_jpeg_or_webp(self):
        """Maximum mode: HEIF input converts to JPEG or WebP."""
        data = make_heif_image(size=(200, 150))
        compressed, meta = self.compressor.compress_image(data, mode='high')
        assert meta['format'] in ('JPEG', 'WEBP')
        assert meta['original_format'] == 'HEIF'

    def test_lossless_pixel_preservation(self):
        """Verify pixel data is preserved through lossless HEIF→PNG pipeline."""
        # Create HEIF with known solid color
        data = make_heif_image(size=(50, 50), color=(200, 100, 50))

        # Decode the HEIF to get reference pixel values
        ref_img = Image.open(io.BytesIO(data))
        ref_pixel = ref_img.getpixel((25, 25))

        # Process through lossless pipeline
        compressed, meta = self.compressor.compress_image(data, mode='lossless')
        result_img = Image.open(io.BytesIO(compressed))
        result_pixel = result_img.getpixel((25, 25))

        # PNG is lossless — pixels must match exactly
        assert result_pixel == ref_pixel


# ===========================================================================
# Crop with HEIF-origin image
# ===========================================================================

class TestCropAfterHeif:

    @pytest.fixture(autouse=True)
    def _compressor(self):
        self.compressor = ImageCompressor(max_file_size_mb=50)

    def test_crop_after_heif_lossless(self):
        """Process HEIF lossless (→PNG), then crop the result."""
        data = make_heif_image(size=(400, 300))
        compressed, meta = self.compressor.compress_image(data, mode='lossless')
        assert meta['format'] == 'PNG'

        # Crop the PNG output
        cropped, crop_meta = self.compressor.crop_image(
            compressed, 50, 25, 200, 150)
        assert crop_meta['format'] == 'PNG'
        assert crop_meta['final_dimensions'] == (200, 150)

        img = Image.open(io.BytesIO(cropped))
        assert img.size == (200, 150)

    def test_crop_after_heif_balanced(self):
        """Process HEIF balanced (→JPEG/WebP), then crop the result."""
        data = make_heif_image(size=(400, 300))
        compressed, meta = self.compressor.compress_image(data, mode='web')

        cropped, crop_meta = self.compressor.crop_image(
            compressed, 0, 0, 100, 100)
        assert crop_meta['format'] in ('JPEG', 'WEBP')
        assert crop_meta['final_dimensions'] == (100, 100)


# ===========================================================================
# /process route with HEIF
# ===========================================================================

class TestProcessRoute:

    def test_process_heic_lossless(self, auth_client):
        """POST .heic file to /process with lossless mode → 200, PNG output."""
        data = make_heif_image(size=(200, 150))
        resp = auth_client.post('/process',
            data={
                'file': (io.BytesIO(data), 'photo.heic'),
                'compression_mode': 'lossless',
            },
            content_type='multipart/form-data')
        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['format'] == 'PNG'
        assert body['metadata']['original_format'] == 'HEIF'
        assert body['metadata']['original_dimensions'] == [200, 150]

    def test_process_heif_extension(self, auth_client):
        """POST .heif file to /process → accepted."""
        data = make_heif_image(size=(200, 150))
        resp = auth_client.post('/process',
            data={
                'file': (io.BytesIO(data), 'photo.heif'),
                'compression_mode': 'lossless',
            },
            content_type='multipart/form-data')
        assert resp.status_code == 200

    def test_process_heic_balanced(self, auth_client):
        """POST .heic file with balanced mode → JPEG or WebP output."""
        data = make_heif_image(size=(200, 150))
        resp = auth_client.post('/process',
            data={
                'file': (io.BytesIO(data), 'photo.heic'),
                'compression_mode': 'web',
            },
            content_type='multipart/form-data')
        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['format'] in ('JPEG', 'WEBP')
        assert body['metadata']['original_format'] == 'HEIF'

    def test_process_heic_maximum(self, auth_client):
        """POST .heic file with maximum mode → JPEG or WebP output."""
        data = make_heif_image(size=(200, 150))
        resp = auth_client.post('/process',
            data={
                'file': (io.BytesIO(data), 'photo.heic'),
                'compression_mode': 'high',
            },
            content_type='multipart/form-data')
        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['format'] in ('JPEG', 'WEBP')

    def test_process_then_crop_heic(self, auth_client):
        """Full pipeline: /process HEIC → /crop the result."""
        data = make_heif_image(size=(400, 300))
        process_resp = auth_client.post('/process',
            data={
                'file': (io.BytesIO(data), 'photo.heic'),
                'compression_mode': 'lossless',
            },
            content_type='multipart/form-data')
        assert process_resp.status_code == 200
        process_body = process_resp.get_json()

        crop_resp = auth_client.post('/crop',
            data=json.dumps({
                'compressed_data': process_body['compressed_data'],
                'filename': process_body['filename'],
                'crop': {'x': 50, 'y': 25, 'width': 200, 'height': 150},
            }),
            content_type='application/json')
        assert crop_resp.status_code == 200
        crop_body = crop_resp.get_json()
        assert crop_body['metadata']['final_dimensions'] == [200, 150]
        assert crop_body['metadata']['format'] == 'PNG'

    def test_process_heic_with_resize(self, auth_client):
        """HEIC file with resize parameters."""
        data = make_heif_image(size=(800, 600))
        resp = auth_client.post('/process',
            data={
                'file': (io.BytesIO(data), 'photo.heic'),
                'compression_mode': 'lossless',
                'resize_mode': 'custom',
                'max_width': '400',
            },
            content_type='multipart/form-data')
        assert resp.status_code == 200
        body = resp.get_json()
        # Should be resized (aspect ratio preserved)
        dims = body['metadata']['final_dimensions']
        assert dims[0] <= 400
