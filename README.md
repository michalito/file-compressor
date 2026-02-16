# Compressify

A self-hosted, password-protected web application for image compression and resizing. All processing happens in-memory on the server — no files are stored on disk.

Supported input formats: **JPG**, **PNG**, **WebP**, **TIFF**

## Features

- **Three compression modes**: Lossless (preserves format and quality), Balanced (web-optimized), Maximum (smallest files)
- **Output format selection**: Auto, PNG, WebP, or JPEG
- **Quality slider** (1–100) for fine-grained control in Balanced and Maximum modes
- **Resize** with preset dimensions (Full HD, HD, Web) or custom width/height
- **Automatic processing** on upload — no manual "Process" button needed
- **Batch processing** with 5 concurrent uploads, progress tracking, time estimates, and cancel support
- **Re-process** when settings change, **retry** for failed files
- **Download** individual files or batch download as ZIP
- **Drag-and-drop** and click-to-browse upload with client-side 50 MB validation
- **Dark/light theme** with system preference detection
- **Responsive design** with mobile-first layout

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop) installed
- Git (to clone the repository)

### Development

```bash
git clone <repository-url>
cd file-compressor
cp example.env .env
```

Edit `.env` and set both required variables:

```env
SECRET_KEY=your-very-long-random-secret-key
APP_PASSWORD=your-secure-password
```

Start the development server:

```bash
docker-compose up --build
```

Access the app at **http://localhost:5001**. This runs the Flask development server with hot-reload — code changes in `app/` are reflected immediately via volume mounts.

> **Note:** `docker-compose.yml` is for development only. It runs Flask's dev server on port 5000 inside the container, mapped to host port 5001, with `FLASK_DEBUG=1` enabled.

### Production

Build and run the production image directly:

```bash
docker build -t compressify:prod .

docker run -d --name compressify -p 8000:8000 \
  -e SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))") \
  -e APP_PASSWORD=your-secure-password \
  compressify:prod
```

Or use the production Compose file:

```bash
docker-compose -f docker-compose.prod.yml up -d --build
```

Access the app at **http://localhost:8000**. This runs Gunicorn with 2 workers, 2 threads, and a 120-second timeout.

To stop:

```bash
# Direct Docker
docker stop compressify && docker rm compressify

# Docker Compose
docker-compose -f docker-compose.prod.yml down
```

<details>
<summary><h2 style="display:inline">Local Development (Without Docker)</h2></summary>

```bash
python3 -m venv venv
source venv/bin/activate  # Linux/Mac
# or: .\venv\Scripts\activate  # Windows

pip install -r requirements.txt
cp example.env .env
# Edit .env with SECRET_KEY and APP_PASSWORD

python run.py
```

Access at **http://localhost:5000**. Enable debug mode by setting `FLASK_DEBUG=1` in your environment or `.env` file.

