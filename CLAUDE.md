# CLAUDE.md

**Compressify** — self-hosted, password-protected image compression/resizing/background-removal/watermarking web app. All processing in-memory (no files on disk).

## Commands

```bash
# Dev
python run.py                                        # Flask dev server, port 5000
docker-compose up --build                            # Docker dev, port 5001, hot-reload

# Prod
docker-compose -f docker-compose.prod.yml up -d --build
./run-prod.sh                                        # deploy | rollback | status | logs

# Test
pytest                                               # all tests
pytest tests/test_crop.py                            # single file
pytest -k test_crop_jpeg                             # single test

# Setup (Python 3.11+)
cp example.env .env  # APP_PASSWORD and SECRET_KEY required
pip install -r requirements.txt
```

## File Map

```
app/
  __init__.py              # App factory: config, CSRF, auth, rate limiting
  routes.py                # Blueprint: /login, /logout, /, /process, /crop, /download, /theme
  auth.py                  # Auth class, login_required decorator, brute-force protection
  validators.py            # All input validation — returns (is_valid, error_message) tuples
  forms.py                 # LoginForm (Flask-WTF CSRF)
  compression/
    __init__.py            # Exports; registers pillow-heif for HEIC support
    image_processor.py     # ImageCompressor: compress, crop, rotate, watermark, validate
    fonts/Inter-SemiBold.ttf

app/templates/
  base.html                # Layout + SVG sprite sheet + CSRF meta tag
  index.html               # Main app
  login.html               # Login page
  image_tile_template.html # Image tile component

app/static/js/
  main.js                  # Entry: ES module, page-context routing
  state/app-state.js       # Reactive proxy store, persists settings to localStorage
  lib/                     # api.js (fetch+CSRF), dom.js, events.js (pub/sub), storage.js
  components/              # theme, toast, modal (focus trap), progress, confirm, footer, unsaved-changes
  features/                # upload, settings (tool registry), image-tile, batch (queue+ZIP),
                           # crop + crop-interaction, login

app/static/css/
  tokens.css               # Design tokens
  components/              # BEM component styles
  pages/                   # Page-specific styles

tests/
  conftest.py              # Fixtures: app (CSRF disabled), client, auth_client (pre-authenticated)
```

## Architecture

### Processing Pipeline

1. File validation (`validators.py`) -> image validation (`ImageCompressor.validate_image` -> `ValidationResult` dataclass with optional `.image`)
2. EXIF orientation -> normalize color mode -> optional sRGB conversion -> resize -> optional background removal -> watermark -> compress
3. Response: base64-encoded image in JSON
4. Download: client sends base64 back, `/download` decodes to binary

### Compression Modes

| UI Label | Code Value | Behavior |
|----------|-----------|----------|
| Lossless | `lossless` | Preserves format, optimize=True, quality=95. HEIC -> PNG |
| Balanced | `web` | Targets ~200KB, strips EXIF, converts to JPEG/WebP |
| Maximum | `high` | Targets <100KB, strips EXIF, aggressive compression |

### Crop & Rotate

- `/crop` operates on already-compressed base64 (not originals)
- Supports chaining: `/process` -> `/crop` -> `/crop` or `/crop` -> `/process`
- Rotation: 90-degree increments via `Image.transpose()` (lossless)
- Crop preserves RGBA transparency for PNG/WebP
- Aspect ratios: free, 1:1, 4:3, 3:2, 16:9, 9:16

### Watermark

- Font: Inter SemiBold bundled, cached per size via `lru_cache`
- Positions: `bottom-right`, `bottom-left`, `top-right`, `top-left`, `center`, `tiled`
- Options: opacity (10-100), size (1-20 relative scale), color (`white`/`black`/`auto`), angle (-180 to 180), tile density (1-10)
- Auto color: samples target area luminance, picks white on dark / black on light
- Tiled mode: text stamps with configurable density and angle
- RGBA overlay compositing with shadow text for visibility

