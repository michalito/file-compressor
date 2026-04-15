from __future__ import annotations

import io
import json
import mimetypes
import os
import uuid
from dataclasses import dataclass
from typing import Iterable, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import quote

from flask import current_app
from PIL import Image

from .validators import format_file_size_label

ALLOWED_AI_MODEL_PRESETS = {'photo', 'anime'}
ALLOWED_AI_SCALES = {2, 4}
ALLOWED_AI_OUTPUT_FORMATS = {'png', 'webp', 'jpeg'}
DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
DEFAULT_AI_QUALITY = {
    'png': None,
    'webp': 90,
    'jpeg': 92,
}


def detect_image_bit_depth(image: Image.Image) -> int:
    mode = (image.mode or '').upper()
    if mode.startswith('I;16'):
        return 16

    bands = image.getbands() or ()
    for band in bands:
        try:
            sample = image.getchannel(band)
            extrema = sample.getextrema()
        except Exception:
            continue

        if isinstance(extrema, tuple) and max(extrema) > 255:
            return 16
    return 8


class AIUpscalerError(Exception):
    def __init__(self, message: str, status_code: int = 502, payload: Optional[dict] = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


@dataclass(frozen=True)
class AIUpscaleSettings:
    model_preset: str
    scale: int
    output_format: str
    quality: Optional[int]


@dataclass
class AIUpscaleStream:
    response: object
    content_type: str
    filename: Optional[str]
    content_length: Optional[int]

    def close(self) -> None:
        try:
            self.response.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        del exc_type, exc, tb
        self.close()
        return False


def get_ai_upscaler_enabled() -> bool:
    return bool(current_app.config.get('AI_UPSCALER_ENABLED'))


def get_ai_max_upload_bytes() -> int:
    raw_value = current_app.config.get('MAX_CONTENT_LENGTH')
    try:
        limit_bytes = int(raw_value)
    except (TypeError, ValueError):
        return DEFAULT_MAX_UPLOAD_BYTES
    return limit_bytes if limit_bytes > 0 else DEFAULT_MAX_UPLOAD_BYTES


def _read_bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {'1', 'true', 'yes', 'on'}


def configure_ai_upscale_app(app) -> None:
    app.config.setdefault('AI_UPSCALER_ENABLED', _read_bool_env('AI_UPSCALER_ENABLED', False))
    app.config.setdefault('AI_UPSCALER_URL', os.getenv('AI_UPSCALER_URL', 'http://127.0.0.1:8765'))
    app.config.setdefault('AI_UPSCALER_API_KEY', os.getenv('AI_UPSCALER_API_KEY', ''))
    app.config.setdefault('AI_UPSCALE_MAX_OUTPUT_DIMENSION', int(os.getenv('AI_UPSCALE_MAX_OUTPUT_DIMENSION', '12000')))
    app.config.setdefault('AI_UPSCALE_MAX_OUTPUT_PIXELS', int(os.getenv('AI_UPSCALE_MAX_OUTPUT_PIXELS', '100000000')))
    app.config.setdefault('AI_UPSCALE_ARTIFACT_TTL_SECONDS', int(os.getenv('AI_UPSCALE_ARTIFACT_TTL_SECONDS', '21600')))


def parse_ai_upscale_settings(form) -> AIUpscaleSettings:
    model_preset = (form.get('model_preset') or 'photo').strip().lower()
    if model_preset not in ALLOWED_AI_MODEL_PRESETS:
        raise AIUpscalerError('Invalid AI upscaling model preset.', status_code=400)

    scale_raw = (form.get('scale') or '2').strip()
    if not scale_raw.isdigit():
        raise AIUpscalerError('AI upscaling scale must be 2 or 4.', status_code=400)
    scale = int(scale_raw)
    if scale not in ALLOWED_AI_SCALES:
        raise AIUpscalerError('AI upscaling scale must be 2 or 4.', status_code=400)

    output_format = (form.get('output_format') or 'png').strip().lower()
    if output_format not in ALLOWED_AI_OUTPUT_FORMATS:
        raise AIUpscalerError('Invalid AI upscaling output format.', status_code=400)

    quality_raw = form.get('quality')
    if output_format == 'png':
        quality = None
    else:
        if quality_raw in (None, ''):
            quality = DEFAULT_AI_QUALITY[output_format]
        else:
            try:
                quality = int(quality_raw)
            except (TypeError, ValueError) as exc:
                raise AIUpscalerError('AI upscaling quality must be an integer between 1 and 100.', status_code=400) from exc
            if quality < 1 or quality > 100:
                raise AIUpscalerError('AI upscaling quality must be between 1 and 100.', status_code=400)

    return AIUpscaleSettings(
        model_preset=model_preset,
        scale=scale,
        output_format=output_format,
        quality=quality,
    )


def validate_ai_upscale_upload(file, image_bytes: bytes, settings: AIUpscaleSettings):
    max_upload_bytes = get_ai_max_upload_bytes()
    if len(image_bytes) > max_upload_bytes:
        limit_label = format_file_size_label(max_upload_bytes)
        message = f'This image is too large to upload. Maximum file size is {limit_label}.'
        raise AIUpscalerError(
            message,
            status_code=413,
            payload={
                'code': 'file_too_large',
                'user_message': message,
                'limit_bytes': max_upload_bytes,
            },
        )

    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            bit_depth = detect_image_bit_depth(image)
            if bit_depth > 8:
                message = '16-bit AI upscaling inputs are not supported yet. Convert the image to 8-bit and try again.'
                raise AIUpscalerError(
                    message,
                    status_code=400,
                    payload={
                        'code': 'unsupported_bit_depth',
                        'user_message': message,
                        'bit_depth': bit_depth,
                    },
                )
            width, height = image.size
            output_width = width * settings.scale
            output_height = height * settings.scale
            output_pixels = output_width * output_height
    except AIUpscalerError:
        raise
    except Exception as exc:
        raise AIUpscalerError(f'Invalid image file: {exc}', status_code=400) from exc

    max_dimension = current_app.config['AI_UPSCALE_MAX_OUTPUT_DIMENSION']
    max_pixels = current_app.config['AI_UPSCALE_MAX_OUTPUT_PIXELS']
    if output_width > max_dimension or output_height > max_dimension or output_pixels > max_pixels:
        suggested_scale = 2 if settings.scale == 4 else None
        message = (
            f'This image would become {output_width:,} x {output_height:,} at {settings.scale}x, '
            f'which is larger than this app allows.'
        )
        if suggested_scale:
            message += f' Try {suggested_scale}x instead.'
        raise AIUpscalerError(
            message,
            status_code=400,
            payload={
                'code': 'output_limit_exceeded',
                'user_message': message,
                'projected_output': {
                    'width': output_width,
                    'height': output_height,
                    'pixels': output_pixels,
                },
                'limit': {
                    'max_dimension': max_dimension,
                    'max_pixels': max_pixels,
                },
                **({'suggested_scale': suggested_scale} if suggested_scale else {}),
            },
        )


def get_ai_health():
    if not get_ai_upscaler_enabled():
        return {
            'enabled': False,
            'healthy': False,
            'state': 'disabled',
            'backend': None,
            'worker_instance_id': None,
            'started_at': None,
            'reason': 'AI upscaling is disabled in configuration.',
            'details': {},
        }

    response = _request_json('GET', '/health')
    response['enabled'] = True
    return response


def create_ai_job(*, file_bytes: bytes, filename: str, content_type: str, settings: AIUpscaleSettings):
    fields = [
        ('model_preset', settings.model_preset),
        ('scale', str(settings.scale)),
        ('output_format', settings.output_format),
    ]
    if settings.quality is not None:
        fields.append(('quality', str(settings.quality)))

    files = [
        ('file', filename, content_type or mimetypes.guess_type(filename)[0] or 'application/octet-stream', file_bytes),
    ]
    return _request_json('POST', '/jobs', fields=fields, files=files)


def get_ai_job(job_id: str):
    return _request_json('GET', f'/jobs/{_quote_path_segment(job_id)}')


def cancel_ai_job(job_id: str):
    return _request_json('POST', f'/jobs/{_quote_path_segment(job_id)}/cancel')


def delete_ai_job(job_id: str):
    return _request_json('DELETE', f'/jobs/{_quote_path_segment(job_id)}')


def open_ai_artifact_stream(artifact_id: str, kind: str = 'download') -> AIUpscaleStream:
    return _open_stream('GET', f'/artifacts/{_quote_path_segment(artifact_id)}/{_quote_path_segment(kind)}')


def open_ai_download_all_stream(artifacts: list[dict]) -> AIUpscaleStream:
    return _open_stream('POST', '/download-all', data={'artifacts': artifacts})


def fetch_ai_artifact(artifact_id: str, kind: str = 'download'):
    stream = open_ai_artifact_stream(artifact_id, kind=kind)
    try:
        return stream.response.read(), stream.content_type, stream.filename
    finally:
        stream.close()


def build_ai_job_snapshot(entry) -> Optional[dict]:
    if not entry.get('job'):
        return None
    result = entry['job'].get('result')
    return {
        'workflow': 'ai-upscale',
        'jobId': entry['job'].get('job_id'),
        'status': entry['job'].get('status'),
        'phase': entry['job'].get('phase'),
        'progress': entry['job'].get('progress'),
        'queuePosition': entry['job'].get('queue_position'),
        'workerInstanceId': entry['job'].get('worker_instance_id'),
        'result': {
            'filename': result.get('filename') if result else None,
            'metadata': result.get('metadata') if result else None,
            'artifactRefs': result.get('artifacts') if result else None,
        } if result else None,
    }


def iter_ai_stream(stream: AIUpscaleStream, chunk_size: int = 64 * 1024):
    while True:
        chunk = stream.response.read(chunk_size)
        if not chunk:
            break
        yield chunk


def _get_upscaler_url(path: str) -> str:
    base_url = current_app.config['AI_UPSCALER_URL'].rstrip('/')
    return f'{base_url}{path}'


def _get_headers(content_type: Optional[str] = None, *, accept: str = 'application/json') -> dict:
    headers = {
        'Accept': accept,
    }
    api_key = current_app.config.get('AI_UPSCALER_API_KEY')
    if api_key:
        headers['X-API-Key'] = api_key
    if content_type:
        headers['Content-Type'] = content_type
    return headers


def _request_json(method: str, path: str, *, data: Optional[dict] = None,
                  fields: Optional[Iterable[tuple[str, str]]] = None,
                  files: Optional[Iterable[tuple[str, str, str, bytes]]] = None) -> dict:
    body = None
    headers = _get_headers()

    if data is not None:
        body = json.dumps(data).encode('utf-8')
        headers = _get_headers('application/json')
    elif fields is not None or files is not None:
        body, content_type = _encode_multipart(fields or [], files or [])
        headers = _get_headers(content_type)

    req = urllib_request.Request(_get_upscaler_url(path), data=body, headers=headers, method=method)
    try:
        with urllib_request.urlopen(req, timeout=120) as response:
            payload = response.read()
            return json.loads(payload.decode('utf-8'))
    except urllib_error.HTTPError as exc:
        raise _build_proxy_error(exc) from exc
    except urllib_error.URLError as exc:
        raise AIUpscalerError('AI upscaling service is unavailable.', status_code=503) from exc


def _open_stream(method: str, path: str, *, data: Optional[dict] = None) -> AIUpscaleStream:
    body = None
    headers = _get_headers(accept='*/*')
    if data is not None:
        body = json.dumps(data).encode('utf-8')
        headers = _get_headers('application/json', accept='*/*')

    req = urllib_request.Request(_get_upscaler_url(path), data=body, headers=headers, method=method)
    try:
        response = urllib_request.urlopen(req, timeout=120)
        content_length = response.headers.get('Content-Length')
        return AIUpscaleStream(
            response=response,
            content_type=response.headers.get_content_type() or 'application/octet-stream',
            filename=response.headers.get_filename(),
            content_length=int(content_length) if content_length and content_length.isdigit() else None,
        )
    except urllib_error.HTTPError as exc:
        raise _build_proxy_error(exc) from exc
    except urllib_error.URLError as exc:
        raise AIUpscalerError('AI upscaling service is unavailable.', status_code=503) from exc


def _build_proxy_error(exc: urllib_error.HTTPError) -> AIUpscalerError:
    payload = exc.read()
    details = {}
    message = f'AI upscaling service error ({exc.code}).'
    if payload:
        try:
            details = json.loads(payload.decode('utf-8'))
            message = (
                details.get('user_message')
                or details.get('error')
                or details.get('message')
                or details.get('reason')
                or message
            )
        except json.JSONDecodeError:
            message = payload.decode('utf-8', errors='replace') or message
    return AIUpscalerError(message, status_code=exc.code, payload=details)


def _encode_multipart(fields: Iterable[tuple[str, str]], files: Iterable[tuple[str, str, str, bytes]]):
    boundary = f'compressify-{uuid.uuid4().hex}'
    body = bytearray()

    for name, value in fields:
        safe_name = _escape_multipart_header_value(name)
        body.extend(f'--{boundary}\r\n'.encode('utf-8'))
        body.extend(f'Content-Disposition: form-data; name="{safe_name}"\r\n\r\n'.encode('utf-8'))
        body.extend(str(value).encode('utf-8'))
        body.extend(b'\r\n')

    for field_name, filename, content_type, content in files:
        safe_field_name = _escape_multipart_header_value(field_name)
        safe_filename = _escape_multipart_header_value(filename)
        body.extend(f'--{boundary}\r\n'.encode('utf-8'))
        body.extend(
            (
                f'Content-Disposition: form-data; name="{safe_field_name}"; '
                f'filename="{safe_filename}"\r\n'
            ).encode('utf-8')
        )
        body.extend(f'Content-Type: {content_type}\r\n\r\n'.encode('utf-8'))
        body.extend(content)
        body.extend(b'\r\n')

    body.extend(f'--{boundary}--\r\n'.encode('utf-8'))
    return bytes(body), f'multipart/form-data; boundary={boundary}'


def _escape_multipart_header_value(value: str) -> str:
    return str(value).replace('\\', '\\\\').replace('"', '\\"').replace('\r', '').replace('\n', '')


def _quote_path_segment(value: str) -> str:
    return quote(str(value), safe='')
