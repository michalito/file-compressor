import io
import re

from PIL import Image


UNAUTHORIZED_BODY = {
    'error': 'Authentication required',
    'code': 'auth_required',
    'redirect': '/login',
}

CSRF_FAILED_BODY = {
    'error': 'The CSRF token is missing.',
    'code': 'csrf_failed',
    'reload': True,
}

RATE_LIMIT_BODY = {
    'error': 'Rate limit exceeded for image processing. Try again shortly or use Retry Incomplete.',
    'code': 'rate_limit_exceeded',
}


def api_headers():
    return {
        'Accept': 'application/json',
        'X-Requested-With': 'fetch',
    }


def make_image_bytes():
    image = Image.new('RGB', (16, 16), (64, 128, 192))
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def login_csrf_token(client):
    response = client.get('/login')
    match = re.search(r'name="csrf_token" type="hidden" value="([^"]+)"', response.get_data(as_text=True))
    assert match is not None
    return match.group(1)


def test_index_redirects_for_html_requests(client):
    response = client.get('/')

    assert response.status_code == 302
    assert response.headers['Location'].endswith('/login')


def test_process_requires_auth_for_api_requests(client):
    response = client.post('/process', headers=api_headers())

    assert response.status_code == 401
    assert response.get_json() == UNAUTHORIZED_BODY


def test_download_requires_auth_for_api_requests(client):
    response = client.post('/download', json={}, headers=api_headers())

    assert response.status_code == 401
    assert response.get_json() == UNAUTHORIZED_BODY


def test_crop_requires_auth_for_api_requests(client):
    response = client.post('/crop', json={}, headers=api_headers())

    assert response.status_code == 401
    assert response.get_json() == UNAUTHORIZED_BODY


def test_theme_requires_auth_for_api_requests(client):
    response = client.post('/theme', json={'theme': 'dark'}, headers=api_headers())

    assert response.status_code == 401
    assert response.get_json() == UNAUTHORIZED_BODY


def test_authenticated_api_csrf_failure_returns_reload_contract(app, auth_client):
    app.config['WTF_CSRF_ENABLED'] = True

    response = auth_client.post('/download', json={}, headers=api_headers())

    assert response.status_code == 400
    assert response.get_json() == CSRF_FAILED_BODY


def test_process_rate_limit_returns_api_contract(app, auth_client):
    app.view_functions['main.process_image'] = app.limiter.limit(
        '1 per minute'
    )(app.view_functions['main.process_image'])

    response = auth_client.post('/process', data={
        'file': (io.BytesIO(make_image_bytes()), 'first.png'),
    }, headers=api_headers())
    assert response.status_code == 200

    limited = auth_client.post('/process', data={
        'file': (io.BytesIO(make_image_bytes()), 'second.png'),
    }, headers=api_headers())

    assert limited.status_code == 429
    assert limited.get_json() == RATE_LIMIT_BODY


def test_login_lockout_message_after_five_failed_attempts(client):
    csrf_token = login_csrf_token(client)

    for _ in range(5):
        response = client.post('/login', data={
            'password': 'wrong-password',
            'csrf_token': csrf_token,
        })
        assert response.status_code == 200

    locked_response = client.post('/login', data={
        'password': 'wrong-password',
        'csrf_token': csrf_token,
    })

    assert locked_response.status_code == 200
    assert b'Too many login attempts' in locked_response.data


def test_app_factory_registers_routes_without_import_context(app):
    assert 'main.index' in app.view_functions
    assert 'main.process_image' in app.view_functions


def test_index_template_uses_local_jszip(auth_client):
    response = auth_client.get('/')
    body = response.get_data(as_text=True)

    assert response.status_code == 200
    assert 'cdnjs.cloudflare.com' not in body
    assert 'js/vendor/jszip.min.js' in body
