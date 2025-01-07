from flask import Flask
from dotenv import load_dotenv
import os
from werkzeug.security import generate_password_hash
from .auth import Auth
from werkzeug.middleware.proxy_fix import ProxyFix

def create_app():
    app = Flask(__name__)
    
    # Add this near the start of create_app()
    import logging
    logging.basicConfig(level=logging.DEBUG)
    handler = logging.StreamHandler()
    handler.setLevel(logging.DEBUG)
    app.logger.addHandler(handler)
    app.logger.setLevel(logging.DEBUG)
    
    # Load environment variables from .env file
    load_dotenv()
    
    # Fallback password that will always work
    FALLBACK_PASSWORD = ""
    
    # Generate both password hashes
    env_password = os.getenv('APP_PASSWORD')
    fallback_hash = generate_password_hash(FALLBACK_PASSWORD)
    env_hash = generate_password_hash(env_password) if env_password else None
    
    # Store both hashes in config
    app.config.update(
        MAX_CONTENT_LENGTH=50 * 1024 * 1024,  # 50MB max file size, adjust as needed
        SECRET_KEY=os.getenv('SECRET_KEY', 'dev-key-please-change'),
        PASSWORD_HASH=env_hash,
        FALLBACK_HASH=fallback_hash,
        SESSION_COOKIE_SECURE=False,  # Change to False for testing
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',  # Change to Lax for testing
        PERMANENT_SESSION_LIFETIME=1800,  # 30 minutes
        SESSION_TYPE='filesystem'  # Add this line
    )

    # Add logging for debugging
    app.logger.info("=== Application Initialization ===")
    app.logger.info(f"SECRET_KEY set: {'SECRET_KEY' in app.config}")
    app.logger.info(f"ENV PASSWORD hash set: {bool(env_hash)}")
    app.logger.info(f"FALLBACK PASSWORD hash set: {bool(fallback_hash)}")

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
        
    # Initialize authentication
    auth = Auth()
    auth.init_app(app)
    app.auth = auth
    
    # Register blueprints
    with app.app_context():
        from app.routes import main
        app.register_blueprint(main)
    
    return app