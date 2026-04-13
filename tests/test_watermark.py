import base64
import io

import pytest
from PIL import Image, ImageChops, ImageDraw
from werkzeug.datastructures import FileStorage

from app.compression.image_processor import ImageCompressor
from app.routes import _load_rgba_image


def make_image(fmt='PNG', size=(320, 240), color=(180, 180, 180, 255), mode='RGBA'):
    img = Image.new(mode, size, color)
    buf = io.BytesIO()
    save_kwargs = {'format': fmt}
    if fmt == 'JPEG':
        save_kwargs['quality'] = 95
    if fmt == 'JPEG' and mode == 'RGBA':
        img = img.convert('RGB')
    img.save(buf, **save_kwargs)
    return buf.getvalue()


def make_logo_png(size=(96, 64)):
    img = Image.new('RGBA', size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((8, 8, size[0] - 8, size[1] - 8), radius=12, fill=(20, 120, 255, 220))
    draw.ellipse((26, 18, 70, 58), fill=(255, 255, 255, 230))
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def make_color_stamp_png(size=(96, 96), color=(255, 0, 0, 255)):
    img = Image.new('RGBA', size, color)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def decode_image(b64_data):
    return Image.open(io.BytesIO(base64.b64decode(b64_data)))


def diff_bbox(original_bytes, processed_bytes):
    original = Image.open(io.BytesIO(original_bytes)).convert('RGB')
    processed = Image.open(io.BytesIO(processed_bytes)).convert('RGB')
    diff = ImageChops.difference(original, processed)
    return diff.getbbox()


def open_image(image_bytes):
    return Image.open(io.BytesIO(image_bytes)).convert('RGBA')


class TestWatermarkRoute:

    def test_process_without_watermark_keeps_metadata_false(self, auth_client):
        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('PNG')), 'plain.png'),
                'compression_mode': 'lossless',
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['watermarked'] is False
        assert body['metadata']['watermark_layers'] == []

    def test_text_watermark_returns_text_layer_metadata(self, auth_client):
        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('PNG')), 'photo.png'),
                'compression_mode': 'lossless',
                'watermark_text': 'Preview',
                'watermark_text_color': 'white',
                'watermark_text_position': 'bottom-right',
                'watermark_text_opacity': '55',
                'watermark_text_size': '7',
                'watermark_text_angle': '10',
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['watermarked'] is True
        assert body['metadata']['watermark_layers'] == ['text']
        assert decode_image(body['compressed_data']).size == (320, 240)

    def test_logo_only_watermark_is_applied(self, auth_client):
        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('PNG')), 'photo.png'),
                'compression_mode': 'lossless',
                'watermark_logo': (io.BytesIO(make_logo_png()), 'logo.png', 'image/png'),
                'watermark_logo_position': 'top-left',
                'watermark_logo_opacity': '80',
                'watermark_logo_size': '8',
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['watermarked'] is True
        assert body['metadata']['watermark_layers'] == ['logo']

    def test_text_and_logo_watermark_layers_stack(self, auth_client):
        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('PNG')), 'photo.png'),
                'compression_mode': 'lossless',
                'watermark_text': 'Stacked',
                'watermark_text_color': 'auto',
                'watermark_text_position': 'bottom-right',
                'watermark_logo': (io.BytesIO(make_logo_png()), 'logo.png', 'image/png'),
                'watermark_logo_position': 'top-left',
                'watermark_logo_opacity': '70',
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['watermarked'] is True
        assert body['metadata']['watermark_layers'] == ['text', 'logo']

    def test_qr_watermark_requires_url_and_png(self, auth_client):
        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('PNG')), 'photo.png'),
                'compression_mode': 'lossless',
                'watermark_qr_url': 'https://example.com',
                'watermark_qr_image': (io.BytesIO(make_color_stamp_png()), 'watermark-qr.png', 'image/png'),
                'watermark_qr_position': 'center',
                'watermark_qr_size': '9',
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['watermarked'] is True
        assert body['metadata']['watermark_layers'] == ['qr']

    def test_rejects_non_png_logo(self, auth_client):
        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('PNG')), 'photo.png'),
                'compression_mode': 'lossless',
                'watermark_logo': (io.BytesIO(make_image('JPEG', mode='RGB')), 'logo.jpg', 'image/jpeg'),
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 400
        assert resp.get_json()['error'] == 'Watermark logo must be a PNG image'

    def test_rejects_unreadable_logo(self, auth_client):
        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('PNG')), 'photo.png'),
                'compression_mode': 'lossless',
                'watermark_logo': (io.BytesIO(b'not-a-real-png'), 'logo.png', 'image/png'),
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 400
        assert resp.get_json()['error'] == 'Watermark logo is not a valid PNG image'

    def test_rejects_oversized_logo(self, auth_client):
        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('PNG')), 'photo.png'),
                'compression_mode': 'lossless',
                'watermark_logo': (io.BytesIO(b'0' * (5 * 1024 * 1024 + 1)), 'logo.png', 'image/png'),
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 400
        assert resp.get_json()['error'] == 'Watermark logo must be 5 MB or smaller'

    def test_rejects_invalid_qr_url(self, auth_client):
        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('PNG')), 'photo.png'),
                'compression_mode': 'lossless',
                'watermark_qr_url': 'not-a-url',
                'watermark_qr_image': (io.BytesIO(make_color_stamp_png()), 'watermark-qr.png', 'image/png'),
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 400
        assert resp.get_json()['error'] == 'QR watermark URL must be an absolute http:// or https:// URL'

    def test_rejects_invalid_layer_transform(self, auth_client):
        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('PNG')), 'photo.png'),
                'compression_mode': 'lossless',
                'watermark_text': 'Preview',
                'watermark_text_position': 'bottom-right',
                'watermark_text_opacity': '5',
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 400
        assert resp.get_json()['error'] == 'Watermark opacity must be between 10 and 100'

    def test_load_rgba_image_rejects_excessive_pixel_count_before_load(self, monkeypatch):
        class FakeImage:
            def __init__(self):
                self.size = (5000, 5000)
                self.load_called = False

            def load(self):
                self.load_called = True

            def convert(self, mode):
                return self

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

        fake_image = FakeImage()
        monkeypatch.setattr('app.routes.Image.open', lambda *_args, **_kwargs: fake_image)
        upload = FileStorage(stream=io.BytesIO(b'fake-png-data'), filename='logo.png', content_type='image/png')

        with pytest.raises(ValueError, match='Watermark image exceeds the maximum supported pixel count'):
            _load_rgba_image(upload)

        assert fake_image.load_called is False
        assert upload.stream.tell() == 0


