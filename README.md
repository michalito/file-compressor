# Compressify

A self-hosted, password-protected web application for image compression, background removal, resizing, watermarking, and optional AI upscaling. The optimize pipeline runs entirely in-memory on the server; the AI upscaling workflow is the exception and uses ephemeral temp artifacts managed by a separate CPU worker container.

Supported input formats: **JPG**, **PNG**, **WebP**, **TIFF**, **HEIC/HEIF**

## Features

- **Three compression modes**: Lossless (preserves format and quality; HEIC converts to PNG), Balanced (web-optimized), Maximum (smallest files)
- **Output format selection**: Auto, PNG, WebP, or JPEG
- **Quality slider** (1–100) for fine-grained control in Balanced and Maximum modes
- **Resize** within width/height bounds using presets (4K, Full HD, HD, Web) or custom values
- **Background removal** with rembg subject isolation and transparent PNG output
- **Watermark layers** with text, uploaded logo PNGs, and QR codes generated from URLs
- **Live watermark preview** in the sidebar with per-image preview source selection
- **Multiple watermark stacking** for text + logo + QR in a single pass
- **Per-layer transform controls** so text, logo, and QR can each use their own position, opacity, size, angle, and tile density
- **Dedicated AI Upscale workflow** powered by a Docker Compose managed CPU-only Real-ESRGAN worker with Photo and Anime presets
- **Server-side AI previews and downloads** so full-resolution upscaled files are never pushed back to the browser as base64 JSON
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
docker compose up --build
```

Access the app at **http://localhost:5001**. This runs the Flask development server with hot-reload — code changes in `app/` are reflected immediately via volume mounts.

> **Note:** `docker-compose.yml` is for development only. It runs Flask's dev server on port 5000 inside the container, mapped to host port 5001, with `FLASK_DEBUG=1` enabled.

AI upscaling is optional in development and disabled by default. To start the CPU worker too, enable the `ai` profile:

```bash
docker compose --profile ai up --build
```

Then set `AI_UPSCALER_ENABLED=true` in `.env`. The web app talks to the worker over the internal Compose network at `http://upscaler:8765`.
In development, the `upscaler` container also runs with Gunicorn `--reload`, so edits under `upscaler_service/` are picked up without rebuilding the container.
The `upscaler` container now runs with an explicit memory limit (`6g` by default via `AI_UPSCALER_CONTAINER_MEMORY_LIMIT`) so the worker can plan tile sizes against the real cgroup budget instead of the host machine.

### Production

Use the production Compose file:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Access the app at **http://localhost:8000**.

AI upscaling is optional in production too. To start the worker container, enable the `ai` profile:

```bash
docker compose -f docker-compose.prod.yml --profile ai up -d --build
```

If you are not running the `ai` profile, set `AI_UPSCALER_ENABLED=false` so the UI does not advertise an unavailable worker.

### Dokploy

Deploy this app to Dokploy as a single **Docker Compose** service using `docker-compose.dokploy.yml`.

Recommended production flow:

1. GitHub Actions builds both runtime images from `Dockerfile`
2. The workflow pushes them to GHCR
3. Dokploy pulls those images via `WEB_IMAGE` and `UPSCALER_IMAGE`
4. GitHub Actions triggers Dokploy through a deploy webhook after both images are published

Required Dokploy environment variables:

- `SECRET_KEY`
- `APP_PASSWORD`
- `WEB_IMAGE`
- `UPSCALER_IMAGE`

Recommended Dokploy environment variables:

- `AI_UPSCALER_ENABLED=true`
- `AI_UPSCALER_API_KEY=<long random secret>`
- `PROCESS_RATE_LIMIT=120 per minute`

Recommended Dokploy setup:

- Service type: `Docker Compose`
- Compose file: `docker-compose.dokploy.yml`
- Domains: attach your public domain only to the `web` service on internal port `8000`
- Isolated Deployments: enabled
- Registry: configure GHCR in Dokploy so private image pulls succeed
- Volume Backups: back up `app_secrets` and optionally `upscaler_models`; do not back up `upscaler_tmp`

The GitHub Actions workflow is in `.github/workflows/deploy-dokploy.yml`. It expects:

- `DOKPLOY_DEPLOY_WEBHOOK`
- optional `GHCR_TOKEN` if you do not want to rely on the built-in `GITHUB_TOKEN`

Do not use Dokploy Git auto-deploy for this path. Let the workflow trigger deployment only after both images are pushed successfully.

