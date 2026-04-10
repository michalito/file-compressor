import base64
import io
import json

from PIL import Image, ImageDraw

from app.compression.image_processor import BackgroundRemovalError
from app.routes import compressor as route_compressor


def make_image(fmt='JPEG', size=(320, 240), color=(180, 180, 180), mode='RGB'):
    img = Image.new(mode, size, color)
    buf = io.BytesIO()
    save_kwargs = {'format': fmt}
    if fmt == 'JPEG':
        save_kwargs['quality'] = 95
    img.save(buf, **save_kwargs)
    return buf.getvalue()


def make_cutout(size):
    cutout = Image.new('RGBA', size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(cutout)
    margin_x = max(8, size[0] // 4)
    margin_y = max(8, size[1] // 4)
    draw.rectangle(
        (margin_x, margin_y, size[0] - margin_x, size[1] - margin_y),
        fill=(255, 255, 255, 255),
    )
    return cutout


def decode_image(b64_data):
    return Image.open(io.BytesIO(base64.b64decode(b64_data)))


class TestBackgroundRemovalRoute:

    def test_process_without_background_removal_keeps_existing_behavior(self, auth_client, monkeypatch):
        def unexpected_call(_img):
            raise AssertionError("background removal should not run when disabled")

        monkeypatch.setattr(route_compressor, '_apply_background_removal', unexpected_call)

        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('JPEG')), 'photo.jpg'),
                'compression_mode': 'lossless',
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 200
        body = resp.get_json()
        assert body['metadata']['background_removed'] is False
        assert body['metadata']['format'] == 'JPEG'
        assert body['filename'].endswith('.jpg')

    def test_background_removal_forces_transparent_png_output(self, auth_client, monkeypatch):
        monkeypatch.setattr(
            route_compressor,
            '_apply_background_removal',
            lambda img: (make_cutout(img.size), []),
        )

        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('JPEG')), 'subject.jpg'),
                'compression_mode': 'high',
                'output_format': 'jpeg',
                'quality': '40',
                'remove_background': '1',
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 200
        body = resp.get_json()
        metadata = body['metadata']
        assert metadata['background_removed'] is True
        assert metadata['format'] == 'PNG'
        assert body['filename'].endswith('.png')

        output = decode_image(body['compressed_data'])
        assert output.format == 'PNG'
        assert output.mode == 'RGBA'
        assert output.getchannel('A').getextrema()[0] == 0

    def test_invalid_remove_background_value_returns_400(self, auth_client):
        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('JPEG')), 'photo.jpg'),
                'compression_mode': 'lossless',
                'remove_background': 'sometimes',
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 400
        assert resp.get_json()['error'] == 'Invalid remove_background value'

    def test_background_removal_warning_bubbles_up(self, auth_client, monkeypatch):
        opaque = Image.new('RGBA', (320, 240), (255, 255, 255, 255))
        monkeypatch.setattr(
            route_compressor,
            '_apply_background_removal',
            lambda img: (opaque.resize(img.size), ['Background removal completed, but no transparent pixels were detected']),
        )

        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('JPEG')), 'subject.jpg'),
                'compression_mode': 'lossless',
                'remove_background': '1',
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 200
        body = resp.get_json()
        assert 'Background removal completed, but no transparent pixels were detected' in body['warnings']
        assert body['metadata']['background_removed'] is False

    def test_background_removed_png_can_be_cropped(self, auth_client, monkeypatch):
        monkeypatch.setattr(
            route_compressor,
            '_apply_background_removal',
            lambda img: (make_cutout(img.size), []),
        )

        process_resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('JPEG', size=(400, 300))), 'subject.jpg'),
                'compression_mode': 'lossless',
                'remove_background': '1',
            },
            content_type='multipart/form-data',
        )

        assert process_resp.status_code == 200
        process_body = process_resp.get_json()

        crop_resp = auth_client.post(
            '/crop',
            data=json.dumps({
                'compressed_data': process_body['compressed_data'],
                'filename': process_body['filename'],
                'crop': {'x': 0, 'y': 0, 'width': 180, 'height': 150},
            }),
            content_type='application/json',
        )

        assert crop_resp.status_code == 200
        crop_body = crop_resp.get_json()
        assert crop_body['metadata']['format'] == 'PNG'

        cropped = decode_image(crop_body['compressed_data'])
        assert cropped.format == 'PNG'
        assert cropped.mode == 'RGBA'
        assert cropped.getchannel('A').getextrema()[0] == 0

    def test_background_removal_failure_returns_503(self, auth_client, monkeypatch):
        def fail(_img):
            raise BackgroundRemovalError("Could not initialize background removal model")

        monkeypatch.setattr(route_compressor, '_apply_background_removal', fail)

        resp = auth_client.post(
            '/process',
            data={
                'file': (io.BytesIO(make_image('JPEG')), 'subject.jpg'),
                'compression_mode': 'lossless',
                'remove_background': '1',
            },
            content_type='multipart/form-data',
        )

        assert resp.status_code == 503
        assert resp.get_json()['error'] == (
            'Background removal is unavailable right now. Try again or disable Remove Background.'
        )
