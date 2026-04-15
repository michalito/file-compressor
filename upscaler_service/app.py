from __future__ import annotations

import hmac
import os

from flask import Flask, jsonify, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge

from .service import UpscalerService, UpscalerServiceConfig, UpscalerServiceError


def _parse_int(value, *, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _format_file_size_label(size_bytes: int) -> str:
    units = (
        ('GB', 1024 ** 3),
        ('MB', 1024 ** 2),
        ('KB', 1024),
    )
    for suffix, factor in units:
        if size_bytes >= factor:
            value = size_bytes / factor
            if value.is_integer():
                return f'{int(value)} {suffix}'
            return f'{value:.1f} {suffix}'
    return f'{int(size_bytes)} bytes'


def create_upscaler_app(config: UpscalerServiceConfig | None = None) -> Flask:
    app = Flask(__name__)
    service = UpscalerService(config or UpscalerServiceConfig.from_env())
    max_upload_bytes = max(1, _parse_int(os.getenv('AI_UPSCALER_MAX_UPLOAD_BYTES'), default=50 * 1024 * 1024))
    app.config['MAX_CONTENT_LENGTH'] = max_upload_bytes
    app.upscaler_service = service

    @app.before_request
    def authenticate_request():
        api_key = service.config.api_key
        if api_key and not hmac.compare_digest(request.headers.get('X-API-Key', ''), api_key):
            return jsonify({'error': 'Unauthorized'}), 401
        return None

    @app.errorhandler(UpscalerServiceError)
    def handle_service_error(error: UpscalerServiceError):
        payload = {'error': error.payload.get('user_message') or error.message}
        payload.update(error.payload)
        return jsonify(payload), error.status_code

    @app.errorhandler(RequestEntityTooLarge)
    def handle_request_entity_too_large(error):
        del error
        message = (
            'Uploaded file is too large. '
            f'Maximum file size is {_format_file_size_label(app.config["MAX_CONTENT_LENGTH"])}.'
        )
        return jsonify({
            'error': message,
            'user_message': message,
            'code': 'file_too_large',
            'limit_bytes': app.config['MAX_CONTENT_LENGTH'],
        }), 413

    @app.get('/health')
    def health():
        health_result = service.get_health(force_refresh=bool(request.args.get('refresh')))
        return jsonify(health_result), (200 if health_result.get('healthy') else 503)

    @app.post('/jobs')
    def create_job():
        file = request.files.get('file')
        if not file or not file.filename:
            raise UpscalerServiceError('No file provided.', status_code=400)

        model_preset = (request.form.get('model_preset') or 'photo').strip().lower()
        if model_preset not in {'photo', 'anime'}:
            raise UpscalerServiceError('Invalid AI upscaling model preset.', status_code=400)

        scale = _parse_int(request.form.get('scale'), default=2)
        if scale not in {2, 4}:
            raise UpscalerServiceError('AI upscaling scale must be 2 or 4.', status_code=400)

        output_format = (request.form.get('output_format') or 'png').strip().lower()
        if output_format not in {'png', 'webp', 'jpeg'}:
            raise UpscalerServiceError('Invalid AI upscaling output format.', status_code=400)

        quality = request.form.get('quality')
        if quality not in (None, ''):
            quality = _parse_int(quality, default=-1)
            if not 1 <= quality <= 100:
                raise UpscalerServiceError('AI upscaling quality must be between 1 and 100.', status_code=400)
        else:
            quality = None

        payload = service.submit_job(
            file_bytes=file.read(),
            filename=file.filename,
            content_type=file.mimetype,
            settings={
                'model_preset': model_preset,
                'scale': scale,
                'output_format': output_format,
                'quality': quality,
            },
        )
        return jsonify(payload), 202

    @app.get('/jobs/<job_id>')
    def get_job(job_id: str):
        return jsonify(service.serialize_job(job_id))

    @app.post('/jobs/<job_id>/cancel')
    def cancel_job(job_id: str):
        return jsonify(service.cancel_job(job_id))

    @app.delete('/jobs/<job_id>')
    def delete_job(job_id: str):
        return jsonify(service.delete_job(job_id))

    @app.get('/artifacts/<artifact_id>/preview')
    def preview_artifact(artifact_id: str):
        artifact = service.get_artifact(artifact_id, 'preview')
        return send_file(
            artifact.path,
            mimetype=artifact.mime_type,
            download_name=artifact.filename,
            as_attachment=False,
            conditional=False,
            max_age=0,
        )

    @app.get('/artifacts/<artifact_id>/download')
    def download_artifact(artifact_id: str):
        artifact = service.get_artifact(artifact_id, 'download')
        return send_file(
            artifact.path,
            mimetype=artifact.mime_type,
            download_name=artifact.filename,
            as_attachment=True,
            conditional=False,
            max_age=0,
        )

    @app.post('/download-all')
    def download_all():
        payload = request.get_json(silent=True) or {}
        bundle = service.create_download_bundle(payload.get('artifacts'))
        response = send_file(
            bundle.path,
            mimetype=bundle.mime_type,
            download_name=bundle.filename,
            as_attachment=True,
            conditional=False,
            max_age=0,
        )
        response.call_on_close(bundle.cleanup)
        return response

    return app