To stop:

```bash
docker compose -f docker-compose.prod.yml down
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

## AI Upscaling

The `AI Upscale` workflow is separate from the optimize/background/watermark pipeline. It proxies image uploads to an internal `compressify-upscaler` service that runs official Real-ESRGAN weights on CPU via PyTorch.

- Flask validates file type and projected output size before a job is created
- The current AI worker accepts 8-bit inputs only; convert 16-bit source images to 8-bit before using `AI Upscale`
- The worker stages the image, plans against the container memory budget, chooses the official model for the selected preset and scale, retries with smaller tiles on CPU pressure, and writes a preview derivative
- Full outputs and previews are stored only as temporary artifacts and are cleaned up after the configured TTL or when jobs are deleted
- Model weights are auto-downloaded into the `upscaler_models` Docker volume on first startup and reused on later restarts

### Compose Services

- `web` is the authenticated Flask app
- `upscaler` is an internal-only CPU worker on `http://upscaler:8765`
- `upscaler_models` stores the official `.pth` weights
- `upscaler_tmp` stores temporary AI artifacts and job files

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SECRET_KEY` | Yes (production) | `dev-key-please-change` | Flask session encryption key. **Must be changed in production** — the app raises an error if the default is used. Generate one with: `python3 -c "import secrets; print(secrets.token_hex(32))"` |
| `APP_PASSWORD` | Yes | None | Login password. Hashed with Werkzeug bcrypt at startup. |
| `FLASK_ENV` | No | `development` | Set to `production` for production mode. Controls logging level, cookie security, and SECRET_KEY validation. |
| `FLASK_DEBUG` | No | `0` | Set to `1` for debug mode with auto-reload (development only). |
| `PROXY_FIX` | No | `false` | Set to `true` when running behind a reverse proxy (Nginx, Caddy, etc.). Enables Werkzeug's ProxyFix middleware for correct `X-Forwarded-*` header handling. |
| `PROCESS_RATE_LIMIT` | No | `120 per minute` | Per-IP rate limit for `/process`. Raise or lower this based on expected batch size. |
| `AI_UPSCALER_ENABLED` | No | `false` | Enables the `AI Upscale` workflow in the web UI. |
| `AI_UPSCALER_URL` | No | `http://127.0.0.1:8765` | Base URL for the AI worker. In Docker Compose use `http://upscaler:8765`; for a local non-Docker worker use `http://127.0.0.1:8765`. |
| `AI_UPSCALER_API_KEY` | No | empty | Optional shared secret sent as `X-API-Key` to the upscaler worker. |
| `AI_UPSCALE_MAX_OUTPUT_DIMENSION` | No | `12000` | Rejects AI jobs whose projected output would exceed this width or height. |
| `AI_UPSCALE_MAX_OUTPUT_PIXELS` | No | `100000000` | Rejects AI jobs whose projected output would exceed this total pixel count. |
| `AI_UPSCALE_ARTIFACT_TTL_SECONDS` | No | `21600` | Temporary artifact lifetime for AI previews and full-resolution outputs. |

### Worker Environment Variables

