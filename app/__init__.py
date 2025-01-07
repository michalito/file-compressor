from flask import Flask
from dotenv import load_dotenv
import os
from werkzeug.security import generate_password_hash
from .auth import Auth

def create_app():
    app = Flask(__name__)
    
    # Load environment variables from .env file
    load_dotenv()
    
    # Configure app
    app.config.update(
        MAX_CONTENT_LENGTH=16 * 1024 * 1024,  # 16MB max file size
        SECRET_KEY=os.getenv('SECRET_KEY', 'dev-key-please-change'),
        PASSWORD_HASH=generate_password_hash(os.getenv('APP_PASSWORD', 'change-this-password')),
        SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Strict',
        PERMANENT_SESSION_LIFETIME=1800  # 30 minutes
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