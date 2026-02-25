# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Running the Application

Local development (Flask dev server, port 5000):
```bash
python run.py
```
Debug mode: set `FLASK_DEBUG=1` in `.env` or environment.

Development with Docker (hot-reload via volume mounts, host port 5001):
```bash
docker-compose up --build
```

Production with Docker (Gunicorn, host port 8000):
```bash
docker-compose -f docker-compose.prod.yml up -d --build
docker-compose -f docker-compose.prod.yml logs -f web
```

### Environment Setup

```bash
cp example.env .env
# Edit .env — APP_PASSWORD and SECRET_KEY are required
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
```

### Testing

No test suite exists yet. pytest is in requirements.txt. When implementing tests, create a `tests/` directory. Do not run test commands without confirming with the user first.

## Architecture Overview

### Application Structure

- `app/__init__.py`: App factory — config, CSRF, auth, rate limiting. Rate limits applied to `app.view_functions` after blueprint registration (not at import time).
- `app/routes.py`: Single blueprint with endpoints: `/login`, `/logout`, `/` (index), `/process`, `/download`, `/theme`
- `app/auth.py`: Auth class with `login_required` decorator, thread-safe brute-force protection (5 attempts → 5-min lockout), Flask-Limiter integration
- `app/validators.py`: Centralized validation — returns `(is_valid, error_message)` tuples
- `app/compression/image_processor.py`: ImageCompressor class with three modes, ValidationResult dataclass, watermark support
- `app/forms.py`: Flask-WTF login form (CSRF)

### Compression Mode Name Mapping

The UI labels differ from the internal code identifiers:

| UI Label | Code Value | Behavior |
|----------|-----------|----------|
| Lossless | `lossless` | Preserves format, optimize=True, quality=95 |
| Balanced | `web` | Targets ~200KB, strips EXIF, converts to JPEG/WebP |
| Maximum | `high` | Targets <100KB, strips EXIF, aggressive compression |

### Image Processing Pipeline

1. File validation (validators.py) → image validation (ImageCompressor.validate_image → ValidationResult)
2. Pipeline: EXIF orientation → normalize color mode → sRGB conversion → resize → **watermark** → compress
3. Output encoded as base64 string in JSON response
4. Client stores base64 in memory; `/download` decodes back to binary via `base64.b64decode()`

### Watermark Feature

Text watermark via Pillow ImageDraw/ImageFont (no extra dependencies):
- Font: Inter SemiBold bundled at `app/compression/fonts/Inter-SemiBold.ttf` (OFL licensed), cached per size
- Positions: `bottom-right`, `bottom-left`, `top-right`, `top-left`, `center`, `tiled`
- Options: opacity (10–100), size (1–10 relative scale), color (`white`/`black`/`auto`), angle (-180° to 180°, 0° = horizontal)
- Auto color: samples target area luminance, picks white on dark / black on light
- Tiled mode: configurable angle (default 0°), text stamps with 2× spacing, staggered rows
- RGBA overlay compositing with shadow text for visibility

### Frontend Architecture (ES Modules, no build tools)

- Entry: `js/main.js` — ES module with page-context routing
- State: `js/state/app-state.js` — reactive store, persists settings to localStorage
- Lib: `js/lib/` — `api.js` (fetch+CSRF), `dom.js` (safe DOM helpers, SVG icons), `events.js` (pub/sub), `storage.js`
- Components: `js/components/` — theme, toast, modal (focus trap), progress
- Features: `js/features/` — upload, settings (tool registry), image-tile, batch (queue+ZIP), login
- CSS: design tokens (`tokens.css`), BEM naming, component files in `css/components/`, page files in `css/pages/`
- SVG sprite sheet in `base.html` (Lucide-style icons)
- UX flow: Upload → Auto-Process → Download (no manual Process button)
- Settings panel repositions: in empty state → inside `#workspace-empty`; with files → after `#workspace-toolbar`
- `textContent`/`sanitizeText()` everywhere — no innerHTML for user content
- `crypto.randomUUID()` for file IDs
- Login uses standard form POST (not AJAX)
- 5 responsive breakpoints, mobile-first

## Key Technical Patterns

**Authentication**: Auth class initialized in app factory as `app.auth`. Routes use `@current_app.auth.login_required`. Session-based with `session.permanent = True` (required for 30-min `PERMANENT_SESSION_LIFETIME`). Thread-safe login tracking via `threading.Lock`.

**Rate Limiting**: Flask-Limiter decorators can't be applied at blueprint import time — must wrap `app.view_functions` after registration. See `__init__.py` lines 88–91. Limits: `/login` 10/min, `/process` 30/min, `/download` 120/min.

**Validation**: Two layers: file-level (validators.py returns tuples) then image-level (ImageCompressor returns ValidationResult dataclass with optional `.image` to avoid reopening). Warnings logged but don't block processing.

**Error Handling**: Custom exceptions in image_processor.py (CompressionError, FileSizeError, FormatError). RateLimitExceeded in auth.py — must NOT be inside a broad `except Exception` or it gets swallowed. Routes return generic errors to client, log details server-side.

**State & Re-processing**: Frontend `processedWithSettings` snapshot compared to current settings triggers re-process detection. Auto-process fires via `files:autoProcess` event at end of `handleFiles()`.

**Quality Defaults**: `QUALITY_DEFAULTS` lookup in frontend keyed by mode+format. Quality slider resets on mode/format change. State includes `quality: null` — null means use backend default.

## Configuration Limits

| Setting | Value |
|---------|-------|
| Max file size | 50MB (`MAX_CONTENT_LENGTH` in `__init__.py`) |
| Session timeout | 30 min (`PERMANENT_SESSION_LIFETIME`) |
| CSRF token expiry | 1 hour (`WTF_CSRF_TIME_LIMIT`) |
| Large image warning | 40M pixels |
| Max dimensions | 10,000 px per side |
| Supported input | JPG, PNG, WebP, TIFF |
| Output formats | Lossless preserves original; Balanced/Maximum → JPEG (default) or WebP |

## Deployment

- `docker-compose.yml`: Development — Flask dev server, port 5001→5000, `FLASK_DEBUG=1`, volume mounts for hot-reload
- `docker-compose.prod.yml`: Production — Gunicorn (2 workers, 2 threads, 120s timeout), port 8000
- `Dockerfile`: Multi-stage build (builder + runtime), non-root `appuser`
- `docker-entrypoint.sh`: Validates SECRET_KEY/APP_PASSWORD, creates secured `.env` at `/app/instance/secrets/.env`
- Set `PROXY_FIX=true` when behind a reverse proxy (enables Werkzeug ProxyFix)
- All processing in-memory (io.BytesIO) — no temp files on disk

## Known Issues

- Maximum compression produces WebP files that only open in browsers, not all desktop image viewers