These are used by the internal `upscaler` service:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_UPSCALER_BACKEND` | No | `torch-cpu` | Worker backend implementation. V1 supports `torch-cpu` only. |
| `AI_UPSCALER_MODEL_CACHE_DIR` | No | `/models` | Directory where official Real-ESRGAN `.pth` weights are cached. In Compose this is the `upscaler_models` volume. |
| `AI_UPSCALER_AUTO_DOWNLOAD_MODELS` | No | `true` | Downloads missing official weights into the model cache on startup. |
| `AI_UPSCALER_PRELOAD_MODELS` | No | `false` | Opt-in preload for model weights. The default is on-demand loading with an LRU cache to keep worker RSS stable. |
| `AI_UPSCALER_MODEL_CACHE_SIZE` | No | `1` | Number of loaded model bundles to keep resident in memory. |
| `AI_UPSCALER_CPU_THREADS` | No | `0` | CPU thread count for PyTorch. `0` resolves to `min(4, host_cpu_count)`. |
| `AI_UPSCALER_INTEROP_THREADS` | No | `1` | PyTorch inter-op thread count. |
| `AI_UPSCALER_MEMORY_LIMIT_BYTES` | No | `0` | Explicit worker memory budget override in bytes. `0` auto-detects the container cgroup limit. |
| `AI_UPSCALER_MEMORY_TARGET_PERCENT` | No | `0.75` | Fraction of the usable memory budget the planner treats as target working memory. |
| `AI_UPSCALER_MEMORY_RESERVED_BYTES` | No | `805306368` | Reserved headroom for Python, PyTorch, and image encoding before accepting a job. |
| `AI_UPSCALER_MAX_UPLOAD_BYTES` | No | `52428800` | Hard upload ceiling enforced directly by the worker Flask app, even if the internal port is hit without going through the web app. |
| `AI_UPSCALER_WORK_ROOT` | No | OS temp dir | Root directory for per-job temp files and artifacts. |
| `AI_UPSCALER_MAX_WORKERS` | No | `1` | Max concurrent upscale jobs. V1 defaults to one worker for predictable memory use. |
| `AI_UPSCALER_API_KEY` | No | empty | Optional API key that must match the web app's setting. |
| `AI_UPSCALER_CONTAINER_MEMORY_LIMIT` | Compose only | `6g` | Docker Compose memory limit for the `upscaler` service. The worker reads this cgroup limit and uses it for tile planning and admission control. |
| `WEB_IMAGE` | Dokploy only | none | Full image reference for the web runtime image, for example `ghcr.io/<owner>/file-compressor-web:latest`. |
| `UPSCALER_IMAGE` | Dokploy only | none | Full image reference for the upscaler runtime image, for example `ghcr.io/<owner>/file-compressor-upscaler:latest`. |

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

### AI Upscaling Limits

| Setting | Value |
|---------|-------|
| Max projected output dimension | 12,000 px per side |
| Max projected output pixels | 100 MP |
| Supported AI input bit depth | 8-bit only |
| Preview long edge | 1,600 px |
| Artifact TTL | 6 hours |
| Worker concurrency | 1 |

### Rate Limits

Per-IP, no daily limits:

| Endpoint | Limit |
|----------|-------|
| `/login` | 10 requests/minute |
| `/process` | 120 requests/minute |
| `/download` | 120 requests/minute |
| `/ai-upscale/jobs` | 60 requests/minute |
| `/ai-upscale/artifacts/<id>/preview` | 120 requests/minute |
| `/ai-upscale/artifacts/<id>/download` | 120 requests/minute |
| `/ai-upscale/download-all` | 60 requests/minute |

### Brute Force Protection

5 failed login attempts triggers a 5-minute IP lockout. Lockout countdown is displayed on the login page. Production defaults to a single Gunicorn worker so this in-memory lockout and the documented rate limits stay consistent.

## Usage

### 1. Login

Navigate to the app URL and enter the password configured via `APP_PASSWORD`. Your session lasts 30 minutes. After 5 failed attempts, your IP is locked out for 5 minutes.

### 2. Upload Images

- **Drag and drop** files onto the workspace, or click **Choose Images** to browse
- Supported formats: JPG, PNG, WebP, TIFF, HEIC/HEIF
- Maximum file size: 50 MB per image (validated client-side before upload)
- Unsupported or oversized files are rejected with a toast notification
- You can add more files at any time using the **Add More** button or by dropping onto the workspace

### 3. Configure Settings

Start by choosing a workflow in the sidebar header:

- **Optimize** keeps the existing compression/background/watermark pipeline
- **AI Upscale** switches to Real-ESRGAN batch upscaling and hides crop/background/watermark controls

The inline settings panel offers these controls:

**Compression mode** (segmented control):
| Mode | Description | JPEG Quality | WebP Quality |
|------|-------------|:------------:|:------------:|
| **Lossless** | Preserves original format and maximum quality (HEIC converts to PNG) | 95 | Lossless (effort 80) |
| **Balanced** | Good quality, smaller files — strips EXIF metadata | 85 | 75 |
| **Maximum** | Smallest files, noticeable quality loss — strips EXIF metadata | 60 | 40 |

**Output format** (segmented control):
- **Auto** — preserves original format in Lossless (HEIC converts to PNG); uses JPEG in Balanced/Maximum
- **PNG** — lossless output, quality slider hidden
- **WebP** — best compression ratio, preserves transparency
- **JPEG** — universal compatibility, no transparency (transparent areas become white)

**Quality slider** (1–100): Available for Balanced and Maximum modes when output is not PNG. Default resets when changing mode or format.

**Resize**: Original (no resize) or Custom with width/height bounds. You can set width only, height only, or both. The image fits within the bounds, preserves aspect ratio, and can be enlarged if the source is smaller. Presets available: 4K (3840x2160), Full HD (1920x1080), HD (1280x720), Web (800x600).

**Background**: Remove Background runs rembg subject isolation and forces transparent PNG output. Compression mode and output format controls are locked while it is enabled, but resize and watermark remain available.

**Watermark**:
- Master toggle keeps watermark values but disables watermark preview/rendering when turned off
- **Text layer** supports white, black, or auto-contrast text
- **Logo layer** accepts PNG files only, up to 5 MB and 4096×4096
- **QR layer** generates a QR watermark from an absolute `http://` or `https://` URL up to 2048 characters
- Each layer has its own tab with independent position, opacity, size, angle, and tile density controls
- **Tiled** position is available for text, logo, and QR layers
- **Live preview** uses a client-side canvas and the selected image tile as its preview source
- Uploaded logo files and generated QR PNGs are session-only and are not restored after a page reload
- Browser preview may be unavailable for source formats the browser cannot decode locally (for example some TIFF/HEIC files); server-side processing still works

