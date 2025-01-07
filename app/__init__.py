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
    
    # Get the APP_PASSWORD and generate hash
    app_password = os.getenv('APP_PASSWORD')
    if not app_password:
        app.logger.error("APP_PASSWORD not set in environment")
        raise RuntimeError("APP_PASSWORD environment variable is required")
        
    password_hash = generate_password_hash(app_password)
    
    # Configure app
    app.config.update(
        MAX_CONTENT_LENGTH=16 * 1024 * 1024,  # 16MB max file size
        SECRET_KEY=os.getenv('SECRET_KEY', 'dev-key-please-change'),
        PASSWORD_HASH=password_hash,  # Store the generated hash in config
        SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Strict',
        PERMANENT_SESSION_LIFETIME=1800  # 30 minutes
    )

    # Add logging for debugging
    app.logger.info("App initialized with config values:")
    app.logger.info(f"SECRET_KEY set: {'SECRET_KEY' in app.config}")
    app.logger.info(f"PASSWORD_HASH generated and set: {'PASSWORD_HASH' in app.config}")

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