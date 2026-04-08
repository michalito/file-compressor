"""Tests for the crop feature: validators, ImageCompressor.crop_image, and /crop route."""
import base64
import io
import json

import pytest
from PIL import Image

from app.compression.image_processor import ImageCompressor, ImageValidationError
from app.validators import validate_crop_coordinates, validate_rotation


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_image(fmt='JPEG', size=(300, 200), color=(0, 128, 0), mode='RGB'):
    """Create an in-memory image and return its bytes."""
    img = Image.new(mode, size, color)
    buf = io.BytesIO()
    save_kwargs = {'format': fmt}
    if fmt == 'JPEG':
        save_kwargs['quality'] = 95
    img.save(buf, **save_kwargs)
    return buf.getvalue()


def b64(image_bytes):
    return base64.b64encode(image_bytes).decode('ascii')


def crop_payload(image_bytes, filename, x, y, w, h, rotation=0):
    payload = {
        'compressed_data': b64(image_bytes),
        'filename': filename,
        'crop': {'x': x, 'y': y, 'width': w, 'height': h},
    }
    if rotation:
        payload['rotation'] = rotation
    return json.dumps(payload)


# ===========================================================================
# validate_crop_coordinates
# ===========================================================================

class TestValidateCropCoordinates:

    def test_valid_crop(self):
        ok, err = validate_crop_coordinates(10, 20, 100, 80, 200, 200)
        assert ok is True and err is None

    def test_full_image(self):
        ok, err = validate_crop_coordinates(0, 0, 200, 200, 200, 200)
        assert ok is True

    def test_single_pixel(self):
        ok, err = validate_crop_coordinates(0, 0, 1, 1, 100, 100)
        assert ok is True

    def test_exceeds_width(self):
        ok, err = validate_crop_coordinates(150, 0, 100, 50, 200, 200)
        assert ok is False
        assert 'width' in err

    def test_exceeds_height(self):
        ok, err = validate_crop_coordinates(0, 150, 50, 100, 200, 200)
        assert ok is False
        assert 'height' in err

    def test_zero_width(self):
        ok, err = validate_crop_coordinates(0, 0, 0, 50, 200, 200)
        assert ok is False

    def test_zero_height(self):
        ok, err = validate_crop_coordinates(0, 0, 50, 0, 200, 200)
        assert ok is False

    def test_negative_x(self):
        ok, err = validate_crop_coordinates(-1, 0, 50, 50, 200, 200)
        assert ok is False

    def test_negative_y(self):
        ok, err = validate_crop_coordinates(0, -5, 50, 50, 200, 200)
        assert ok is False

    def test_non_integer(self):
        ok, err = validate_crop_coordinates(1.5, 0, 50, 50, 200, 200)
        assert ok is False

    def test_exact_boundary(self):
        """x+width == image_width and y+height == image_height is valid."""
        ok, err = validate_crop_coordinates(100, 50, 100, 150, 200, 200)
        assert ok is True

    def test_one_pixel_over_width(self):
        ok, err = validate_crop_coordinates(100, 0, 101, 50, 200, 200)
        assert ok is False

    def test_one_pixel_over_height(self):
        ok, err = validate_crop_coordinates(0, 100, 50, 101, 200, 200)
        assert ok is False


# ===========================================================================
# validate_rotation
# ===========================================================================

class TestValidateRotation:

    def test_valid_rotations(self):
        for angle in (0, 90, 180, 270):
            ok, err = validate_rotation(angle)
            assert ok is True and err is None, f"Failed for angle {angle}"

    def test_invalid_rotation_45(self):
        ok, err = validate_rotation(45)
        assert ok is False
        assert 'must be one of' in err

    def test_invalid_rotation_negative(self):
        ok, err = validate_rotation(-90)
        assert ok is False

    def test_invalid_rotation_360(self):
        ok, err = validate_rotation(360)
        assert ok is False

    def test_invalid_rotation_string(self):
        ok, err = validate_rotation('90')
        assert ok is False
        assert 'integer' in err

    def test_invalid_rotation_float(self):
        ok, err = validate_rotation(90.0)
        assert ok is False
        assert 'integer' in err

    def test_invalid_rotation_bool(self):
        """Booleans should not be accepted even though bool is subclass of int."""
        ok, err = validate_rotation(True)
        assert ok is False


