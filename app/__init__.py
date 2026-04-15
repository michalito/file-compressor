from flask import Flask, jsonify, request, session, url_for
from dotenv import load_dotenv
import os
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.security import generate_password_hash
from .auth import Auth, is_api_request
from .ai_upscale import configure_ai_upscale_app
from .validators import format_file_size_label
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_wtf.csrf import CSRFProtect, CSRFError
from flask_limiter.errors import RateLimitExceeded as LimiterRateLimitExceeded

def _read_version():
    for path in ('VERSION', os.path.join(os.path.dirname(__file__), '..', 'VERSION')):
        try:
            with open(path) as f:
                return f.read().strip()
        except OSError:
            continue
    return 'dev'


def _get_rate_limit(env_name, default):
    return os.getenv(env_name, default)


def create_app():
    app = Flask(__name__)

    # Load environment variables from .env file
    load_dotenv()

    # Determine if we're in production
    is_production = os.getenv('FLASK_ENV', 'development') == 'production'

    # Configure logging based on environment
    import logging
    log_level = logging.INFO if is_production else logging.DEBUG
    logging.basicConfig(level=log_level)
    handler = logging.StreamHandler()
    handler.setLevel(log_level)
    app.logger.addHandler(handler)
    app.logger.setLevel(log_level)

    # Get password from environment
    env_password = os.getenv('APP_PASSWORD')
    if not env_password:
        raise ValueError("APP_PASSWORD must be set in environment variables")

    # Validate SECRET_KEY in production
    secret_key = os.getenv('SECRET_KEY', 'dev-key-please-change')
    if is_production and secret_key == 'dev-key-please-change':
        raise ValueError("SECRET_KEY must be set in production environment")

    # Generate password hash
    env_hash = generate_password_hash(env_password)

    # Store configuration
    app.config.update(
        MAX_CONTENT_LENGTH=50 * 1024 * 1024,  # 50MB max file size
        SECRET_KEY=secret_key,
        WTF_CSRF_SECRET_KEY=secret_key,
        WTF_CSRF_TIME_LIMIT=3600,  # 1 hour CSRF token expiry
        WTF_CSRF_ENABLED=True,
        WTF_CSRF_CHECK_DEFAULT=True,
        PASSWORD_HASH=env_hash,
        SESSION_COOKIE_SECURE=is_production,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',
        PERMANENT_SESSION_LIFETIME=1800,  # 30 minutes
        PROPAGATE_EXCEPTIONS=True
    )
    configure_ai_upscale_app(app)

    # Configure ProxyFix for proper header handling
    if os.getenv('PROXY_FIX', 'false').lower() == 'true':
        app.wsgi_app = ProxyFix(
            app.wsgi_app,
            x_for=1,      # Number of proxy servers
            x_proto=1,    # Number of proxies that set X-Forwarded-Proto
            x_host=1,     # Number of proxies that set X-Forwarded-Host
            x_prefix=1    # Number of proxies that set X-Forwarded-Prefix
        )
    
    # Ensure instance folder exists
    try:
        os.makedirs(app.instance_path)
    except OSError:
        pass
        
    # Initialize CSRF protection
    csrf = CSRFProtect()
    csrf.init_app(app)

    # Initialize authentication and rate limiter
    auth = Auth()
    auth.init_app(app)
    app.auth = auth
    app.limiter = auth.limiter

    # Prevent CDN/proxy caching of dynamic responses (breaks session cookies)
    @app.after_request
    def set_cache_headers(response):
        if 'text/html' in response.content_type:
            response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
            response.headers['Pragma'] = 'no-cache'
        return response

    @app.errorhandler(CSRFError)
    def handle_csrf_error(error):
        if is_api_request():
            if not session.get('authenticated'):
                return jsonify({
                    'error': 'Authentication required',
                    'code': 'auth_required',
                    'redirect': url_for('main.login'),
                }), 401

            return jsonify({
                'error': error.description,
                'code': 'csrf_failed',
                'reload': True,
            }), 400

        return error.description, 400

    @app.errorhandler(LimiterRateLimitExceeded)
    def handle_rate_limit_error(error):
        response = error.get_response()

        if is_api_request():
            retry_after = response.headers.get('Retry-After')
            message = 'Rate limit exceeded. Try again shortly.'

            if request.endpoint == 'main.process_image':
                message = 'Rate limit exceeded for image processing. Try again shortly or use Retry Incomplete.'
            elif request.endpoint == 'main.ai_upscale_create_job':
                message = 'Rate limit exceeded for AI upscaling. Try again shortly or use Retry Incomplete.'
            elif request.endpoint == 'main.ai_upscale_preview_artifact':
                message = 'AI preview rate limit exceeded. Try again shortly.'
            elif request.endpoint == 'main.ai_upscale_download_artifact':
                message = 'AI download rate limit exceeded. Try again shortly.'
            elif request.endpoint == 'main.download_file':
                message = 'Download rate limit exceeded. Try again shortly.'
            elif request.endpoint == 'main.ai_upscale_download_all':
                message = 'AI download rate limit exceeded. Try again shortly.'
            elif request.endpoint == 'main.crop_image':
                message = 'Crop rate limit exceeded. Try again shortly.'

            payload = {
                'error': message,
                'code': 'rate_limit_exceeded',
            }

            headers = {}
            if retry_after:
                payload['retry_after'] = retry_after
                headers['Retry-After'] = retry_after

            return jsonify(payload), 429, headers

        return response

    @app.errorhandler(RequestEntityTooLarge)
    def handle_request_entity_too_large(error):
        max_upload_bytes = app.config.get('MAX_CONTENT_LENGTH', 50 * 1024 * 1024)
        message = f'Uploaded file is too large. Maximum file size is {format_file_size_label(max_upload_bytes)}.'

        if is_api_request():
            return jsonify({
                'error': message,
                'user_message': message,
                'code': 'file_too_large',
                'limit_bytes': max_upload_bytes,
            }), 413

        return message, 413

    # Make app version available to all templates
    app.jinja_env.globals['app_version'] = _read_version()

    # Register blueprints
    from app.routes import main
    app.register_blueprint(main)

    # Apply rate limits to routes (must store wrapped function back)
    limiter = app.limiter
    app.view_functions['main.login'] = limiter.limit(
        _get_rate_limit('LOGIN_RATE_LIMIT', "10 per minute")
    )(app.view_functions['main.login'])
    app.view_functions['main.process_image'] = limiter.limit(
        _get_rate_limit('PROCESS_RATE_LIMIT', "120 per minute")
    )(app.view_functions['main.process_image'])
    app.view_functions['main.download_file'] = limiter.limit(
        _get_rate_limit('DOWNLOAD_RATE_LIMIT', "120 per minute")
    )(app.view_functions['main.download_file'])
    app.view_functions['main.crop_image'] = limiter.limit(
        _get_rate_limit('CROP_RATE_LIMIT', "30 per minute")
    )(app.view_functions['main.crop_image'])
    if 'main.ai_upscale_create_job' in app.view_functions:
        app.view_functions['main.ai_upscale_create_job'] = limiter.limit(
            _get_rate_limit('AI_UPSCALE_RATE_LIMIT', "60 per minute")
        )(app.view_functions['main.ai_upscale_create_job'])
    if 'main.ai_upscale_download_all' in app.view_functions:
        app.view_functions['main.ai_upscale_download_all'] = limiter.limit(
            _get_rate_limit('AI_UPSCALE_DOWNLOAD_RATE_LIMIT', "60 per minute")
        )(app.view_functions['main.ai_upscale_download_all'])
    if 'main.ai_upscale_preview_artifact' in app.view_functions:
        app.view_functions['main.ai_upscale_preview_artifact'] = limiter.limit(
            _get_rate_limit('AI_UPSCALE_ARTIFACT_RATE_LIMIT', "120 per minute")
        )(app.view_functions['main.ai_upscale_preview_artifact'])
    if 'main.ai_upscale_download_artifact' in app.view_functions:
        app.view_functions['main.ai_upscale_download_artifact'] = limiter.limit(
            _get_rate_limit('AI_UPSCALE_ARTIFACT_RATE_LIMIT', "120 per minute")
        )(app.view_functions['main.ai_upscale_download_artifact'])

    return app