class TestWatermarkPlacement:

    def setup_method(self):
        self.compressor = ImageCompressor(max_file_size_mb=50)

    def test_text_watermark_stays_in_bottom_right_quadrant(self):
        original = make_image('PNG', size=(400, 300), color=(240, 240, 240, 255))

        processed, metadata = self.compressor.compress_image(
            original,
            mode='lossless',
            watermark_layers={
                'text': {
                    'value': 'Preview',
                    'color': 'black',
                    'position': 'bottom-right',
                    'opacity': 50,
                    'size': 10,
                    'tile_density': 5,
                    'angle': 0,
                },
            },
        )

        bbox = diff_bbox(original, processed)

        assert metadata['watermark_layers'] == ['text']
        assert bbox is not None
        left, top, _, bottom = bbox
        assert left > 180
        assert top > 140
        assert bottom > 240

    def test_independent_text_and_logo_positions_cover_opposite_corners(self):
        original = make_image('PNG', size=(420, 320), color=(235, 235, 235, 255))

        processed, metadata = self.compressor.compress_image(
            original,
            mode='lossless',
            watermark_layers={
                'text': {
                    'value': 'Bottom',
                    'color': 'black',
                    'position': 'bottom-right',
                    'opacity': 70,
                    'size': 10,
                    'tile_density': 5,
                    'angle': 0,
                },
                'logo': {
                    'image': open_image(make_logo_png((96, 96))),
                    'position': 'top-left',
                    'opacity': 100,
                    'size': 10,
                    'tile_density': 5,
                    'angle': 0,
                },
            },
        )

        bbox = diff_bbox(original, processed)

        assert metadata['watermark_layers'] == ['text', 'logo']
        assert bbox is not None
        left, top, right, bottom = bbox
        assert left < 60
        assert top < 60
        assert right > 300
        assert bottom > 240

    def test_qr_center_can_stack_with_tiled_text(self):
        original = make_image('PNG', size=(420, 320), color=(240, 240, 240, 255))

        processed, metadata = self.compressor.compress_image(
            original,
            mode='lossless',
            watermark_layers={
                'text': {
                    'value': 'Pattern',
                    'color': 'black',
                    'position': 'tiled',
                    'opacity': 25,
                    'size': 7,
                    'tile_density': 8,
                    'angle': -25,
                },
                'qr': {
                    'url': 'https://example.com',
                    'image': open_image(make_color_stamp_png((100, 100), (0, 200, 0, 255))),
                    'position': 'center',
                    'opacity': 100,
                    'size': 10,
                    'tile_density': 5,
                    'angle': 0,
                },
            },
        )

        output = Image.open(io.BytesIO(processed)).convert('RGB')
        center_pixel = output.getpixel((output.width // 2, output.height // 2))

        assert metadata['watermark_layers'] == ['text', 'qr']
        assert center_pixel[1] > center_pixel[0]
        assert center_pixel[1] > center_pixel[2]

    def test_mixed_angles_across_layers_apply(self):
        original = make_image('PNG', size=(420, 320), color=(240, 240, 240, 255))

        processed, metadata = self.compressor.compress_image(
            original,
            mode='lossless',
            watermark_layers={
                'text': {
                    'value': 'Angle',
                    'color': 'black',
                    'position': 'bottom-left',
                    'opacity': 60,
                    'size': 8,
                    'tile_density': 5,
                    'angle': -35,
                },
                'logo': {
                    'image': open_image(make_logo_png((80, 80))),
                    'position': 'top-right',
                    'opacity': 90,
                    'size': 8,
                    'tile_density': 5,
                    'angle': 25,
                },
                'qr': {
                    'url': 'https://example.com/qr',
                    'image': open_image(make_color_stamp_png((90, 90), (0, 160, 0, 255))),
                    'position': 'center',
                    'opacity': 85,
                    'size': 7,
                    'tile_density': 5,
                    'angle': 45,
                },
            },
        )

        assert metadata['watermark_layers'] == ['text', 'logo', 'qr']
        assert diff_bbox(original, processed) is not None

    def test_tiled_logo_watermark_covers_most_of_image(self):
        original = make_image('PNG', size=(420, 320), color=(245, 245, 245, 255))

        processed, metadata = self.compressor.compress_image(
            original,
            mode='lossless',
            watermark_layers={
                'logo': {
                    'image': open_image(make_color_stamp_png((72, 72), (255, 0, 0, 220))),
                    'position': 'tiled',
                    'opacity': 100,
                    'size': 6,
                    'tile_density': 9,
                    'angle': -20,
                },
            },
        )

        bbox = diff_bbox(original, processed)

        assert metadata['watermark_layers'] == ['logo']
        assert bbox is not None
        left, top, right, bottom = bbox
        assert left < 30
        assert top < 30
        assert right > 380
        assert bottom > 280

    def test_tiled_qr_watermark_covers_most_of_image(self):
        original = make_image('PNG', size=(420, 320), color=(245, 245, 245, 255))

        processed, metadata = self.compressor.compress_image(
            original,
            mode='lossless',
            watermark_layers={
                'qr': {
                    'url': 'https://example.com/qr',
                    'image': open_image(make_color_stamp_png((72, 72), (0, 160, 0, 255))),
                    'position': 'tiled',
                    'opacity': 100,
                    'size': 6,
                    'tile_density': 9,
                    'angle': 30,
                },
            },
        )

        bbox = diff_bbox(original, processed)

        assert metadata['watermark_layers'] == ['qr']
        assert bbox is not None
        left, top, right, bottom = bbox
        assert left < 30
        assert top < 30
        assert right > 380
        assert bottom > 280

    def test_qr_layer_wins_when_layers_overlap(self):
        original = make_image('PNG', size=(420, 320), color=(250, 250, 250, 255))

        processed, metadata = self.compressor.compress_image(
            original,
            mode='lossless',
            watermark_layers={
                'text': {
                    'value': 'X',
                    'color': 'black',
                    'position': 'center',
                    'opacity': 100,
                    'size': 18,
                    'tile_density': 5,
                    'angle': 0,
                },
                'logo': {
                    'image': open_image(make_color_stamp_png((120, 120), (255, 0, 0, 255))),
                    'position': 'center',
                    'opacity': 100,
                    'size': 12,
                    'tile_density': 5,
                    'angle': 0,
                },
                'qr': {
                    'url': 'https://example.com/qr',
                    'image': open_image(make_color_stamp_png((120, 120), (0, 200, 0, 255))),
                    'position': 'center',
                    'opacity': 100,
                    'size': 12,
                    'tile_density': 5,
                    'angle': 0,
                },
            },
        )

        output = Image.open(io.BytesIO(processed)).convert('RGB')
        center_pixel = output.getpixel((output.width // 2, output.height // 2))

        assert metadata['watermark_layers'] == ['text', 'logo', 'qr']
        assert center_pixel == (0, 200, 0)