# ===========================================================================
# ImageCompressor.rotate_image
# ===========================================================================

class TestRotateImage:

    @pytest.fixture(autouse=True)
    def _compressor(self):
        self.compressor = ImageCompressor(max_file_size_mb=50)

    def test_rotate_90_swaps_dimensions(self):
        """CW 90: 200x150 becomes 150x200."""
        data = make_image('JPEG', (200, 150))
        img = Image.open(io.BytesIO(data))
        rotated = self.compressor.rotate_image(img, 90)
        assert rotated.size == (150, 200)

    def test_rotate_180_preserves_dimensions(self):
        """CW 180: 200x150 stays 200x150."""
        data = make_image('JPEG', (200, 150))
        img = Image.open(io.BytesIO(data))
        rotated = self.compressor.rotate_image(img, 180)
        assert rotated.size == (200, 150)

    def test_rotate_270_swaps_dimensions(self):
        """CW 270: 200x150 becomes 150x200."""
        data = make_image('JPEG', (200, 150))
        img = Image.open(io.BytesIO(data))
        rotated = self.compressor.rotate_image(img, 270)
        assert rotated.size == (150, 200)

    def test_rotate_0_noop(self):
        """0 rotation returns the same image object unchanged."""
        data = make_image('PNG', (100, 80))
        img = Image.open(io.BytesIO(data))
        rotated = self.compressor.rotate_image(img, 0)
        assert rotated is img  # same object, not a copy

    def test_rotate_preserves_format(self):
        """Format attribute survives transpose."""
        for fmt in ('JPEG', 'PNG', 'WEBP'):
            data = make_image(fmt, (100, 100))
            img = Image.open(io.BytesIO(data))
            rotated = self.compressor.rotate_image(img, 90)
            assert rotated.format == fmt

    def test_rotate_pixel_correctness(self):
        """A red pixel in the top-left moves to top-right after CW 90."""
        img = Image.new('RGB', (200, 100), (0, 0, 0))
        img.putpixel((0, 0), (255, 0, 0))  # top-left = red
        img.format = 'PNG'

        rotated = self.compressor.rotate_image(img, 90)
        # After CW 90: top-left (0,0) of 200x100 -> top-right of 100x200
        # In CW 90 rotation: (x,y) -> (height-1-y, x)
        # (0,0) -> (99, 0) in the 100x200 result
        assert rotated.size == (100, 200)
        assert rotated.getpixel((99, 0)) == (255, 0, 0)

    def test_rotate_invalid_angle(self):
        """Invalid angle raises ImageValidationError."""
        data = make_image('JPEG', (100, 100))
        img = Image.open(io.BytesIO(data))
        with pytest.raises(ImageValidationError, match='Invalid rotation'):
            self.compressor.rotate_image(img, 45)

    def test_rotate_rgba_preserved(self):
        """Rotation preserves RGBA mode and transparency."""
        img = Image.new('RGBA', (200, 100), (255, 0, 0, 128))
        img.format = 'PNG'
        rotated = self.compressor.rotate_image(img, 90)
        assert rotated.mode == 'RGBA'
        pixel = rotated.getpixel((50, 100))
        assert pixel[3] == 128  # alpha preserved


# ===========================================================================
# ImageCompressor.crop_image
# ===========================================================================

