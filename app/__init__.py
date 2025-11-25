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

    # Configure logging based on environment
    import logging
    is_production = os.getenv('FLASK_ENV', 'development') == 'production'
    log_level = logging.WARNING if is_production else logging.DEBUG

    logging.basicConfig(level=log_level)
    handler = logging.StreamHandler()
    handler.setLevel(log_level)
    app.logger.addHandler(handler)
    app.logger.setLevel(log_level)

    # Get password from environment
    env_password = os.getenv('APP_PASSWORD')
    if not env_password:
        app.logger.error("CRITICAL: APP_PASSWORD not set in environment variables")
        raise ValueError("APP_PASSWORD must be set in environment variables")

    # Generate password hash
    env_hash = generate_password_hash(env_password)

    # Store configuration
    app.config.update(
        MAX_CONTENT_LENGTH=50 * 1024 * 1024,  # 50MB max file size, adjust as needed
        SECRET_KEY=os.getenv('SECRET_KEY', 'dev-key-please-change'),
        WTF_CSRF_SECRET_KEY=os.getenv('SECRET_KEY', 'dev-key-please-change'),  # CSRF secret
        WTF_CSRF_TIME_LIMIT=None,  # No time limit for CSRF tokens
        WTF_CSRF_ENABLED=True,  # Enable CSRF protection
        WTF_CSRF_CHECK_DEFAULT=True,  # Check CSRF by default
        PASSWORD_HASH=env_hash,
        SESSION_COOKIE_SECURE=is_production,  # Secure in production
        SESSION_COOKIE_HTTPONLY=True,  # Always httponly for security
        SESSION_COOKIE_SAMESITE='Lax',  # Use Lax for both dev and prod to allow CSRF
        PERMANENT_SESSION_LIFETIME=1800,  # 30 minutes
        SESSION_TYPE='filesystem',
        REQUEST_TIMEOUT=60,
        PROPAGATE_EXCEPTIONS=True
    )

    # Add logging for debugging
    app.logger.info("=== Application Initialization ===")
    app.logger.info(f"Environment: {'production' if is_production else 'development'}")
    app.logger.info(f"SECRET_KEY set: {app.config['SECRET_KEY'] != 'dev-key-please-change'}")
    app.logger.info(f"PASSWORD hash set: {bool(env_hash)}")
    app.logger.info(f"Secure cookies: {app.config['SESSION_COOKIE_SECURE']}")

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

    # Initialize authentication
    auth = Auth()
    auth.init_app(app)
    app.auth = auth
    
    # Register blueprints
    with app.app_context():
        from app.routes import main
        app.register_blueprint(main)
    
    return app