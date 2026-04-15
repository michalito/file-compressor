import io

from upscaler_service.app import create_upscaler_app


class FakeService:
    def __init__(self, *, api_key=''):
        self.config = type('Config', (), {'api_key': api_key})()
        self.cleanup_calls = 0
        self.submit_calls = 0

    def cleanup_expired_jobs(self):
        self.cleanup_calls += 1

    def get_health(self, force_refresh=False):
        del force_refresh
        return {'healthy': True, 'state': 'ready'}

    def submit_job(self, **kwargs):
        self.submit_calls += 1
        return {'job_id': 'job-1', 'status': 'queued', 'phase': 'queued', 'progress': 0, 'queue_position': 1}


def test_upscaler_auth_runs_before_cleanup(monkeypatch):
    service = FakeService(api_key='secret')
    monkeypatch.setattr('upscaler_service.app.UpscalerService', lambda config: service)

    app = create_upscaler_app(object())
    client = app.test_client()

    response = client.get('/health')

    assert response.status_code == 401
    assert service.cleanup_calls == 0


def test_upscaler_rejects_oversized_uploads_before_submit(monkeypatch):
    service = FakeService()
    monkeypatch.setattr('upscaler_service.app.UpscalerService', lambda config: service)

    app = create_upscaler_app(object())
    app.config['MAX_CONTENT_LENGTH'] = 4
    client = app.test_client()

    response = client.post('/jobs', data={
        'file': (io.BytesIO(b'12345'), 'demo.png'),
        'model_preset': 'photo',
        'scale': '2',
        'output_format': 'png',
    }, content_type='multipart/form-data')

    assert response.status_code == 413
    assert response.get_json() == {
        'error': 'Uploaded file is too large. Maximum file size is 4 bytes.',
        'user_message': 'Uploaded file is too large. Maximum file size is 4 bytes.',
        'code': 'file_too_large',
        'limit_bytes': 4,
    }
    assert service.submit_calls == 0


def test_upscaler_health_requests_do_not_trigger_cleanup(monkeypatch):
    service = FakeService(api_key='secret')
    monkeypatch.setattr('upscaler_service.app.UpscalerService', lambda config: service)

    app = create_upscaler_app(object())
    client = app.test_client()

    response = client.get('/health', headers={'X-API-Key': 'secret'})

    assert response.status_code == 200
    assert service.cleanup_calls == 0
