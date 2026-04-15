import io
import json

import pytest
from PIL import Image

from app.ai_upscale import AIUpscaleSettings, AIUpscaleStream, AIUpscalerError, validate_ai_upscale_upload


def make_png_bytes(size=(256, 256), color=(32, 96, 192, 255)):
    image = Image.new('RGBA', size, color)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def make_16bit_png_bytes(size=(64, 64), value=4096):
    image = Image.new('I;16', size)
    image.putdata([value] * (size[0] * size[1]))
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def make_stream(payload: bytes, *, content_type='image/png', filename='demo.png'):
    return AIUpscaleStream(
        response=io.BytesIO(payload),
        content_type=content_type,
        filename=filename,
        content_length=len(payload),
    )


def test_ai_upscale_health_exposes_disabled_state(auth_client):
    response = auth_client.get('/ai-upscale/health', headers={'Accept': 'application/json'})

    assert response.status_code == 200
    assert response.get_json() == {
        'enabled': False,
        'healthy': False,
        'state': 'disabled',
        'backend': None,
        'worker_instance_id': None,
        'started_at': None,
        'reason': 'AI upscaling is disabled in configuration.',
        'details': {},
    }


def test_ai_upscale_job_rejects_projected_output_over_limit(app, auth_client, monkeypatch):
    app.config['AI_UPSCALER_ENABLED'] = True
    monkeypatch.setattr('app.routes.create_ai_job', lambda **kwargs: (_ for _ in ()).throw(AssertionError('should not proxy')))

    payload = {
        'file': (io.BytesIO(make_png_bytes((3200, 3200))), 'too-large.png'),
        'model_preset': 'photo',
        'scale': '4',
        'output_format': 'png',
    }
    response = auth_client.post('/ai-upscale/jobs', data=payload, content_type='multipart/form-data')

    assert response.status_code == 400
    body = response.get_json()
    assert body['projected_output'] == {
        'width': 12800,
        'height': 12800,
        'pixels': 163840000,
    }
    assert body['code'] == 'output_limit_exceeded'
    assert body['suggested_scale'] == 2
    assert body['error'] == body['user_message']
    assert 'This image would become 12,800 x 12,800 at 4x' in body['error']


def test_validate_ai_upscale_upload_rejects_file_over_limit(app):
    app.config['MAX_CONTENT_LENGTH'] = 1024
    oversized = b'x' * 1025
    file = type('Upload', (), {'filename': 'oversized.png'})()
    settings = AIUpscaleSettings(model_preset='photo', scale=2, output_format='png', quality=None)

    with app.app_context():
        with pytest.raises(AIUpscalerError) as exc_info:
            validate_ai_upscale_upload(file, oversized, settings)

    assert exc_info.value.status_code == 413
    assert exc_info.value.payload['code'] == 'file_too_large'
    assert exc_info.value.payload['user_message'] == 'This image is too large to upload. Maximum file size is 1 KB.'


def test_validate_ai_upscale_upload_rejects_16bit_inputs(app):
    file = type('Upload', (), {'filename': 'sixteen-bit.png'})()
    settings = AIUpscaleSettings(model_preset='photo', scale=2, output_format='png', quality=None)

    with app.app_context():
        with pytest.raises(AIUpscalerError) as exc_info:
            validate_ai_upscale_upload(file, make_16bit_png_bytes(), settings)

    assert exc_info.value.status_code == 400
    assert exc_info.value.payload['code'] == 'unsupported_bit_depth'
    assert exc_info.value.payload['bit_depth'] == 16
    assert exc_info.value.payload['user_message'] == '16-bit AI upscaling inputs are not supported yet. Convert the image to 8-bit and try again.'


def test_ai_upscale_job_returns_friendly_payload_when_request_exceeds_limit(app, auth_client, monkeypatch):
    app.config['AI_UPSCALER_ENABLED'] = True
    app.config['MAX_CONTENT_LENGTH'] = 1024
    monkeypatch.setattr('app.routes.create_ai_job', lambda **kwargs: (_ for _ in ()).throw(AssertionError('should not proxy')))

    payload = {
        'file': (io.BytesIO(b'x' * 2048), 'too-large.png'),
        'model_preset': 'photo',
        'scale': '2',
        'output_format': 'png',
    }
    response = auth_client.post(
        '/ai-upscale/jobs',
        data=payload,
        content_type='multipart/form-data',
        headers={'Accept': 'application/json', 'X-Requested-With': 'fetch'},
    )

    assert response.status_code == 413
    assert response.get_json() == {
        'code': 'file_too_large',
        'error': 'Uploaded file is too large. Maximum file size is 1 KB.',
        'limit_bytes': 1024,
        'user_message': 'Uploaded file is too large. Maximum file size is 1 KB.',
    }


