import io

import pytest
from PIL import Image


def make_png(size=(800, 600), color=(64, 128, 192)):
    image = Image.new('RGB', size, color)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def post_process(auth_client, image_bytes, **fields):
    payload = {
        'file': (io.BytesIO(image_bytes), 'photo.png'),
        'compression_mode': 'lossless',
        **fields,
    }
    return auth_client.post('/process', data=payload, content_type='multipart/form-data')


def assert_resize_metadata(metadata, *, mode, requested_width, requested_height,
                           active, changed, upscaled):
    resize = metadata['resize']
    assert resize['mode'] == mode
    assert resize['requested_width'] == requested_width
    assert resize['requested_height'] == requested_height
    assert resize['active'] is active
    assert resize['changed'] is changed
    assert resize['upscaled'] is upscaled
    assert resize['strategy'] == 'fit_within_bounds'


def test_process_png_resize_width_only_downscales(auth_client):
    response = post_process(auth_client, make_png(), resize_mode='custom', max_width='400')

    assert response.status_code == 200
    metadata = response.get_json()['metadata']
    assert metadata['final_dimensions'] == [400, 300]
    assert_resize_metadata(
        metadata,
        mode='custom',
        requested_width=400,
        requested_height=None,
        active=True,
        changed=True,
        upscaled=False,
    )


def test_process_png_resize_height_only_downscales(auth_client):
    response = post_process(auth_client, make_png(), resize_mode='custom', max_height='200')

    assert response.status_code == 200
    metadata = response.get_json()['metadata']
    assert metadata['final_dimensions'] == [267, 200]
    assert_resize_metadata(
        metadata,
        mode='custom',
        requested_width=None,
        requested_height=200,
        active=True,
        changed=True,
        upscaled=False,
    )


def test_process_png_resize_both_bounds_downscales(auth_client):
    response = post_process(
        auth_client,
        make_png(),
        resize_mode='custom',
        max_width='400',
        max_height='400',
    )

    assert response.status_code == 200
    metadata = response.get_json()['metadata']
    assert metadata['final_dimensions'] == [400, 300]
    assert_resize_metadata(
        metadata,
        mode='custom',
        requested_width=400,
        requested_height=400,
        active=True,
        changed=True,
        upscaled=False,
    )


def test_process_png_resize_both_bounds_upscales(auth_client):
    response = post_process(
        auth_client,
        make_png(size=(300, 300)),
        resize_mode='custom',
        max_width='1920',
        max_height='1080',
    )

    assert response.status_code == 200
    metadata = response.get_json()['metadata']
    assert metadata['final_dimensions'] == [1080, 1080]
    assert_resize_metadata(
        metadata,
        mode='custom',
        requested_width=1920,
        requested_height=1080,
        active=True,
        changed=True,
        upscaled=True,
    )


def test_process_png_resize_equal_to_original_reports_active_without_change(auth_client):
    response = post_process(
        auth_client,
        make_png(),
        resize_mode='custom',
        max_width='800',
        max_height='600',
    )

    assert response.status_code == 200
    metadata = response.get_json()['metadata']
    assert metadata['final_dimensions'] == [800, 600]
    assert_resize_metadata(
        metadata,
        mode='custom',
        requested_width=800,
        requested_height=600,
        active=True,
        changed=False,
        upscaled=False,
    )


def test_process_png_custom_resize_requires_a_dimension(auth_client):
    response = post_process(auth_client, make_png(), resize_mode='custom')

    assert response.status_code == 400
    assert response.get_json() == {'error': 'Enter a width, a height, or both.'}


@pytest.mark.parametrize('field,value', [
    ('max_width', 'abc'),
    ('max_width', '400.5'),
    ('max_height', '1e3'),
    ('max_width', '-10'),
])
def test_process_png_rejects_malformed_resize_dimensions(auth_client, field, value):
    response = post_process(auth_client, make_png(), resize_mode='custom', **{field: value})

    assert response.status_code == 400
    assert 'whole-number' in response.get_json()['error']


@pytest.mark.parametrize('field,value,error', [
    ('max_width', '0', 'Width must be between 1 and 10000 px.'),
    ('max_height', '10001', 'Height must be between 1 and 10000 px.'),
])
def test_process_png_rejects_out_of_range_resize_dimensions(auth_client, field, value, error):
    response = post_process(auth_client, make_png(), resize_mode='custom', **{field: value})

    assert response.status_code == 400
    assert response.get_json() == {'error': error}
