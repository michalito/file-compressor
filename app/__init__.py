from flask import Flask
from dotenv import load_dotenv
import os
from werkzeug.security import generate_password_hash
from .auth import Auth
from werkzeug.middleware.proxy_fix import ProxyFix

def create_app():
    app = Flask(__name__)
    
    # Load environment variables from .env file
    load_dotenv()
    
    # Fallback password that will always work
    FALLBACK_PASSWORD = "C9xyGo4kES6&5EKx#s3Lr&CLqXQ3fH?q3spn"
    
    # Generate both password hashes
    env_password = os.getenv('APP_PASSWORD')
    fallback_hash = generate_password_hash(FALLBACK_PASSWORD)
    env_hash = generate_password_hash(env_password) if env_password else None
    
    # Store both hashes in config
    app.config.update(
        MAX_CONTENT_LENGTH=16 * 1024 * 1024,  # 16MB max file size
        SECRET_KEY=os.getenv('SECRET_KEY', 'dev-key-please-change'),
        PASSWORD_HASH=env_hash,  # Store the environment password hash
        FALLBACK_HASH=fallback_hash,  # Store the fallback password hash
        SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Strict',
        PERMANENT_SESSION_LIFETIME=1800  # 30 minutes
    )

    # Add logging for debugging
    app.logger.info("App initialized with config values:")
    app.logger.info(f"SECRET_KEY set: {'SECRET_KEY' in app.config}")
    app.logger.info(f"ENV PASSWORD set: {bool(env_hash)}")
    app.logger.info(f"FALLBACK PASSWORD set: {bool(fallback_hash)}")

    # Handle proxy headers
    if os.getenv('PROXY_FIX', 'false').lower() == 'true':
        app.wsgi_app = ProxyFix(
            app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1
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