**AI Upscale**:
- **Model preset**: Photo or Anime / Illustration
- **Scale**: 2x or 4x
- **Output format**: PNG, WebP, or JPEG
- **Quality slider**: shown only for WebP and JPEG
- **Photo + 2x** uses the official `RealESRGAN_x2plus` model
- **Photo + 4x** uses the official `RealESRGAN_x4plus` model
- **Anime + 2x / 4x** uses the official `RealESRGAN_x4plus_anime_6B` model, with the 2x path produced via official post-resize from native 4x output
- JPEG output flattens transparency; PNG and WebP preserve it

Settings persist in your browser across sessions via localStorage.

### 4. Automatic Processing

Images are **processed automatically** when uploaded — there is no manual "Process" button. Batch processing handles up to 5 files concurrently in the optimize workflow and queues AI jobs through the internal CPU worker. A progress bar shows completion with a time estimate.

**Toolbar actions** (appear after uploading files):
- **Re-process** — appears when you change settings after processing; re-runs all files with new settings
- **Retry Incomplete** — re-processes images that failed or were cancelled
- **Cancel** — stops the current batch (already-processed images are kept)
- **Clear All** — removes all files and returns to the empty state

### 5. Download

- **Per-image**: click the download button on any processed tile
- **Download All**: downloads a single file directly, or creates a ZIP archive when multiple files are processed
- Compression statistics (size reduction %) are shown as an overlay on each tile

For `AI Upscale`, previews and downloads come from temporary server-side artifacts rather than in-browser base64 payloads.

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
- **Background removal**: runs before watermarking and always outputs a transparent PNG
- **Watermark order**: resize/background removal happen before watermark compositing, and watermarking happens before final compression
- **CMYK/Palette images**: automatically converted to RGB before processing
- **EXIF orientation**: physically applied (rotated) before processing in all modes
- **Progressive JPEG**: enabled in all modes for faster web rendering

## Production Deployment

### Docker Image

The Dockerfile uses a multi-stage build:

1. **Builder stage** — installs Python dependencies into an isolated virtual environment
2. **Runtime stage** — copies only the venv, the preloaded rembg model cache, and application code, then runs as non-root user `appuser`

The production image preloads the default rembg CPU model during build and keeps it under `U2NET_HOME=/opt/rembg`. Local non-Docker development may still populate that cache on first use if the model is not already present.

**Gunicorn configuration** (from Dockerfile CMD):
- 1 worker process, 2 threads
- 120-second request timeout
- 5-second keep-alive
- Sync worker class with application preload; single-worker default keeps in-memory auth and rate limits accurate
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
- Production defaults to one worker because rate limiting and login-attempt tracking are in-memory
- Thread-safe tracking with `threading.Lock`

### Input Validation
- Filename sanitization and path traversal prevention
- File extension whitelist (JPG, JPEG, PNG, WebP, TIFF, HEIC, HEIF)
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

- Supported formats: JPG, PNG, WebP, TIFF, HEIC/HEIF (not GIF or BMP)
- Maximum size: 50 MB per file
- Maximum dimensions: 10,000 px per side

### Large images processing slowly

- Images exceeding 40 million total pixels (e.g., 8000x5000) trigger a warning
- Consider using resize presets or custom bounds to shrink or enlarge images before compression

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