class TestCropImage:

    @pytest.fixture(autouse=True)
    def _compressor(self):
        self.compressor = ImageCompressor(max_file_size_mb=50)

    # --- JPEG ---

    def test_crop_jpeg(self):
        data = make_image('JPEG', (200, 150))
        cropped, meta = self.compressor.crop_image(data, 50, 25, 100, 80)

        assert meta['final_dimensions'] == (100, 80)
        assert meta['original_dimensions'] == (200, 150)
        assert meta['format'] == 'JPEG'
        assert meta['cropped'] is True
        assert meta['compressed_size'] == len(cropped)

        img = Image.open(io.BytesIO(cropped))
        assert img.size == (100, 80)
        assert img.format == 'JPEG'

    # --- PNG (with transparency) ---

    def test_crop_png_rgba(self):
        data = make_image('PNG', (200, 200), color=(0, 128, 255, 128), mode='RGBA')
        cropped, meta = self.compressor.crop_image(data, 0, 0, 100, 100)

        assert meta['format'] == 'PNG'
        assert meta['final_dimensions'] == (100, 100)

        img = Image.open(io.BytesIO(cropped))
        assert img.size == (100, 100)

    # --- WebP ---

    def test_crop_webp(self):
        data = make_image('WEBP', (400, 300))
        cropped, meta = self.compressor.crop_image(data, 100, 50, 200, 150)

        assert meta['format'] == 'WEBP'
        assert meta['final_dimensions'] == (200, 150)

    # --- TIFF ---

    def test_crop_tiff(self):
        data = make_image('TIFF', (300, 300))
        cropped, meta = self.compressor.crop_image(data, 0, 0, 150, 150)

        assert meta['format'] == 'TIFF'
        assert meta['final_dimensions'] == (150, 150)

    # --- preloaded_image ---

    def test_preloaded_image_reused(self):
        data = make_image('JPEG', (200, 200))
        preloaded = Image.open(io.BytesIO(data))
        cropped, meta = self.compressor.crop_image(
            data, 10, 10, 50, 50, preloaded_image=preloaded)
        assert meta['final_dimensions'] == (50, 50)

    # --- Edge: full image crop ---

    def test_crop_full_image(self):
        """Full-image crop is not a real crop — cropped flag should be False."""
        data = make_image('PNG', (100, 80))
        cropped, meta = self.compressor.crop_image(data, 0, 0, 100, 80)
        assert meta['final_dimensions'] == (100, 80)
        assert meta['cropped'] is False

    # --- Error: out of bounds ---

    def test_crop_exceeds_bounds(self):
        data = make_image('JPEG', (200, 200))
        with pytest.raises(ImageValidationError, match='exceeds image bounds'):
            self.compressor.crop_image(data, 150, 0, 100, 100)

    def test_crop_negative_coords(self):
        data = make_image('JPEG', (200, 200))
        with pytest.raises(ImageValidationError, match='Invalid crop'):
            self.compressor.crop_image(data, -10, 0, 50, 50)

    def test_crop_zero_size(self):
        data = make_image('JPEG', (200, 200))
        with pytest.raises(ImageValidationError, match='Invalid crop'):
            self.compressor.crop_image(data, 0, 0, 0, 50)

    # --- Successive crops ---

    def test_successive_crops(self):
        """Crop a cropped result — both outputs valid, format preserved."""
        data = make_image('JPEG', (400, 300))
        first, meta1 = self.compressor.crop_image(data, 0, 0, 200, 200)
        assert meta1['format'] == 'JPEG'

        second, meta2 = self.compressor.crop_image(first, 50, 50, 100, 100)
        assert meta2['format'] == 'JPEG'
        assert meta2['final_dimensions'] == (100, 100)

        img = Image.open(io.BytesIO(second))
        assert img.size == (100, 100)

    # --- Minimum crop ---

    def test_crop_minimum_1x1(self):
        """Crop to a single pixel produces a valid image."""
        data = make_image('PNG', (100, 100))
        cropped, meta = self.compressor.crop_image(data, 50, 50, 1, 1)
        assert meta['final_dimensions'] == (1, 1)

        img = Image.open(io.BytesIO(cropped))
        assert img.size == (1, 1)

    # --- Transparency preservation ---

    def test_crop_preserves_png_transparency(self):
        """PNG RGBA crop retains the alpha channel."""
        img = Image.new('RGBA', (200, 200), (255, 0, 0, 100))
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        data = buf.getvalue()

        cropped, meta = self.compressor.crop_image(data, 0, 0, 100, 100)
        result_img = Image.open(io.BytesIO(cropped))
        assert result_img.mode == 'RGBA'
        # Verify alpha is preserved (not flattened to 255)
        pixel = result_img.getpixel((50, 50))
        assert pixel[3] == 100

    def test_crop_webp_transparency(self):
        """WebP RGBA crop retains transparency."""
        img = Image.new('RGBA', (200, 200), (0, 255, 0, 80))
        buf = io.BytesIO()
        img.save(buf, format='WEBP', lossless=True)
        data = buf.getvalue()

        cropped, meta = self.compressor.crop_image(data, 0, 0, 100, 100)
        assert meta['format'] == 'WEBP'
        result_img = Image.open(io.BytesIO(cropped))
        assert result_img.mode == 'RGBA'

    # --- Corner regions ---

    def test_crop_corner_regions(self):
        """Crop each corner of the image."""
        data = make_image('JPEG', (200, 200))
        corners = [
            (0, 0, 50, 50),         # top-left
            (150, 0, 50, 50),       # top-right
            (0, 150, 50, 50),       # bottom-left
            (150, 150, 50, 50),     # bottom-right
        ]
        for x, y, w, h in corners:
            cropped, meta = self.compressor.crop_image(data, x, y, w, h)
            assert meta['final_dimensions'] == (w, h), f"Failed for corner ({x},{y})"

    # --- Metadata sizes ---

    def test_metadata_sizes_accurate(self):
        data = make_image('JPEG', (400, 400))
        cropped, meta = self.compressor.crop_image(data, 0, 0, 50, 50)
        assert meta['original_size'] == len(data)
        assert meta['compressed_size'] == len(cropped)
        assert meta['compressed_size'] < meta['original_size']


