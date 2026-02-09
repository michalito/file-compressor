# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Running the Application

Local development (Flask development server):
```bash
python run.py
```
Debug mode is controlled by `FLASK_DEBUG=1` environment variable (off by default).

Production with Docker Compose:
```bash
docker-compose up --build -d
docker-compose logs -f  # View logs
```

Production with Docker:
```bash
docker build -t image-compressor:prod .
docker run -d --name image-compressor -p 8000:8000 \
   -e SECRET_KEY=your-production-secret-key \
   -e APP_PASSWORD=your-secure-password \
   image-compressor:prod
```

### Testing

Currently no test suite is configured. When implementing tests:
- Create test files in a `tests/` directory
- Use pytest for testing: `pytest tests/`

### Environment Setup

1. Copy and configure environment variables:
```bash
cp example.env .env
# Edit .env with required values (APP_PASSWORD and SECRET_KEY)
```

2. Install dependencies for local development:
```bash
python -m venv venv
source venv/bin/activate  # Linux/Mac
pip install -r requirements.txt
```

## Architecture Overview

### Core Components

**Flask Application Structure**:
- `app/__init__.py`: Application factory pattern, configures Flask app with authentication, rate limiting, CSRF protection (1-hour token expiry), and session management
- `app/routes.py`: Main blueprint with endpoints for image processing (`/process`), download (`/download`), authentication (`/login`, `/logout`), and theme switching (`/theme`)
- `app/auth.py`: Authentication class with decorator-based login protection, thread-safe brute-force protection, and Flask-Limiter integration
- `app/forms.py`: Flask-WTF forms providing CSRF protection for login
- `app/validators.py`: Centralized input validation module for files, parameters, and user inputs
- `app/compression/image_processor.py`: Core ImageCompressor class with three compression modes (lossless, web, high) and validation logic

**Processing Flow**:
1. User authenticates via `/login` POST with password (bcrypt-hashed in config)
2. Files uploaded to `/process` endpoint go through multi-layer validation:
   - File validation (extension, path traversal, size)
   - Image validation (format, dimensions, color mode)
3. ImageCompressor processes images based on mode:
   - Lossless: Preserves format (PNG/JPEG/TIFF/WebP), optimize=True, quality=95
   - Web: Converts to JPEG/WebP, targets ~200KB, uses quality adjustments, strips EXIF
   - High: Aggressive JPEG/WebP compression, targets <100KB, strips EXIF
4. Processed images converted to base64 strings for JSON transport
5. Client-side JavaScript stores base64 data in memory
6. `/download` endpoint receives base64 data, decodes back to binary, and serves via send_file

**Security Architecture**:
- Password-based authentication with Werkzeug's bcrypt hashing
- CSRF protection via Flask-WTF on all forms and state-changing endpoints (1-hour token expiry)
- Rate limiting via Flask-Limiter decorators: `/login` 10/min, `/process` 30/min, `/download` 120/min
- Brute-force protection: 5 failed attempts = 5-minute IP lockout (thread-safe tracking in Auth)
- Session expiry enforced via `session.permanent = True` with 30-minute lifetime
- SECRET_KEY validated in production (raises ValueError if using default)
- All processing done in-memory using io.BytesIO (no temporary files)
- Secure cookies in production (HTTPOnly, Secure, SameSite=Lax)
- Input sanitization via validators.py (filename sanitization, dimension validation, etc.)
- ProxyFix middleware for proper header handling behind reverse proxy (enabled via PROXY_FIX env var)
- EXIF metadata stripped in web/high compression modes for privacy

**Deployment Configuration**:
- Production uses Gunicorn WSGI server (2 workers, 2 threads, 120s timeout)
- Docker containerization with multi-stage build (builder + runtime)
- Non-root user (appuser) execution in container
- Environment-based secrets (APP_PASSWORD and SECRET_KEY required, no defaults in production)
- Local development runs Flask dev server on port 5000, production on 8000

## Current Known Issues (from TODO.md)

- Max compression produces WebP files that only open in browsers

## Important Implementation Details

**Data Flow and Encoding**:
- All image data transmitted as base64-encoded strings in JSON (bytes → base64 → JSON → client)
- Client stores base64 strings in memory
- Download decodes base64 back to bytes (via base64.b64decode()) before serving
- Base64 format validation performed on download requests

**Configuration Limits**:
- Maximum file size: 50MB (set in app/__init__.py MAX_CONTENT_LENGTH)
- Session timeout: 30 minutes (PERMANENT_SESSION_LIFETIME, enforced via session.permanent)
- Maximum dimensions checked: 40M pixels triggers warning
- Supported input formats: JPG, PNG, WebP, TIFF (validated in validators.py)
- Output formats: Lossless preserves original; Web/High output JPEG (default) or WebP (optional)
- Output filename extension derived from actual output format metadata

**Testing**:
- pytest is in requirements.txt but no test suite exists yet
- When implementing tests, create tests/ directory and use pytest
- No test commands should be run without confirming with user first

## Key Technical Patterns

**Authentication Pattern**:
- Auth class initialized in app factory, stored as app.auth
- `@current_app.auth.login_required` decorator protects routes
- Session-based authentication (session['authenticated'], session.permanent = True)
- Password hash stored in app.config['PASSWORD_HASH']
- Thread-safe login attempt tracking with threading.Lock

**Validation Pattern**:
- Two-layer validation: file-level (validators.py) then image-level (ImageCompressor.validate_image)
- Returns (is_valid, error_message) tuples from validators
- Returns ValidationResult dataclass from ImageCompressor
- Warnings logged but don't block processing

**Error Handling**:
- Custom exceptions in image_processor.py (CompressionError, FileSizeError, FormatError)
- RateLimitExceeded exception in auth.py
- Routes return generic error messages to client, log details server-side
- Logging at INFO level in production, DEBUG in development

**Frontend Architecture** (ES Modules, no build tools):
- `app/static/js/main.js`: Entry point with page-context routing (`<script type="module">`)
- `app/static/js/lib/`: Utilities — `api.js` (fetch wrapper, CSRF), `dom.js` (safe DOM helpers, SVG icon rendering), `events.js` (pub/sub bus), `storage.js` (localStorage wrapper)
- `app/static/js/state/app-state.js`: Reactive state store, persists settings to localStorage
- `app/static/js/components/`: Reusable UI — `theme.js`, `toast.js`, `modal.js` (focus trap, Escape, backdrop), `progress.js`
- `app/static/js/features/`: Page features — `upload.js` (unified drag+click handler), `settings.js` (tool registry pattern), `image-tile.js` (tile lifecycle), `batch.js` (queue processing, ZIP download), `login.js`
- CSS uses design tokens (`tokens.css`), tokenized component files, BEM naming
- No MDC/Material dependency — custom CSS with CSS Grid layout
- SVG sprite sheet in `base.html` (Lucide-style icons)
- `crypto.randomUUID()` for file IDs (no collision risk)
- `textContent` / `sanitizeText()` everywhere (no XSS via innerHTML)
- Toast notifications replace all `alert()` calls
- Login uses standard form POST (no AJAX `document.documentElement.innerHTML` anti-pattern)
- 5 responsive breakpoints, mobile-first, bottom-sheet modals on mobile
