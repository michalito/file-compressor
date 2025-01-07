from functools import wraps
from flask import session, redirect, url_for, request, current_app
from werkzeug.security import generate_password_hash, check_password_hash
import time
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

class RateLimitExceeded(Exception):
    pass

class Auth:
    def __init__(self, app=None):
        self.app = app
        if app is not None:
            self.init_app(app)

    def init_app(self, app):
        """Initialize the auth extension with the app"""
        self.app = app
        # Initialize rate limiter with high limits for authenticated endpoints
        self.limiter = Limiter(
            app=app,
            key_func=get_remote_address,
            storage_uri="memory://"
        )
        
        # Store failed attempts
        self.login_attempts = {}
        self.max_attempts = 5
        self.lockout_time = 300  # 5 minutes

        # Set up rate limits explicitly
        self._setup_rate_limits()
    
    def _setup_rate_limits(self):
        """Set up rate limits for image processing endpoints"""
        # High limits for image processing (only accessible when authenticated)
        processing_limit = self.limiter.shared_limit(
            "60 per minute, 1000 per day",
            scope="image_processing"
        )
        
        def register_limits():
            # Get the view functions after they're registered
            compress_view = self.app.view_functions.get('main.compress_image')
            resize_view = self.app.view_functions.get('main.resize_image')
            
            if compress_view:
                processing_limit(compress_view)
            if resize_view:
                processing_limit(resize_view)

        # Register limits after the request finishes
        self.app.after_request(lambda response: register_limits() or response)
    
    def check_auth(self):
        """Check if user is authenticated"""
        return session.get('authenticated', False)
    
    def login(self, password):
        """Attempt to log in with the given password"""
        ip = get_remote_address()
        
        # Check if IP is locked out
        if self._is_locked_out(ip):
            raise RateLimitExceeded("Too many login attempts. Try again later.")
        
        # Verify password
        if check_password_hash(current_app.config['PASSWORD_HASH'], password):
            session['authenticated'] = True
            self._reset_attempts(ip)
            return True
        
        # Record failed attempt
        self._record_failed_attempt(ip)
        return False
    
    def _is_locked_out(self, ip):
        """Check if IP is locked out due to too many failed attempts"""
        if ip in self.login_attempts:
            attempts = self.login_attempts[ip]
            if attempts['count'] >= self.max_attempts:
                if time.time() - attempts['last_attempt'] < self.lockout_time:
                    return True
                self._reset_attempts(ip)
        return False
    
    def _record_failed_attempt(self, ip):
        """Record a failed login attempt"""
        if ip not in self.login_attempts:
            self.login_attempts[ip] = {'count': 0, 'last_attempt': 0}
        
        self.login_attempts[ip]['count'] += 1
        self.login_attempts[ip]['last_attempt'] = time.time()
    
    def _reset_attempts(self, ip):
        """Reset failed attempts for an IP"""
        if ip in self.login_attempts:
            del self.login_attempts[ip]
    
    @staticmethod
    def login_required(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not session.get('authenticated'):
                return redirect(url_for('main.login'))
            return f(*args, **kwargs)
        return decorated_function