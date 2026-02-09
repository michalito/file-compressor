import threading
import time
from functools import wraps

from flask import session, redirect, url_for, current_app
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.security import check_password_hash


class RateLimitExceeded(Exception):
    pass


class Auth:
    def __init__(self, app=None):
        self.app = app
        self.limiter = None
        self._lock = threading.Lock()
        if app is not None:
            self.init_app(app)

    def init_app(self, app):
        """Initialize the auth extension with the app"""
        self.app = app
        self.limiter = Limiter(
            app=app,
            key_func=get_remote_address,
            storage_uri="memory://"
        )

        # Store failed attempts (protected by _lock)
        self.login_attempts = {}
        self.max_attempts = 5
        self.lockout_time = 300  # 5 minutes

    def check_auth(self):
        """Check if user is authenticated"""
        return session.get('authenticated', False)

    def login(self, password):
        """Attempt to log in with the given password"""
        ip = get_remote_address()

        # Check lockout BEFORE try/except so RateLimitExceeded propagates
        if self._is_locked_out(ip):
            raise RateLimitExceeded("Too many login attempts. Try again later.")

        try:
            env_hash = current_app.config.get('PASSWORD_HASH')
            if not env_hash:
                current_app.logger.error("No password hash configured")
                return False

            is_valid = check_password_hash(env_hash, password)

            if is_valid:
                current_app.logger.info(f"Successful login from {ip}")
                session['authenticated'] = True
                session.permanent = True
                self._reset_attempts(ip)
                return True

            current_app.logger.warning(f"Failed login attempt from {ip}")
            self._record_failed_attempt(ip)
            return False

        except Exception as e:
            current_app.logger.error(f"Authentication error from {ip}: {e}")
            return False

    def _is_locked_out(self, ip):
        """Check if IP is locked out due to too many failed attempts"""
        with self._lock:
            if ip in self.login_attempts:
                attempts = self.login_attempts[ip]
                if attempts['count'] >= self.max_attempts:
                    if time.time() - attempts['last_attempt'] < self.lockout_time:
                        return True
                    self._reset_attempts_unlocked(ip)
            return False

    def _record_failed_attempt(self, ip):
        """Record a failed login attempt"""
        with self._lock:
            if ip not in self.login_attempts:
                self.login_attempts[ip] = {'count': 0, 'last_attempt': 0}
            self.login_attempts[ip]['count'] += 1
            self.login_attempts[ip]['last_attempt'] = time.time()

    def _reset_attempts(self, ip):
        """Reset failed attempts for an IP"""
        with self._lock:
            self._reset_attempts_unlocked(ip)

    def _reset_attempts_unlocked(self, ip):
        """Reset failed attempts (caller must hold _lock)"""
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