</details>

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SECRET_KEY` | Yes (production) | `dev-key-please-change` | Flask session encryption key. **Must be changed in production** — the app raises an error if the default is used. Generate one with: `python3 -c "import secrets; print(secrets.token_hex(32))"` |
| `APP_PASSWORD` | Yes | None | Login password. Hashed with Werkzeug bcrypt at startup. |
| `FLASK_ENV` | No | `development` | Set to `production` for production mode. Controls logging level, cookie security, and SECRET_KEY validation. |
| `FLASK_DEBUG` | No | `0` | Set to `1` for debug mode with auto-reload (development only). |
| `PROXY_FIX` | No | `false` | Set to `true` when running behind a reverse proxy (Nginx, Caddy, etc.). Enables Werkzeug's ProxyFix middleware for correct `X-Forwarded-*` header handling. |

### Application Limits

| Setting | Value |
|---------|-------|
| Max file size | 50 MB per file |
| Max dimension | 10,000 px per side |
| Large image warning | 40 million total pixels |
| Session lifetime | 30 minutes |
| CSRF token expiry | 1 hour |
| Quality range | 1–100 |
| Max filename length | 255 characters |

### Rate Limits

Per-IP, no daily limits:

| Endpoint | Limit |
|----------|-------|
| `/login` | 10 requests/minute |
| `/process` | 30 requests/minute |
| `/download` | 120 requests/minute |

### Brute Force Protection

5 failed login attempts triggers a 5-minute IP lockout. Lockout countdown is displayed on the login page.

## Usage

### 1. Login

Navigate to the app URL and enter the password configured via `APP_PASSWORD`. Your session lasts 30 minutes. After 5 failed attempts, your IP is locked out for 5 minutes.

### 2. Upload Images

- **Drag and drop** files onto the workspace, or click **Choose Images** to browse
- Supported formats: JPG, PNG, WebP, TIFF
- Maximum file size: 50 MB per image (validated client-side before upload)
- Unsupported or oversized files are rejected with a toast notification
- You can add more files at any time using the **Add More** button or by dropping onto the workspace

### 3. Configure Settings

The inline settings panel offers these controls:

**Compression mode** (segmented control):
| Mode | Description | JPEG Quality | WebP Quality |
|------|-------------|:------------:|:------------:|
| **Lossless** | Preserves original format and maximum quality | 95 | Lossless (effort 80) |
| **Balanced** | Good quality, smaller files — strips EXIF metadata | 85 | 75 |
| **Maximum** | Smallest files, noticeable quality loss — strips EXIF metadata | 60 | 40 |

**Output format** (segmented control):
- **Auto** — preserves original format in Lossless; uses JPEG in Balanced/Maximum
- **PNG** — lossless output, quality slider hidden
- **WebP** — best compression ratio, preserves transparency
- **JPEG** — universal compatibility, no transparency (transparent areas become white)

**Quality slider** (1–100): Available for Balanced and Maximum modes when output is not PNG. Default resets when changing mode or format.

**Resize**: Original (no resize) or Custom with width/height inputs. Presets available: Full HD (1920x1080), HD (1280x720), Web (800x600). Aspect ratio is maintained.

Settings persist in your browser across sessions via localStorage.

### 4. Automatic Processing

Images are **processed automatically** when uploaded — there is no manual "Process" button. Batch processing handles up to 5 images concurrently. A progress bar shows completion with a time estimate.

**Toolbar actions** (appear after uploading files):
- **Re-process** — appears when you change settings after processing; re-runs all files with new settings
- **Retry Failed** — re-processes only images that encountered errors
- **Cancel** — stops the current batch (already-processed images are kept)
- **Clear All** — removes all files and returns to the empty state

### 5. Download

- **Per-image**: click the download button on any processed tile
- **Download All**: downloads a single file directly, or creates a ZIP archive when multiple files are processed
- Compression statistics (size reduction %) are shown as an overlay on each tile

## Compression Modes Reference

| | Lossless | Balanced | Maximum |
|---|---|---|---|
| **JPEG quality** | 95 | 85 | 60 (retries at 30) |
| **WebP quality** | Lossless (effort 80) | 75 (method 4) | 40 (method 6) |
| **PNG** | optimize, compress level 9 | optimize, compress level 9 | optimize, compress level 9 |
| **TIFF** | Adobe Deflate | N/A | N/A |
| **EXIF metadata** | Preserved | Stripped | Stripped |
| **ICC profile** | Preserved | Stripped (sRGB conversion) | Stripped (sRGB conversion) |
| **Color mode** | Preserved | Normalized to RGB/sRGB | Normalized to RGB/sRGB |

Additional behaviors:
- **Maximum mode retry**: if compression ratio exceeds 50%, retries at quality 30 for more aggressive compression
- **Transparency**: JPEG composites transparent areas onto a white background; WebP and PNG preserve alpha channels
- **CMYK/Palette images**: automatically converted to RGB before processing
- **EXIF orientation**: physically applied (rotated) before processing in all modes
- **Progressive JPEG**: enabled in all modes for faster web rendering

## Production Deployment

### Docker Image

The Dockerfile uses a multi-stage build:

1. **Builder stage** — installs Python dependencies into an isolated virtual environment
2. **Runtime stage** — copies only the venv and application code, runs as non-root user `appuser`

**Gunicorn configuration** (from Dockerfile CMD):
- 2 worker processes, 2 threads per worker
- 120-second request timeout
- 5-second keep-alive
- Sync worker class with application preload
- Access and error logs written to stdout/stderr

### Docker Entrypoint

`docker-entrypoint.sh` runs before the application starts:

1. Validates that `SECRET_KEY` and `APP_PASSWORD` are set (exits with an error if either is missing)
2. Creates a secured `.env` file at `/app/instance/secrets/.env` with `chmod 600`
3. Symlinks `/app/.env` to the secured copy
4. Logs the length (not the value) of each variable for verification

### Reverse Proxy with Nginx

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

**Important**: Set `PROXY_FIX=true` in your environment when running behind a reverse proxy. This enables Werkzeug's ProxyFix middleware so Flask correctly reads `X-Forwarded-*` headers for rate limiting and secure cookie handling.

### Monitoring

```bash
# Container status
docker-compose -f docker-compose.prod.yml ps

# Resource usage
docker stats

# Application logs
docker-compose -f docker-compose.prod.yml logs -f web

