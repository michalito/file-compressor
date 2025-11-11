# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Running the Application

Local development (Flask development server):
```bash
python run.py
```

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
- `app/__init__.py`: Application factory pattern, configures Flask app with authentication, rate limiting, CSRF protection, and session management
- `app/routes.py`: Main blueprint with endpoints for image processing (/process, /compress, /resize, /download), authentication (/login, /logout), and theme switching
- `app/auth.py`: Authentication class with decorator-based login protection, rate limiting via Flask-Limiter, and brute-force protection
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
   - Web: Converts to JPEG/WebP, targets ~200KB, uses quality adjustments
   - High: Aggressive JPEG/WebP compression, targets <100KB
4. Processed images converted to hex strings for JSON transport
5. Client-side JavaScript stores hex data in memory
6. `/download` endpoint receives hex data, converts back to binary, and serves via send_file

**Security Architecture**:
- Password-based authentication with Werkzeug's bcrypt hashing
- CSRF protection via Flask-WTF on all forms and state-changing endpoints
- Rate limiting: 60 operations/minute, 1000/day (enforced by Flask-Limiter with in-memory storage)
- Brute-force protection: 5 failed attempts = 5-minute IP lockout (tracked in Auth.login_attempts dict)
- All processing done in-memory using io.BytesIO (no temporary files)
- Secure cookies in production (HTTPOnly, Secure, SameSite=Lax)
- Input sanitization via validators.py (filename sanitization, dimension validation, etc.)
- ProxyFix middleware for proper header handling behind reverse proxy (enabled via PROXY_FIX env var)

**Deployment Configuration**:
- Production uses Gunicorn WSGI server (4 workers, 2 threads, 120s timeout)
- Docker containerization with multi-stage build (builder + runtime)
- Non-root user (appuser) execution in container
- Environment-based secrets (APP_PASSWORD and SECRET_KEY required, no defaults)
- Local development runs Flask dev server on port 5000, production on 8000

## Current Known Issues (from TODO.md)

- Batch processing may not work correctly with drag-and-drop uploads
- Max compression produces WebP files that only open in browsers
- UI settings need fixing for mobile screen sizes
- main.js architecture needs refactoring for better organization

## Important Implementation Details

**Data Flow and Encoding**:
- All image data transmitted as hex-encoded strings in JSON (bytes → hex → JSON → client)
- Client stores hex strings in memory (no base64 encoding)
- Download converts hex back to bytes (via bytes.fromhex()) before serving
- Hex validation performed on both encode and decode

**Configuration Limits**:
- Maximum file size: 50MB (set in app/__init__.py MAX_CONTENT_LENGTH)
- Session timeout: 30 minutes (PERMANENT_SESSION_LIFETIME)
- Maximum dimensions checked: 40M pixels triggers warning
- Supported input formats: JPG, PNG, WebP, TIFF, HEIC (validated in validators.py)
- Output formats: Lossless preserves original; Web/High output JPEG (default) or WebP (optional)

**Testing**:
- pytest is in requirements.txt but no test suite exists yet
- When implementing tests, create tests/ directory and use pytest
- No test commands should be run without confirming with user first

## Key Technical Patterns

**Authentication Pattern**:
- Auth class initialized in app factory, stored as app.auth
- `@current_app.auth.login_required` decorator protects routes
- Session-based authentication (session['authenticated'])
- Password hash stored in app.config['PASSWORD_HASH']

**Validation Pattern**:
- Two-layer validation: file-level (validators.py) then image-level (ImageCompressor.validate_image)
- Returns (is_valid, error_message) tuples from validators
- Returns ValidationResult dataclass from ImageCompressor
- Warnings logged but don't block processing

**Error Handling**:
- Custom exceptions in image_processor.py (CompressionError, FileSizeError, FormatError)
- RateLimitExceeded exception in auth.py
- All routes have try/except blocks returning JSON errors with appropriate status codes
- Detailed logging at INFO/WARNING/ERROR levels throughout

**Frontend Integration**:
- app/static/js/main.js handles all client-side logic (needs refactoring per TODO)
- Drag-and-drop file handling (potential issues noted in TODO)
- Progress tracking and status indicators
- Theme switching stored client-side