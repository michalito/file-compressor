from flask import Flask
from dotenv import load_dotenv
import os
from werkzeug.security import generate_password_hash
from .auth import Auth
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_wtf.csrf import CSRFProtect

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

    # Register blueprints
    with app.app_context():
        from app.routes import main
        app.register_blueprint(main)

    # Apply rate limits to routes (must store wrapped function back)
    limiter = app.limiter
    app.view_functions['main.login'] = limiter.limit("10 per minute")(app.view_functions['main.login'])
    app.view_functions['main.process_image'] = limiter.limit("30 per minute")(app.view_functions['main.process_image'])
    app.view_functions['main.download_file'] = limiter.limit("120 per minute")(app.view_functions['main.download_file'])

    return app