### Background Removal

- Uses `rembg` with the default CPU session (`new_session()`)
- Session is created lazily per worker; do not initialize it at import time because Gunicorn runs with `--preload`
- Runs inside the existing `/process` pipeline, before watermarking
- Forces output to transparent PNG and sets `metadata.background_removed`
- Docker image preloads the rembg model cache into `U2NET_HOME=/opt/rembg`

### Format Remapping

Non-native formats remapped early in `validate_image()`: MPO -> JPEG, HEIF -> PNG. Requires `pillow-heif` (`register_heif_opener()` in `app/compression/__init__.py`).

### Frontend Patterns

- UX flow: Upload -> Auto-Process -> Download (no manual Process button)
- Batch: 5 concurrent uploads (`CHUNK_SIZE`), ZIP download via JSZip from CDN
- Settings panel repositions: empty state -> inside `#workspace-empty`; with files -> after `#workspace-toolbar`
- Re-process detection: `processedWithSettings` snapshot compared to current settings
- Auto-process fires via `files:autoProcess` event at end of `handleFiles()`
- Quality defaults per mode+format in `QUALITY_DEFAULTS`; `quality: null` means use backend default
- Background removal locks the compression UI to Lossless + PNG without overwriting the user's saved compression preferences
- Security: `textContent`/`sanitizeText()` everywhere (no innerHTML), `crypto.randomUUID()` for file IDs
- Login: standard form POST (not AJAX)
- ES modules, no build tools, 5 responsive breakpoints (mobile-first)

## Invariants & Gotchas

**Rate limiting**: Flask-Limiter decorators cannot be applied at blueprint import time. Must wrap `app.view_functions` after blueprint registration (see `__init__.py` lines 129-142).

**Session lifetime**: `session.permanent = True` is required for `PERMANENT_SESSION_LIFETIME` to take effect.

**RateLimitExceeded**: Must NOT be caught by a broad `except Exception` block — it gets swallowed. Keep it outside generic error handlers.

**Auth pattern**: Auth class initialized as `app.auth` in factory. Routes use `@current_app.auth.login_required`. Brute-force: 5 attempts -> 5-min lockout, thread-safe via `threading.Lock`, in-memory per worker.

**Validation layers**: File-level (`validators.py` returns tuples) then image-level (`ImageCompressor` returns `ValidationResult` dataclass with optional `.image` to avoid reopening). Warnings logged but don't block.

**Custom exceptions**: `ImageValidationError`, `CompressionError`, `FileSizeError`, `FormatError` — all in `image_processor.py`. Routes return generic errors to client, log details server-side.

## Configuration Limits

| Setting | Value |
|---------|-------|
| Max file size | 50 MB |
| Max pixel count | 40M pixels (rejected) |
| Max dimensions | 10,000 px per side |
| Session timeout | 30 min |
| CSRF token expiry | 1 hour |
| Brute-force lockout | 5 attempts / 5 min |
| Supported input | JPG, PNG, WebP, TIFF, HEIC/HEIF |
| Output formats | `auto`, `jpeg`, `webp`, `png` |
| Watermark text | max 50 chars |

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| `/login` | 10/min |
| `/process` | 120/min |
| `/crop` | 30/min |
| `/download` | 120/min |

## Deployment

- `Dockerfile`: Multi-stage build, Python 3.11-slim, non-root `appuser`, `libheif1` for HEIC
- `docker-compose.yml`: Dev — port 5001, `FLASK_DEBUG=1`, volume mounts
- `docker-compose.prod.yml`: Prod — Gunicorn (1 worker, 2 threads, 120s timeout), port 8000
- `docker-entrypoint.sh`: Validates SECRET_KEY/APP_PASSWORD, creates secured `.env` at `/app/instance/secrets/.env`
- Set `PROXY_FIX=true` when behind a reverse proxy