# Last 100 lines of logs
docker-compose -f docker-compose.prod.yml logs --tail=100 web
```

### Updates

```bash
git pull
docker-compose -f docker-compose.prod.yml up -d --build
docker image prune -f  # Remove old images
```

## Security

### Authentication
- Password-based login with Werkzeug bcrypt hashing
- No default password — `APP_PASSWORD` is required in all environments

### Session Management
- 30-minute session lifetime with `session.permanent = True`
- Secure cookies in production: `HttpOnly`, `Secure`, `SameSite=Lax`

### CSRF Protection
- Flask-WTF CSRF tokens on all forms and state-changing endpoints
- 1-hour token expiry

### Rate Limiting
- Flask-Limiter with per-IP tracking (see [Rate Limits](#rate-limits) for per-endpoint values)

### Brute Force Protection
- 5 failed login attempts triggers a 5-minute IP lockout
- Thread-safe tracking with `threading.Lock`

### Input Validation
- Filename sanitization and path traversal prevention
- File extension whitelist (JPG, JPEG, PNG, WebP, TIFF only)
- Dimension bounds (1–10,000 px per side)
- Quality bounds (1–100)
- Base64 format validation on download requests

### Data Handling
- All processing in-memory using `io.BytesIO` — no temporary files on disk
- EXIF metadata stripped in Balanced and Maximum modes for privacy

### Production Hardening
- `SECRET_KEY` validated on startup (rejects default value in production)
- Non-root container user (`appuser`)
- Secrets directory secured with `chmod 700`, `.env` file with `chmod 600`

**Production checklist:**
- [ ] Set a strong `SECRET_KEY` (32+ characters)
- [ ] Set a secure `APP_PASSWORD`
- [ ] Use HTTPS via reverse proxy
- [ ] Set `FLASK_ENV=production`
- [ ] Set `PROXY_FIX=true` if behind a reverse proxy
- [ ] Configure firewall rules

## Project Structure

```
file-compressor/
  app/
    __init__.py                  # App factory, config, rate limits
    auth.py                      # Authentication, brute-force protection
    forms.py                     # Flask-WTF login form
    routes.py                    # /login, /process, /download, /theme
    validators.py                # Input validation and sanitization
    compression/
      image_processor.py         # ImageCompressor: lossless, balanced, maximum
    static/
      css/
        tokens.css               # Design tokens (CSS custom properties)
        components/              # Button, card, form, modal, toast, etc.
        pages/                   # Login, upload, image-tile, settings, etc.
      js/
        main.js                  # Entry point (ES module)
        lib/                     # api.js, dom.js, events.js, storage.js
        state/app-state.js       # Reactive state store, settings persistence
        components/              # theme.js, toast.js, modal.js, progress.js
        features/                # upload.js, settings.js, image-tile.js, batch.js
    templates/
      base.html                  # Layout, SVG sprite, header/footer
      login.html                 # Authentication page
      index.html                 # Workspace with settings panel and image grid
      image_tile_template.html   # Individual image tile template
  docker-compose.yml             # Development (Flask dev server, port 5001)
  docker-compose.prod.yml        # Production (Gunicorn, port 8000)
  Dockerfile                     # Multi-stage production build
  docker-entrypoint.sh           # Env validation and secrets setup
  run.py                         # WSGI entry point
  requirements.txt               # Python dependencies
  example.env                    # Environment variable template
```

## Browser Compatibility

Requires a modern browser with ES module and `crypto.randomUUID()` support:

| Browser | Minimum Version |
|---------|-----------------|
| Chrome  | 92+ |
| Edge    | 92+ |
| Firefox | 95+ |
| Safari  | 15.4+ |

## Troubleshooting

### Container won't start

- **Missing environment variables**: The entrypoint script prints `ERROR: SECRET_KEY environment variable is not set` (or `APP_PASSWORD`) if either is missing. Check your `.env` file.
- **Port already in use**: Check with `lsof -i :8000` (production) or `lsof -i :5001` (development). To use a different port, edit the port mapping in the relevant `docker-compose` file (e.g., change `"8000:8000"` to `"3000:8000"`).

### Can't login

- Verify `APP_PASSWORD` is set correctly in your `.env` file
- Check application logs: `docker-compose logs web`
- After 5 failed attempts, wait 5 minutes for the lockout to expire

### File upload rejected

- Supported formats: JPG, PNG, WebP, TIFF only (not HEIC, GIF, or BMP)
- Maximum size: 50 MB per file
- Maximum dimensions: 10,000 px per side

### Large images processing slowly

- Images exceeding 40 million total pixels (e.g., 8000x5000) trigger a warning
- Consider using the resize presets (Full HD, HD, Web) to reduce dimensions before compression

### Logging

- **Production**: INFO level, handled by Gunicorn (stdout/stderr)
- **Development**: DEBUG level when `FLASK_DEBUG=1` is set
- **Docker**: `docker-compose logs -f web` or `docker-compose -f docker-compose.prod.yml logs -f web`

### Reset everything

```bash
docker-compose down -v          # Development
# or
docker-compose -f docker-compose.prod.yml down -v  # Production

docker system prune -a          # Remove all unused images
# Then rebuild from the Quick Start steps
```

## Known Issues

- Maximum compression mode produces WebP files that may only open in web browsers, not all desktop image viewers

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Flask 3.1, Gunicorn 23, Python 3.11 |
| Image Processing | Pillow 11.1 |
| Auth & Security | Flask-WTF 1.2, Flask-Limiter 3.10, Werkzeug bcrypt |
| Frontend | Vanilla ES modules, CSS custom properties |
| Batch Download | JSZip (loaded from CDN) |
| Container | Docker multi-stage build, non-root user |

## License

[Add license information]

## Support

[Add support contact information]