def test_ai_upscale_job_proxies_worker_response(app, auth_client, monkeypatch):
    app.config['AI_UPSCALER_ENABLED'] = True
    captured = {}

    def fake_create_ai_job(**kwargs):
        captured.update(kwargs)
        return {'job_id': 'job-123', 'status': 'queued', 'phase': 'queued', 'progress': 0, 'queue_position': 1}

    monkeypatch.setattr('app.routes.create_ai_job', fake_create_ai_job)

    payload = {
        'file': (io.BytesIO(make_png_bytes()), 'demo.png'),
        'model_preset': 'anime',
        'scale': '2',
        'output_format': 'webp',
        'quality': '88',
    }
    response = auth_client.post('/ai-upscale/jobs', data=payload, content_type='multipart/form-data')

    assert response.status_code == 202
    assert response.get_json()['job_id'] == 'job-123'
    assert captured['filename'] == 'demo.png'
    assert captured['settings'].model_preset == 'anime'
    assert captured['settings'].scale == 2
    assert captured['settings'].output_format == 'webp'
    assert captured['settings'].quality == 88


def test_ai_upscale_health_propagates_worker_error(app, auth_client, monkeypatch):
    app.config['AI_UPSCALER_ENABLED'] = True
    monkeypatch.setattr(
        'app.routes.get_ai_health',
        lambda: (_ for _ in ()).throw(AIUpscalerError('Runtime probe failed.', status_code=503, payload={'details': 'bad'})),
    )

    response = auth_client.get('/ai-upscale/health', headers={'Accept': 'application/json'})

    assert response.status_code == 503
    assert response.get_json()['reason'] == 'Runtime probe failed.'


def test_ai_upscale_job_propagates_memory_budget_error(app, auth_client, monkeypatch):
    app.config['AI_UPSCALER_ENABLED'] = True
    monkeypatch.setattr(
        'app.routes.create_ai_job',
        lambda **kwargs: (_ for _ in ()).throw(AIUpscalerError(
            'AI upscaling would exceed the worker memory budget.',
            status_code=409,
            payload={
                'code': 'memory_budget_exceeded',
                'user_message': 'This image is too large for 4x AI upscaling on the current server. Try 2x instead.',
                'estimated_peak_bytes': 123456,
                'memory_limit_bytes': 654321,
                'memory_soft_limit_bytes': 456789,
                'projected_output': {'width': 8000, 'height': 8000, 'pixels': 64_000_000},
                'suggested_scale': 2,
            },
        )),
    )

    payload = {
        'file': (io.BytesIO(make_png_bytes()), 'demo.png'),
        'model_preset': 'photo',
        'scale': '4',
        'output_format': 'png',
    }
    response = auth_client.post('/ai-upscale/jobs', data=payload, content_type='multipart/form-data')

    assert response.status_code == 409
    assert response.get_json()['code'] == 'memory_budget_exceeded'
    assert response.get_json()['suggested_scale'] == 2
    assert response.get_json()['error'] == 'This image is too large for 4x AI upscaling on the current server. Try 2x instead.'


def test_ai_upscale_preview_streams_without_buffering(app, auth_client, monkeypatch):
    app.config['AI_UPSCALER_ENABLED'] = True
    monkeypatch.setattr('app.routes.open_ai_artifact_stream', lambda *args, **kwargs: make_stream(b'preview-bytes'))

    response = auth_client.get('/ai-upscale/artifacts/job-1-preview/preview')

    assert response.status_code == 200
    assert response.data == b'preview-bytes'
    assert response.mimetype == 'image/png'


def test_ai_upscale_download_all_proxies_worker_stream(app, auth_client, monkeypatch):
    app.config['AI_UPSCALER_ENABLED'] = True
    captured = {}

    def fake_open_download_all_stream(artifacts):
        captured['artifacts'] = artifacts
        return make_stream(b'zipdata', content_type='application/zip', filename='ai_upscaled_images.zip')

    monkeypatch.setattr('app.routes.open_ai_download_all_stream', fake_open_download_all_stream)

    response = auth_client.post(
        '/ai-upscale/download-all',
        data=json.dumps({
            'artifacts': [
                {'artifact_id': 'first', 'filename': 'first.png'},
                {'artifact_id': 'second', 'filename': 'second.png'},
            ]
        }),
        headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
    )

    assert response.status_code == 200
    assert response.data == b'zipdata'
    assert captured['artifacts'] == [
        {'artifact_id': 'first', 'filename': 'first.png'},
        {'artifact_id': 'second', 'filename': 'second.png'},
    ]


@pytest.mark.parametrize(
    ('method', 'url'),
    (
        ('get', '/ai-upscale/jobs/bad.id'),
        ('post', '/ai-upscale/jobs/bad.id/cancel'),
        ('delete', '/ai-upscale/jobs/bad.id'),
        ('get', '/ai-upscale/artifacts/bad.id/preview'),
        ('get', '/ai-upscale/artifacts/bad.id/download'),
    ),
)
def test_ai_upscale_routes_reject_invalid_identifiers(auth_client, method, url):
    response = getattr(auth_client, method)(url, headers={'Accept': 'application/json'})

    assert response.status_code == 400
    assert response.get_json() == {'error': 'Invalid AI upscaling identifier.'}


def test_ai_upscale_download_all_rejects_invalid_identifier(auth_client):
    response = auth_client.post('/ai-upscale/download-all', json={
        'artifacts': [
            {'artifact_id': 'bad.id', 'filename': 'first.png'},
        ],
    })

    assert response.status_code == 400
    assert response.get_json() == {'error': 'Invalid AI upscaling identifier.'}
