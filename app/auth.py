import threading
import time
from functools import wraps

from flask import session, redirect, url_for, current_app, jsonify, request
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.security import check_password_hash


class RateLimitExceeded(Exception):
    pass


def is_api_request():
    accept = request.headers.get('Accept', '').lower()
    requested_with = request.headers.get('X-Requested-With', '')
    return (
        request.is_json
        or 'application/json' in accept
        or requested_with == 'fetch'
    )


def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if session.get('authenticated'):
            return f(*args, **kwargs)

        if is_api_request():
            return jsonify({
                'error': 'Authentication required',
                'code': 'auth_required',
                'redirect': url_for('main.login'),
            }), 401

        return redirect(url_for('main.login'))

    return decorated_function


class Auth:
    def __init__(self, app=None):
        self.app = app
        self.limiter = None
        self._lock = threading.Lock()
        if app is not None:
            self.init_app(app)

    def init_app(self, app):
        """Initialize the auth extension with the app.

        NOTE: Rate limiting and login attempt tracking are in-memory only.
        This means they reset on server restart and are not shared across
        Gunicorn workers. The production config therefore defaults to a
        single worker so the documented limits behave consistently. For
        multi-user deployments, switch storage_uri to a Redis or Memcached
        backend and move login attempt tracking out of process memory.
        """
        self.app = app
        self.limiter = Limiter(
            app=app,
            key_func=get_remote_address,
            storage_uri="memory://"
        )

        # Store failed attempts (protected by _lock) — in-memory, per-worker
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
        remaining = self._lockout_remaining(ip)
        if remaining > 0:
            minutes = max(1, int(remaining // 60) + (1 if remaining % 60 > 0 else 0))
            raise RateLimitExceeded(
                f"Too many login attempts. Try again in {minutes} minute{'s' if minutes != 1 else ''}."
            )

        try:
            env_hash = current_app.config.get('PASSWORD_HASH')
            if not env_hash:
                current_app.logger.error("No password hash configured")
                return False

            is_valid = check_password_hash(env_hash, password)

            if is_valid:
                current_app.logger.info(f"Successful login from {ip}")
                # Clear pre-login session data to prevent session fixation.
                # For cookie-based sessions this is sufficient; server-side
                # session backends would also need ID regeneration.
                session.clear()
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
        return self._lockout_remaining(ip) > 0

    def _lockout_remaining(self, ip):
        """Return remaining lockout seconds for IP, or 0 if not locked out."""
        with self._lock:
            if ip in self.login_attempts:
                attempts = self.login_attempts[ip]
                if attempts['count'] >= self.max_attempts:
                    elapsed = time.time() - attempts['last_attempt']
                    if elapsed < self.lockout_time:
                        return self.lockout_time - elapsed
                    self._reset_attempts_unlocked(ip)
            return 0

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