# ===========================================================================
# /crop route
# ===========================================================================

class TestCropRoute:

    # --- Success ---

    def test_crop_success(self, auth_client):
        data = make_image('WEBP', (300, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'photo.webp', 50, 25, 200, 150),
            content_type='application/json')

        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['final_dimensions'] == [200, 150]
        assert body['metadata']['cropped'] is True
        assert body['metadata']['format'] == 'WEBP'
        assert body['filename'] == 'photo.webp'
        assert 'compressed_data' in body

        # Verify the returned base64 is a valid image
        img = Image.open(io.BytesIO(base64.b64decode(body['compressed_data'])))
        assert img.size == (200, 150)

    def test_crop_jpeg(self, auth_client):
        data = make_image('JPEG', (400, 300))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'pic.jpg', 0, 0, 200, 200),
            content_type='application/json')
        assert resp.status_code == 200
        assert resp.get_json()['metadata']['format'] == 'JPEG'

    def test_crop_png(self, auth_client):
        data = make_image('PNG', (300, 300), mode='RGBA', color=(0, 0, 0, 128))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'img.png', 10, 10, 100, 100),
            content_type='application/json')
        assert resp.status_code == 200
        assert resp.get_json()['metadata']['format'] == 'PNG'

    # --- Validation: crop coordinates ---

    def test_crop_exceeds_bounds(self, auth_client):
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 150, 0, 100, 100),
            content_type='application/json')
        assert resp.status_code == 400
        assert 'width' in resp.get_json()['error']

    def test_crop_negative_coords(self, auth_client):
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', -10, 0, 50, 50),
            content_type='application/json')
        assert resp.status_code == 400

    def test_crop_zero_size(self, auth_client):
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 0, 0, 0, 50),
            content_type='application/json')
        assert resp.status_code == 400

    def test_crop_non_numeric_coords(self, auth_client):
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=json.dumps({
                'compressed_data': b64(data),
                'filename': 'test.jpg',
                'crop': {'x': 'abc', 'y': 0, 'width': 50, 'height': 50},
            }),
            content_type='application/json')
        assert resp.status_code == 400

    def test_crop_null_crop_field(self, auth_client):
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=json.dumps({
                'compressed_data': b64(data),
                'filename': 'test.jpg',
                'crop': None,
            }),
            content_type='application/json')
        assert resp.status_code == 400

    def test_crop_missing_crop_field(self, auth_client):
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=json.dumps({
                'compressed_data': b64(data),
                'filename': 'test.jpg',
            }),
            content_type='application/json')
        assert resp.status_code == 400

    # --- Validation: image data (validate_image guards) ---

    def test_rejects_unsupported_format(self, auth_client):
        bmp = make_image('BMP', (100, 100))
        resp = auth_client.post('/crop',
            data=crop_payload(bmp, 'test.bmp', 0, 0, 50, 50),
            content_type='application/json')
        assert resp.status_code == 400
        body = resp.get_json()
        assert 'Unsupported' in body.get('details', [''])[0]

    def test_rejects_garbage_data(self, auth_client):
        garbage = base64.b64encode(b'not an image' * 100).decode()
        resp = auth_client.post('/crop',
            data=json.dumps({
                'compressed_data': garbage,
                'filename': 'bad.jpg',
                'crop': {'x': 0, 'y': 0, 'width': 10, 'height': 10},
            }),
            content_type='application/json')
        assert resp.status_code == 400

    def test_rejects_empty_base64(self, auth_client):
        resp = auth_client.post('/crop',
            data=json.dumps({
                'compressed_data': '',
                'filename': 'test.jpg',
                'crop': {'x': 0, 'y': 0, 'width': 10, 'height': 10},
            }),
            content_type='application/json')
        assert resp.status_code == 400

    # --- Auth ---

    def test_requires_auth(self, client):
        data = make_image('JPEG', (200, 200))
        resp = client.post('/crop',
            data=crop_payload(data, 'test.jpg', 0, 0, 100, 100),
            content_type='application/json')
        # Unauthenticated should redirect to login
        assert resp.status_code in (302, 401)

    # --- Edge cases ---

    def test_no_json_body(self, auth_client):
        resp = auth_client.post('/crop', content_type='application/json')
        assert resp.status_code in (400, 500)

    def test_malicious_filename_rejected(self, auth_client):
        """Filenames with path traversal are rejected by validate_download_data."""
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, '../etc/passwd.jpg', 0, 0, 100, 100),
            content_type='application/json')
        assert resp.status_code == 400

    def test_filename_preserved(self, auth_client):
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'my_photo.jpg', 0, 0, 100, 100),
            content_type='application/json')
        assert resp.status_code == 200
        assert resp.get_json()['filename'] == 'my_photo.jpg'

    # --- Response schema ---

    def test_response_schema(self, auth_client):
        """Verify all expected keys in crop response."""
        data = make_image('JPEG', (300, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 10, 10, 100, 80),
            content_type='application/json')
        assert resp.status_code == 200
        body = resp.get_json()

        # Top-level keys
        assert set(body.keys()) == {'compressed_data', 'filename', 'metadata'}

        # Metadata keys
        meta = body['metadata']
        assert meta['encoding'] == 'base64'
        assert meta['cropped'] is True
        assert meta['format'] == 'JPEG'
        assert meta['final_dimensions'] == [100, 80]
        assert meta['original_dimensions'] == [300, 200]
        assert isinstance(meta['original_size'], int)
        assert isinstance(meta['compressed_size'], int)

    # --- Pipeline: process → crop ---

    def test_process_then_crop(self, auth_client):
        """Full pipeline: upload to /process, then crop the result via /crop."""
        # Step 1: process an image
        img = Image.new('RGB', (400, 300), (128, 64, 32))
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=95)
        buf.seek(0)

        process_resp = auth_client.post('/process',
            data={'file': (buf, 'photo.jpg'), 'compression_mode': 'lossless'},
            content_type='multipart/form-data')
        assert process_resp.status_code == 200
        process_body = process_resp.get_json()

        # Step 2: crop the processed result
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
        assert crop_body['metadata']['cropped'] is True

        # Verify the cropped base64 is a valid image
        cropped_img = Image.open(io.BytesIO(base64.b64decode(crop_body['compressed_data'])))
        assert cropped_img.size == (200, 150)

    # --- Pipeline: crop → reprocess ---

    def test_crop_then_reprocess(self, auth_client):
        """Crop result fed back to /process — simulates reprocessing a cropped image."""
        # Step 1: crop an image
        data = make_image('JPEG', (400, 300))
        crop_resp = auth_client.post('/crop',
            data=crop_payload(data, 'photo.jpg', 0, 0, 200, 150),
            content_type='application/json')
        assert crop_resp.status_code == 200
        crop_body = crop_resp.get_json()

        # Step 2: feed cropped result back to /process as a file
        cropped_bytes = base64.b64decode(crop_body['compressed_data'])
        process_resp = auth_client.post('/process',
            data={
                'file': (io.BytesIO(cropped_bytes), 'photo.jpg'),
                'compression_mode': 'web',
            },
            content_type='multipart/form-data')
        assert process_resp.status_code == 200
        process_body = process_resp.get_json()

        # The reprocessed image should have the cropped dimensions
        assert process_body['metadata']['original_dimensions'] == [200, 150]

    # --- Successive crops via route ---

    def test_successive_crops_via_route(self, auth_client):
        """Crop, then crop the result again."""
        data = make_image('PNG', (400, 400))

        # First crop
        resp1 = auth_client.post('/crop',
            data=crop_payload(data, 'img.png', 0, 0, 300, 300),
            content_type='application/json')
        assert resp1.status_code == 200
        body1 = resp1.get_json()
        assert body1['metadata']['final_dimensions'] == [300, 300]

        # Second crop from first result
        resp2 = auth_client.post('/crop',
            data=json.dumps({
                'compressed_data': body1['compressed_data'],
                'filename': body1['filename'],
                'crop': {'x': 50, 'y': 50, 'width': 100, 'height': 100},
            }),
            content_type='application/json')
        assert resp2.status_code == 200
        body2 = resp2.get_json()
        assert body2['metadata']['final_dimensions'] == [100, 100]
        assert body2['metadata']['format'] == 'PNG'

    # --- Exact boundary crop ---

    def test_crop_exact_boundaries(self, auth_client):
        """Crop region spanning full width or height."""
        data = make_image('JPEG', (200, 150))

        # Full width, partial height
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 0, 25, 200, 100),
            content_type='application/json')
        assert resp.status_code == 200
        assert resp.get_json()['metadata']['final_dimensions'] == [200, 100]

    # --- Float coordinates ---

    def test_float_coordinates_cast_to_int(self, auth_client):
        """Float values in crop coordinates should be cast to int."""
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=json.dumps({
                'compressed_data': b64(data),
                'filename': 'test.jpg',
                'crop': {'x': 10.7, 'y': 20.3, 'width': 50.9, 'height': 50.1},
            }),
            content_type='application/json')
        # int() truncates floats, so this should work
        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['final_dimensions'] == [50, 50]

    # --- Empty / partial crop objects ---

    def test_empty_crop_object(self, auth_client):
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=json.dumps({
                'compressed_data': b64(data),
                'filename': 'test.jpg',
                'crop': {},
            }),
            content_type='application/json')
        assert resp.status_code == 400

    def test_partial_crop_object(self, auth_client):
        """Only x and y provided, missing width and height."""
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=json.dumps({
                'compressed_data': b64(data),
                'filename': 'test.jpg',
                'crop': {'x': 10, 'y': 10},
            }),
            content_type='application/json')
        assert resp.status_code == 400

    # --- Rotation ---

    def test_rotation_0_default(self, auth_client):
        """Omitting rotation field works (backward compatibility)."""
        data = make_image('JPEG', (300, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 0, 0, 150, 100),
            content_type='application/json')
        assert resp.status_code == 200
        meta = resp.get_json()['metadata']
        assert meta['rotated'] is False
        assert meta['cropped'] is True

    def test_rotation_only_90(self, auth_client):
        """Rotate 90 CW without cropping: 300x200 becomes 200x300."""
        data = make_image('JPEG', (300, 200))
        # Full rotated image — no actual crop
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 0, 0, 200, 300, rotation=90),
            content_type='application/json')
        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['final_dimensions'] == [200, 300]
        assert body['metadata']['rotated'] is True
        assert body['metadata']['cropped'] is False
        # original_dimensions reflects the actual input, not the rotated intermediate
        assert body['metadata']['original_dimensions'] == [300, 200]

        # Verify actual pixel dimensions
        img = Image.open(io.BytesIO(base64.b64decode(body['compressed_data'])))
        assert img.size == (200, 300)

    def test_rotation_only_180(self, auth_client):
        """Rotate 180 without cropping: dimensions stay 300x200."""
        data = make_image('JPEG', (300, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 0, 0, 300, 200, rotation=180),
            content_type='application/json')
        assert resp.status_code == 200
        meta = resp.get_json()['metadata']
        assert meta['final_dimensions'] == [300, 200]
        assert meta['cropped'] is False
        assert meta['original_dimensions'] == [300, 200]

    def test_rotation_only_270(self, auth_client):
        """Rotate 270 CW without cropping: 300x200 becomes 200x300."""
        data = make_image('JPEG', (300, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 0, 0, 200, 300, rotation=270),
            content_type='application/json')
        assert resp.status_code == 200
        meta = resp.get_json()['metadata']
        assert meta['final_dimensions'] == [200, 300]
        assert meta['cropped'] is False
        assert meta['original_dimensions'] == [300, 200]

    def test_crop_with_rotation_and_crop(self, auth_client):
        """Rotate 90 then crop a sub-region of the rotated image."""
        data = make_image('JPEG', (300, 200))
        # After 90 CW: 200x300. Crop a 100x150 region from the rotated image.
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 10, 20, 100, 150, rotation=90),
            content_type='application/json')
        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['final_dimensions'] == [100, 150]
        assert body['metadata']['rotated'] is True
        assert body['metadata']['cropped'] is True
        # original_dimensions is the input, not the rotated intermediate
        assert body['metadata']['original_dimensions'] == [300, 200]

    def test_invalid_rotation_rejected(self, auth_client):
        """Non-90-degree rotation is rejected."""
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 0, 0, 200, 200, rotation=45),
            content_type='application/json')
        assert resp.status_code == 400
        assert 'must be one of' in resp.get_json()['error']

    def test_invalid_rotation_string_rejected(self, auth_client):
        """String rotation value is rejected."""
        data = make_image('JPEG', (200, 200))
        resp = auth_client.post('/crop',
            data=json.dumps({
                'compressed_data': b64(data),
                'filename': 'test.jpg',
                'crop': {'x': 0, 'y': 0, 'width': 200, 'height': 200},
                'rotation': 'ninety',
            }),
            content_type='application/json')
        assert resp.status_code == 400

    def test_rotation_metadata(self, auth_client):
        """Verify rotated/cropped flags and original_dimensions in metadata."""
        data = make_image('PNG', (200, 100))
        # Full-image crop after rotation — only rotation, no actual crop
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.png', 0, 0, 100, 200, rotation=90),
            content_type='application/json')
        assert resp.status_code == 200
        meta = resp.get_json()['metadata']
        assert meta['rotated'] is True
        assert meta['cropped'] is False
        assert meta['original_dimensions'] == [200, 100]
        assert meta['encoding'] == 'base64'

    def test_rotation_crop_exceeds_rotated_bounds(self, auth_client):
        """Crop coords valid for original but exceeding rotated bounds are rejected."""
        data = make_image('JPEG', (300, 200))
        # After 90 CW: 200x300. Trying to crop 300 width (original width) fails.
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 0, 0, 300, 200, rotation=90),
            content_type='application/json')
        assert resp.status_code == 400

    def test_rotation_preserves_format(self, auth_client):
        """Rotation preserves the original image format."""
        for fmt, ext in [('JPEG', 'jpg'), ('PNG', 'png'), ('WEBP', 'webp')]:
            data = make_image(fmt, (200, 100))
            resp = auth_client.post('/crop',
                data=crop_payload(data, f'test.{ext}', 0, 0, 100, 200, rotation=90),
                content_type='application/json')
            assert resp.status_code == 200
            assert resp.get_json()['metadata']['format'] == fmt

    def test_response_schema_with_rotation(self, auth_client):
        """Verify response includes rotated field in metadata."""
        data = make_image('JPEG', (300, 200))
        resp = auth_client.post('/crop',
            data=crop_payload(data, 'test.jpg', 0, 0, 200, 300, rotation=90),
            content_type='application/json')
        assert resp.status_code == 200
        meta = resp.get_json()['metadata']
        assert 'rotated' in meta
        assert 'cropped' in meta
        assert 'encoding' in meta
