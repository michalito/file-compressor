# PRD: YouTube Media Downloader

**Status**: Draft
**Author**: Auto-generated from research
**Date**: 2026-04-07
**Type**: New standalone application

---

## 1. Product Vision

A self-hosted, password-protected web application for downloading YouTube videos as MP4 and extracting audio as MP3. Designed for personal use on a home server or VPS.

The app fills a gap between bare-bones CLI tools and over-engineered media archivers. The core UX is: **paste a URL, see a preview, pick a format, download** -- with real-time progress and a clean interface. Think of it as "Compressify for YouTube" -- same philosophy of simplicity, same self-hosted ethos, different domain.

### Why Build This (vs. Using MeTube)

[MeTube](https://github.com/alexta69/metube) is the closest existing tool (~13k stars). It works, but has meaningful UX and architecture gaps that justify a purpose-built alternative:

| Gap | MeTube | This App |
|-----|--------|----------|
| **No preview before download** | Pastes URL, downloads blind | Shows title, thumbnail, duration, channel, format options *before* committing |
| **No in-browser file serving** | Files saved to a server directory; user must access via file share or separate file server | Downloads served directly to the browser -- click and save |
| **No authentication** | Open to anyone on the network (GitHub issue #868) | Password-protected with session auth, brute-force protection |
| **Angular + Socket.IO** | Heavy frontend framework, WebSocket dependency | Vanilla JS ES modules, SSE for progress -- zero build tools, zero frontend deps |
| **No PWA / share target** | Requires iOS Shortcuts or browser extensions for mobile use | PWA with Web Share Target -- share a YouTube link directly to the app from any mobile app |

### Design Principles

1. **Paste and go** -- URL in, file out. Minimal clicks between intent and result.
2. **Preview before commit** -- Always show what you're about to download. No blind downloads.
3. **Browser-native delivery** -- Files download through the browser. No need to SSH in or mount a network share.
4. **Honest about quality** -- Don't offer "320 kbps MP3" without explaining YouTube's source is ~160 kbps. Don't offer FLAC from a lossy source.
5. **Self-contained** -- Single Docker container. No Redis, no Elasticsearch, no Celery. One image, one `docker run`.
6. **Secure by default** -- Auth required, SSRF protection, resource limits, path traversal prevention.

---

## 2. User Stories

### Primary

- **As a user**, I want to paste a YouTube URL and download the audio as MP3 so I can listen offline.
- **As a user**, I want to paste a YouTube URL and download the video as MP4 so I can watch it without internet.
- **As a user**, I want to see the video title, thumbnail, and duration before downloading so I know I have the right video.
- **As a user**, I want to choose the audio quality (128/192/320 kbps) or video resolution (360p-4K) so I can balance quality vs. file size.
- **As a user**, I want to see download progress (percentage, speed, ETA) so I know how long to wait.

### Secondary

- **As a user**, I want to download from my phone by sharing a YouTube link directly to the app (PWA share target).
- **As a user**, I want to download a full playlist, not just individual videos.
- **As a user**, I want the app to be password-protected so only I can use it on my network.
- **As a user**, I want to see my recent downloads so I can re-download something I got before.
- **As a user**, I want to cancel a download in progress if I started the wrong one.

### Non-Goals (v1)

- Channel subscriptions / auto-download (that's TubeArchivist territory)
- Media library / playback / indexing
- Non-YouTube sites (can be added later since yt-dlp supports 1000+ sites, but v1 scopes to YouTube for a focused UX)
- User accounts / multi-tenancy (single password, like Compressify)
- Persistent media storage / file management (download and forget -- temp files are cleaned up)

---

## 3. Functional Requirements

### 3.1 URL Input & Validation

**Accepted URL formats:**
- Standard: `youtube.com/watch?v=VIDEO_ID`
- Short: `youtu.be/VIDEO_ID`
- Embed: `youtube.com/embed/VIDEO_ID`
- Shorts: `youtube.com/shorts/VIDEO_ID`
- Live: `youtube.com/live/VIDEO_ID`
- Music: `music.youtube.com/watch?v=VIDEO_ID`
- Playlists: `youtube.com/playlist?list=PLAYLIST_ID`
- Mobile: `m.youtube.com/watch?v=VIDEO_ID`

**Accepted domains** (allowlist for SSRF protection):
- `youtube.com`, `www.youtube.com`, `m.youtube.com`
- `youtu.be`
- `music.youtube.com`
- `youtube-nocookie.com`, `www.youtube-nocookie.com`

**Validation rules:**
- URL must match YouTube domain allowlist (reject all others)
- URL must be `https://` or `http://` scheme only
- Reject `file://`, `ftp://`, `data://`, `javascript:` schemes
- Video ID format: `[A-Za-z0-9_-]{11}`
- Playlist ID format: starts with `PL`, `UU`, `OL`, `RD`, `LL`, `WL`

### 3.2 Video Metadata Preview

After URL submission, fetch and display metadata **before** downloading:

| Field | Source | Display |
|-------|--------|---------|
| Title | `info['title']` | Primary heading |
| Thumbnail | `info['thumbnail']` | Image preview (16:9) |
| Duration | `info['duration_string']` | Badge (e.g., "3:45") |
| Channel | `info['channel']` or `info['uploader']` | Secondary text |
| Upload date | `info['upload_date']` | Formatted date |
| View count | `info['view_count']` | Formatted number |
| Available qualities | `info['formats']` | Populate quality selector |
| Estimated file size | `info['filesize_approx']` per format | Show next to each quality option |

**Metadata fetch must be fast** -- `extract_info(url, download=False)` typically completes in 1-3 seconds. Show a loading skeleton while fetching.

**For playlists**: Show playlist title, item count, total duration. List individual videos with option to select/deselect. Enforce a configurable item limit (default: 50).

### 3.3 Format & Quality Options

#### Audio (MP3)

| Option | Bitrate | Size/min | Notes |
|--------|---------|----------|-------|
| Standard | 128 kbps | ~1.0 MB | Good for speech, podcasts |
| **High** (default) | 192 kbps | ~1.4 MB | Perceptual transparency threshold |
| Maximum | 320 kbps | ~2.4 MB | Marginal benefit over 192 from YouTube's lossy source |

Show a subtle info note: *"YouTube audio peaks at ~160 kbps. Selecting 320 kbps increases file size without adding quality."*

**Also offer native formats** (no transcoding, faster, smaller):
- M4A/AAC (128-192 kbps) -- native YouTube format, no quality loss from transcoding
- Opus (up to 160 kbps) -- best efficiency, native YouTube format, but limited device compatibility

#### Video (MP4)

| Option | Resolution | Typical Size/min | ffmpeg Required |
|--------|-----------|-----------------|:---:|
| Low | 360p | ~5 MB | No (progressive) |
| Medium | 720p | ~19 MB | Yes (DASH merge) |
| **High** (default) | 1080p | ~38 MB | Yes (DASH merge) |
| Ultra | 1440p | ~120 MB | Yes (DASH merge) |
| 4K | 2160p | ~180 MB | Yes (DASH merge) |

Only show resolutions that are actually available for the specific video. Gray out / hide unavailable options. Show estimated file size next to each option derived from `filesize_approx` in the format metadata.

**Output format**: MP4 (H.264 + AAC) only. This is the universally compatible choice. WebM/MKV are not worth the UX complexity for v1.

### 3.4 Download Lifecycle

```
[Idle] -> paste URL -> [Fetching Metadata] -> preview shown -> click Download
   -> [Queued] -> [Downloading] (progress: %, speed, ETA)
   -> [Processing] (ffmpeg merge/transcode)
   -> [Ready] -> click Save -> browser download dialog -> [Done]
```

**States:**

| State | UI | Duration |
|-------|-----|----------|
| Fetching Metadata | Skeleton loader in preview card | 1-3 sec |
| Queued | "Waiting..." badge (if other downloads active) | 0-N sec |
| Downloading | Progress bar with %, speed (MB/s), ETA | 5 sec - 5 min |
| Processing | Indeterminate progress, "Converting..." | 2-30 sec |
| Ready | "Save" button, file size shown | Until user saves or expiry |
| Failed | Error message with reason | Persistent until dismissed |

**Cancellation**: User can cancel during Queued, Downloading, or Processing states. Cancellation kills the yt-dlp process and cleans up temp files immediately.

### 3.5 File Delivery

Files are served **directly to the browser** via Flask's `send_file()` with `as_attachment=True`. No intermediate storage directory the user needs to access.

**Flow:**
1. Download completes -> file sits in server temp directory
2. User clicks "Save" -> browser GET request -> Flask streams file -> browser save dialog
3. After successful delivery (or after expiry timeout), temp file is deleted

**File naming**: `{video_title}.{ext}` -- sanitized via yt-dlp's `sanitize_filename()` plus additional path traversal prevention.

**Expiry**: Completed downloads are available for 2 hours, then temp files are cleaned up automatically. This prevents disk exhaustion from forgotten downloads.

### 3.6 Download Queue

- Maximum **3 concurrent downloads** (configurable via env var)
- Additional requests are queued (FIFO)
- Queue persisted to JSON file so it survives container restarts
- Queue visible in UI: shows position, allows reordering and removal

### 3.7 Download History

- Last 100 completed downloads shown in a "Recent" section
- Shows: title, thumbnail, format, quality, file size, download date
- Option to re-download (starts a new download with same URL + settings)
- Option to clear history
- Persisted to JSON file (not a database -- keep it simple)

### 3.8 Authentication

Identical pattern to Compressify:

- Single password set via `APP_PASSWORD` env var
- Werkzeug password hashing
- Session-based auth with 30-minute timeout
- `login_required` decorator on all functional endpoints
- Brute-force protection: 5 failed attempts -> 5-minute lockout per IP
- CSRF protection via Flask-WTF on all forms

### 3.9 Playlist Support

When a playlist URL is detected:

1. Fetch playlist metadata (title, item count, total duration)
2. Display playlist overview with video list
3. User can select/deselect individual videos
4. "Download All" creates one queued task per selected video
5. Each video downloads independently with its own progress
6. Configurable max items per playlist (default 50, env var `MAX_PLAYLIST_ITEMS`)

---

## 4. Non-Functional Requirements

### 4.1 Performance

| Metric | Target |
|--------|--------|
| Metadata fetch | < 3 seconds |
| Download throughput | Limited by network, not app |
| Progress update latency | < 500ms (SSE) |
| File serve start | < 1 second after clicking "Save" |
| Concurrent downloads | 3 (configurable, max 10) |
| Memory per download | < 200 MB |

### 4.2 Reliability

- Downloads survive brief network interruptions (yt-dlp has built-in retry with `--retries 3`)
- Queue persisted to disk; survives container restarts
- Failed downloads show clear error messages (not generic 500s)
- Temp file cleanup runs every 5 minutes; orphaned files older than 2 hours are deleted
- `atexit` handler cleans up on graceful shutdown

### 4.3 Security

| Threat | Mitigation |
|--------|-----------|
| **SSRF** (user-provided URL -> server fetches internal resources) | YouTube domain allowlist; reject private IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.169.254); HTTPS/HTTP schemes only |
| **Path traversal** (malicious filenames from yt-dlp) | Sanitize all filenames; enforce output stays within temp directory; pin yt-dlp >= 2024.07.01 (CVE-2024-38519 fix) |
| **Resource exhaustion** | Max concurrent downloads (3); max file size limit (2 GB default); max video duration (4 hours default); per-IP rate limiting |
| **Brute-force auth** | 5 attempts -> 5-min lockout; rate limit /login to 10/min |
| **XSS** | `textContent` only, no `innerHTML` for user content; sanitize video titles before display |
| **CSRF** | Flask-WTF CSRF tokens on all state-changing requests |
| **yt-dlp config injection** | Use `--ignore-config` and `--no-exec` flags; never expose raw yt-dlp options to the frontend |
| **Process isolation** | Run yt-dlp downloads in subprocess (not in-process), so crashes don't take down the web server |

### 4.4 Resource Limits (Configurable)

| Limit | Default | Env Var |
|-------|---------|---------|
| Max concurrent downloads | 3 | `MAX_CONCURRENT_DOWNLOADS` |
| Max video duration | 4 hours (14400s) | `MAX_DURATION` |
| Max output file size | 2 GB | `MAX_FILESIZE` |
| Max playlist items | 50 | `MAX_PLAYLIST_ITEMS` |
| Temp file expiry | 2 hours | `TEMP_EXPIRY_HOURS` |
| Session timeout | 30 minutes | `SESSION_TIMEOUT` |

---

## 5. Technical Architecture

### 5.1 Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Backend** | Flask (Python 3.11+) | Proven with Compressify; simple, well-understood |
| **Download engine** | yt-dlp (Python API) | Dominant tool, fastest cipher fixes, 1000+ site extractors |
| **Media processing** | ffmpeg + ffprobe (static binaries) | Required for MP3 conversion and DASH stream merging |
| **JS runtime** | Deno | Required by yt-dlp-ejs for YouTube cipher solving; lightest option (~50 MB) |
| **Real-time progress** | Server-Sent Events (SSE) | Zero dependencies, native browser `EventSource` API, simpler than WebSocket |
| **Task execution** | `multiprocessing.Process` | Process isolation (crash safety), avoids GIL, separate memory space |
| **Task coordination** | `multiprocessing.Queue` + `threading` | Progress flows from download process -> main process -> SSE clients |
| **Persistence** | JSON files | Download queue + history. No database needed for this scale |
| **Frontend** | Vanilla JS (ES modules) | No build tools, no framework, matches Compressify's approach |
| **CSS** | Design tokens + BEM | Same methodology as Compressify |
| **WSGI server** | Gunicorn (gthread workers) | Thread-based workers handle SSE connections without blocking |
| **Auth** | Session + werkzeug password hash | Same as Compressify |

### 5.2 Why Not WebSocket / Celery / Redis

| Alternative | Why Not |
|-------------|---------|
| **WebSocket (Socket.IO)** | Requires `python-socketio` + frontend library. SSE is simpler, one-directional (server->client) which matches the progress-update pattern. Cancel/pause go through normal POST endpoints. |
| **Celery + Redis** | Adds 2 containers to docker-compose. Overkill for a single-user self-hosted app with 3 concurrent downloads. |
| **SQLite** | A database for a download queue and 100-item history is overengineered. JSON files (MeTube's pattern) are simpler and human-debuggable. |

### 5.3 System Architecture

```
                                     ┌─────────────────────────────┐
                                     │       Docker Container      │
                                     │                             │
┌──────────┐   HTTPS    ┌───────┐   │  ┌────────────────────────┐ │
│  Browser  │◄────────►│ nginx  │──►│  │   Gunicorn (gthread)   │ │
│  (PWA)    │           │       │   │  │   ┌──────────────────┐ │ │
└──────────┘           └───────┘   │  │   │   Flask App       │ │ │
                                     │  │   │                  │ │ │
                                     │  │   │  /yt/info   ────┼─┤ │
                                     │  │   │  /yt/start  ────┼─┤ │
                                     │  │   │  /yt/progress ──┼─┤──── SSE stream
                                     │  │   │  /yt/file   ────┼─┤──── send_file()
                                     │  │   │  /yt/cancel ────┼─┤ │
                                     │  │   └──────────────────┘ │ │
                                     │  │            │            │ │
                                     │  │   ┌────────▼─────────┐ │ │
                                     │  │   │ Download Manager  │ │ │
                                     │  │   │  (Coordinator)    │ │ │
                                     │  │   │                  │ │ │
                                     │  │   │  Semaphore (3)   │ │ │
                                     │  │   │  Task Queue      │ │ │
                                     │  │   │  Progress Store  │ │ │
                                     │  │   └───────┬──────────┘ │ │
                                     │  │           │             │ │
                                     │  │   ┌───────▼──────────┐ │ │
                                     │  │   │  Worker Process   │ │ │
                                     │  │   │  (per download)   │ │ │
                                     │  │   │                  │ │ │
                                     │  │   │  yt-dlp ──► ffmpeg│ │ │
                                     │  │   │    │              │ │ │
                                     │  │   │    ▼              │ │ │
                                     │  │   │  /tmp/yt/{id}/   │ │ │
                                     │  │   └──────────────────┘ │ │
                                     │  └────────────────────────┘ │
                                     │                             │
                                     │  ┌────────────────────────┐ │
                                     │  │  Persistent State      │ │
                                     │  │  /data/queue.json      │ │
                                     │  │  /data/history.json    │ │
                                     │  └────────────────────────┘ │
                                     │                             │
                                     │  ┌────────────────────────┐ │
                                     │  │  Binaries              │ │
                                     │  │  /usr/local/bin/ffmpeg │ │
                                     │  │  /usr/local/bin/ffprobe│ │
                                     │  │  ~/.deno/bin/deno      │ │
                                     │  └────────────────────────┘ │
                                     └─────────────────────────────┘
```

### 5.4 Download Flow (Sequence)

```
Browser                    Flask                    Download Manager         Worker Process
   │                         │                            │                        │
   │── POST /yt/info ───────►│                            │                        │
   │   {url}                 │── extract_info(url) ──────►│                        │
   │                         │◄── metadata ───────────────│                        │
   │◄── 200 {metadata} ─────│                            │                        │
   │                         │                            │                        │
   │── POST /yt/start ──────►│                            │                        │
   │   {url, format, quality}│── enqueue(task) ──────────►│                        │
   │◄── 202 {task_id} ──────│                            │── spawn Process() ────►│
   │                         │                            │                        │── yt-dlp.download()
   │── GET /yt/progress/:id ►│                            │                        │   │
   │◄── SSE stream ─────────│◄── progress_hook data ─────│◄── mp.Queue ──────────│   │ (progress_hooks)
   │   event: progress       │                            │                        │   │
   │   data: {%,speed,eta}   │                            │                        │   │
   │   ...                   │                            │                        │   ▼
   │   event: processing     │                            │                        │── ffmpeg (post-process)
   │   ...                   │                            │                        │   │
   │   event: complete       │◄── task complete ─────────│◄── status: finished ───│   ▼
   │   data: {file_size}     │                            │                        │── file in /tmp/yt/{id}/
   │                         │                            │                        │
   │── GET /yt/file/:id ────►│                            │                        │
   │◄── binary stream ──────│── send_file(path) ────────►│                        │
   │   (browser save dialog) │                            │── cleanup temp dir ───►│
   │                         │                            │                        │
```

### 5.5 API Endpoints

| Endpoint | Method | Auth | Rate Limit | Request | Response |
|----------|--------|:----:|-----------|---------|----------|
| `/login` | GET, POST | No | 10/min | `{password}` | Session cookie / redirect |
| `/logout` | GET | No | -- | -- | Redirect to /login |
| `/` | GET | Yes | -- | -- | Main app HTML |
| `/yt/info` | POST | Yes | 20/min | `{url}` | `{title, thumbnail, duration, channel, formats[], ...}` |
| `/yt/start` | POST | Yes | 10/min | `{url, mode, quality}` | `{task_id}` (202 Accepted) |
| `/yt/progress/<id>` | GET | Yes | -- | -- | SSE stream (`text/event-stream`) |
| `/yt/cancel/<id>` | POST | Yes | 30/min | -- | `{success: true}` |
| `/yt/file/<id>` | GET | Yes | 30/min | -- | Binary file (Content-Disposition: attachment) |
| `/yt/history` | GET | Yes | 30/min | -- | `{items: [...]}` |
| `/yt/history` | DELETE | Yes | 10/min | -- | `{success: true}` |
| `/theme` | POST | Yes | -- | `{theme}` | `{success: true}` |

### 5.6 SSE Event Schema

```
event: progress
data: {"status":"downloading","percent":45.2,"speed":"4.5 MB/s","eta":"12s","downloaded":"23.4 MB","total":"51.8 MB"}

event: progress
data: {"status":"processing","message":"Converting to MP3..."}

event: complete
data: {"status":"complete","filename":"Video Title.mp3","filesize":5242880,"duration":"3:45"}

event: error
data: {"status":"error","message":"Video is unavailable or private"}

event: cancelled
data: {"status":"cancelled"}
```

### 5.7 State Persistence (JSON)

**queue.json** -- survives restarts:
```json
{
  "active": {
    "task-uuid-1": {
      "url": "https://youtube.com/watch?v=xxx",
      "mode": "audio",
      "quality": "192",
      "status": "downloading",
      "created_at": "2026-04-07T10:30:00Z",
      "title": "Video Title",
      "thumbnail": "https://i.ytimg.com/..."
    }
  },
  "pending": {
    "task-uuid-2": { "..." : "..." }
  }
}
```

**history.json** -- last 100 completed downloads:
```json
{
  "items": [
    {
      "url": "https://youtube.com/watch?v=xxx",
      "title": "Video Title",
      "channel": "Channel Name",
      "thumbnail": "https://i.ytimg.com/...",
      "mode": "audio",
      "quality": "192",
      "format": "mp3",
      "filesize": 5242880,
      "duration": "3:45",
      "completed_at": "2026-04-07T10:32:15Z"
    }
  ]
}
```

---

## 6. Frontend Architecture

### 6.1 Technology

Same approach as Compressify -- no build tools, no framework:

| Concern | Approach |
|---------|----------|
| Modules | ES modules (`<script type="module">`) |
| State | Reactive proxy store (same pattern as Compressify's `app-state.js`) |
| HTTP | `fetch()` wrapper with CSRF injection |
| Real-time | Native `EventSource` API for SSE |
| Styling | CSS custom properties (design tokens) + BEM |
| Icons | SVG sprite sheet (Lucide-style) |
| Bundling | None. Direct ES module imports. |

### 6.2 File Structure

```
static/
  js/
    main.js                    # Entry point, page routing
    state/
      app-state.js             # Reactive state store
    lib/
      api.js                   # fetch wrapper, CSRF, SSE helpers
      dom.js                   # $, $$, createElement, icon
      events.js                # Pub/sub event bus
      storage.js               # localStorage helpers
      format.js                # File size, duration, number formatters
    components/
      theme.js                 # Dark/light toggle
      toast.js                 # Notifications
      progress.js              # Progress bar component
    features/
      url-input.js             # URL paste/input handling + validation
      preview.js               # Video metadata preview card
      format-picker.js         # Audio/video format + quality selection
      download.js              # Download lifecycle + SSE progress
      history.js               # Recent downloads list
      login.js                 # Login form
  css/
    tokens.css                 # Design tokens (colors, spacing, typography)
    reset.css                  # CSS reset
    components/
      button.css
      input.css
      card.css
      progress.css
      toast.css
      badge.css
    pages/
      app.css                  # Main app layout
      login.css                # Login page
  icons/
    icon-192.png               # PWA icon
    icon-512.png               # PWA icon
  manifest.json                # PWA manifest with share_target
  sw.js                        # Service worker (cache app shell)
```

### 6.3 UI Layout

```
┌─────────────────────────────────────────────────────────┐
│  [Logo/Name]                            [Theme] [Logout]│
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  🔗  Paste a YouTube URL...              [Go]     │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ ┌──────────┐                                      │  │
│  │ │          │  Video Title Here                    │  │
│  │ │ thumbnail│  Channel Name  ·  3:45  ·  1.2M views│  │
│  │ │          │  Published Jan 15, 2026              │  │
│  │ ├──────────┤                                      │  │
│  │ │          │  ┌─────────────────────────────────┐ │  │
│  │ │          │  │ [Audio ▾]  [MP3 ▾]  [192k ▾]   │ │  │
│  │ └──────────┘  │ Est. size: ~5.6 MB              │ │  │
│  │               └─────────────────────────────────┘ │  │
│  │                                                   │  │
│  │               [ ↓ Download ]                      │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Active Downloads                                  │  │
│  │ ┌─────────────────────────────────────────────┐   │  │
│  │ │ Song Title.mp3       ██████████░░░  67%     │   │  │
│  │ │ 4.5 MB/s  ·  ETA 8s              [Cancel]  │   │  │
│  │ └─────────────────────────────────────────────┘   │  │
│  │ ┌─────────────────────────────────────────────┐   │  │
│  │ │ Video Title.mp4      Converting...          │   │  │
│  │ │ Processing with ffmpeg            [Cancel]  │   │  │
│  │ └─────────────────────────────────────────────┘   │  │
│  │ ┌─────────────────────────────────────────────┐   │  │
│  │ │ Another Video.mp3    ✓ Ready · 5.2 MB       │   │  │
│  │ │                                   [ Save ]  │   │  │
│  │ └─────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Recent                              [Clear All]   │  │
│  │                                                   │  │
│  │  Song Title · MP3 192k · 5.2 MB · 2 hours ago    │  │
│  │  Video Title · MP4 1080p · 48 MB · 3 hours ago   │  │
│  │  Another Song · MP3 192k · 4.1 MB · Yesterday    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 6.4 Mobile / PWA

**PWA manifest** with share target:

```json
{
  "name": "App Name",
  "short_name": "App",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0a0a",
  "theme_color": "#0a0a0a",
  "icons": [
    { "src": "/static/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/static/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "share_target": {
    "action": "/share",
    "method": "POST",
    "enctype": "application/x-www-form-urlencoded",
    "params": {
      "url": "url",
      "text": "text",
      "title": "title"
    }
  }
}
```

**Mobile UX flow**: User sees a YouTube video -> taps Share -> selects this app from share sheet -> app opens with URL pre-filled -> preview loads -> tap Download.

**Share target handler** (`/share` endpoint): Receives the shared URL, redirects to `/?url={encoded_url}`. The frontend detects the query parameter and auto-triggers metadata fetch.

**Service worker**: Minimal -- cache the app shell (HTML, CSS, JS, icons) for instant loading. All API calls pass through to network. No offline download capability (that requires network by definition).

**Note**: Web Share Target works on Chrome/Edge Android and desktop. Safari iOS does not support `share_target` -- for iOS, document a Shortcuts-based workaround (same approach MeTube uses).

### 6.5 Responsive Breakpoints

| Breakpoint | Layout Change |
|-----------|--------------|
| < 480px | Full-width URL input, stacked preview card (thumbnail above details), full-width download cards |
| 480-768px | Side-by-side thumbnail + details in preview card |
| > 768px | Max-width 800px centered layout, comfortable spacing |

Single-column layout at all breakpoints. No sidebar. The app is simple enough that it doesn't need one.

---

## 7. Backend Module Structure

### 7.1 File Structure

```
app/
  __init__.py                  # App factory (config, CSRF, auth, rate limiting)
  auth.py                      # Auth class (identical pattern to Compressify)
  forms.py                     # LoginForm (Flask-WTF)
  routes.py                    # Core routes: /, /login, /logout, /theme
  youtube/
    __init__.py
    routes.py                  # Blueprint: /yt/info, /yt/start, /yt/progress, etc.
    downloader.py              # YouTubeDownloader class (yt-dlp wrapper)
    manager.py                 # DownloadManager (queue, concurrency, lifecycle)
    validators.py              # URL validation, format validation, SSRF checks
    models.py                  # DownloadTask dataclass, DownloadStatus enum
    store.py                   # JSON persistence (queue.json, history.json)
    cleanup.py                 # Temp file cleanup daemon thread
    sse.py                     # SSE helpers (MessageAnnouncer, format_sse)
templates/
  base.html                    # Base template (head, icons, CSRF meta)
  index.html                   # Main app
  login.html                   # Login page
```

### 7.2 Key Classes

**`DownloadTask`** (dataclass):
```python
@dataclass
class DownloadTask:
    id: str                    # UUID
    url: str                   # YouTube URL
    mode: str                  # "audio" or "video"
    format: str                # "mp3", "m4a", "opus", "mp4"
    quality: str               # "128", "192", "320" or "360", "720", "1080", etc.
    status: DownloadStatus     # enum: queued, downloading, processing, complete, failed, cancelled
    title: str | None          # Set after metadata fetch
    thumbnail: str | None
    channel: str | None
    duration: str | None
    created_at: datetime
    progress: float            # 0.0-100.0
    speed: str | None          # "4.5 MB/s"
    eta: str | None            # "12s"
    filesize: int | None       # Final file size in bytes
    output_path: str | None    # Temp file path (server-side only, never exposed)
    error: str | None          # Error message if failed
```

**`DownloadManager`** (singleton, initialized in app factory):
```python
class DownloadManager:
    def __init__(self, max_concurrent=3, temp_dir='/tmp/yt', data_dir='/data'):
        self.semaphore = threading.Semaphore(max_concurrent)
        self.tasks: dict[str, DownloadTask] = {}
        self.processes: dict[str, multiprocessing.Process] = {}
        self.progress_queues: dict[str, multiprocessing.Queue] = {}
        self.sse_announcers: dict[str, MessageAnnouncer] = {}
        self.store = JsonStore(data_dir)
        self.cleanup = CleanupDaemon(temp_dir, max_age_hours=2)

    def fetch_info(self, url: str) -> dict        # Metadata preview
    def enqueue(self, task: DownloadTask) -> str   # Returns task_id
    def cancel(self, task_id: str) -> bool
    def get_file_path(self, task_id: str) -> Path  # For send_file()
    def get_progress_stream(self, task_id: str) -> MessageAnnouncer
    def get_history(self) -> list[dict]
    def clear_history(self) -> None
```

**`YouTubeDownloader`** (runs in subprocess):
```python
class YouTubeDownloader:
    """Wraps yt-dlp. Instantiated inside the worker process."""

    def __init__(self, task: DownloadTask, progress_queue: multiprocessing.Queue):
        self.task = task
        self.progress_queue = progress_queue

    def download(self) -> Path:
        """Execute download. Returns path to output file.
        Progress updates sent to progress_queue via yt-dlp hooks."""

    def _build_options(self) -> dict:
        """Build yt-dlp options dict from task parameters."""

    def _progress_hook(self, d: dict) -> None:
        """yt-dlp progress callback. Sends updates to progress_queue."""

    def _postprocessor_hook(self, d: dict) -> None:
        """yt-dlp postprocessor callback. Tracks ffmpeg stage."""
```

### 7.3 yt-dlp Option Profiles

**Audio (MP3)**:
```python
{
    'format': 'bestaudio/best',
    'outtmpl': f'{temp_dir}/%(title)s.%(ext)s',
    'postprocessors': [{
        'key': 'FFmpegExtractAudio',
        'preferredcodec': 'mp3',
        'preferredquality': quality,     # '128', '192', '320'
    }],
    'progress_hooks': [self._progress_hook],
    'postprocessor_hooks': [self._postprocessor_hook],
    'ignoreerrors': False,
    'no_warnings': False,
    'quiet': True,
    'no_color': True,
    'ignore_config': True,              # Security: no config files
    'no_exec': True,                    # Security: no post-exec commands
    'socket_timeout': 30,
    'retries': 3,
}
```

**Audio (M4A -- native, no transcode)**:
```python
{
    'format': 'bestaudio[ext=m4a]/bestaudio/best',
    'outtmpl': f'{temp_dir}/%(title)s.%(ext)s',
    # No postprocessors -- native format, just download
}
```

**Audio (Opus -- native, no transcode)**:
```python
{
    'format': 'bestaudio[ext=webm]/bestaudio/best',
    'outtmpl': f'{temp_dir}/%(title)s.%(ext)s',
    # No postprocessors
}
```

**Video (MP4)**:
```python
{
    'format': f'bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]'
              f'/bestvideo[height<={quality}]+bestaudio'
              f'/best[height<={quality}]'
              f'/best',
    'merge_output_format': 'mp4',
    'outtmpl': f'{temp_dir}/%(title)s.%(ext)s',
    'postprocessors': [{
        'key': 'FFmpegVideoConvertor',
        'preferedformat': 'mp4',
    }],
}
```

### 7.4 Gunicorn Configuration

```python
# gunicorn.conf.py
worker_class = 'gthread'       # Thread-based for SSE support
workers = 2                     # 2 processes
threads = 4                     # 4 threads per worker (handles SSE connections)
timeout = 300                   # 5 min (longer than Compressify due to downloads)
keepalive = 5
max_requests = 1000
max_requests_jitter = 50
```

**Why gthread**: SSE connections are long-lived. Each occupies a thread for the duration of the download. With `sync` workers, one SSE connection would block an entire worker process. `gthread` allows 4 concurrent SSE connections per worker (8 total across 2 workers), which is more than enough for a self-hosted single-user app.

**Why not gevent**: Would work, but adds a dependency and requires monkey-patching. `gthread` is simpler and sufficient at this scale. Document gevent as an upgrade path if someone needs more concurrent SSE connections.

---

## 8. Deployment

### 8.1 Docker Image

```dockerfile
# Stage 1: Static ffmpeg binaries
FROM mwader/static-ffmpeg:latest AS ffmpeg

# Stage 2: Runtime
FROM python:3.11-slim

# System deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip && \
    rm -rf /var/lib/apt/lists/*

# Deno (JS runtime for yt-dlp YouTube cipher solving)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_DIR=/usr/local/share/deno
ENV PATH="/root/.deno/bin:$PATH"

# ffmpeg binaries (~50-70 MB)
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code
COPY . /app
WORKDIR /app

# Non-root user
RUN useradd -m -r appuser && \
    mkdir -p /data /tmp/yt && \
    chown -R appuser:appuser /app /data /tmp/yt
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8000/login || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
```

**Expected image size**: ~250-300 MB compressed (Python slim ~43 MB + ffmpeg ~60 MB + Deno ~50 MB + yt-dlp + app code + deps).

### 8.2 Docker Compose (Production)

```yaml
services:
  app:
    build: .
    ports:
      - "8000:8000"
    environment:
      - APP_PASSWORD=${APP_PASSWORD}
      - SECRET_KEY=${SECRET_KEY}
      - MAX_CONCURRENT_DOWNLOADS=3
      - MAX_DURATION=14400
      - MAX_FILESIZE=2147483648     # 2 GB
      - MAX_PLAYLIST_ITEMS=50
      - TEMP_EXPIRY_HOURS=2
    volumes:
      - app-data:/data              # Persistent state (queue, history)
    tmpfs:
      - /tmp/yt:size=4G            # RAM-backed temp storage
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "200k"
        max-file: "10"

volumes:
  app-data:
```

### 8.3 Docker Compose (Development)

```yaml
services:
  app:
    build: .
    ports:
      - "5001:5000"
    environment:
      - FLASK_DEBUG=1
      - APP_PASSWORD=dev
      - SECRET_KEY=dev-secret-key
    volumes:
      - .:/app                      # Hot reload
      - app-data:/data
    tmpfs:
      - /tmp/yt:size=2G
    command: python run.py

volumes:
  app-data:
```

### 8.4 yt-dlp Update Strategy

**Primary: Nightly CI rebuild** (recommended):
- GitHub Actions cron job runs daily at midnight
- Checks if yt-dlp has a newer version (`pip index versions yt-dlp`)
- If yes: updates `requirements.txt`, commits, triggers image build
- Users pull new images via Watchtower or manual `docker pull`

**Fallback: Entrypoint update** (for users not running Watchtower):
```bash
# In docker-entrypoint.sh
if [ "${AUTO_UPDATE_YTDLP}" = "true" ]; then
    pip install --user --upgrade yt-dlp yt-dlp-ejs 2>/dev/null || true
fi
```

Enabled via `AUTO_UPDATE_YTDLP=true` env var. Adds 5-15 seconds to container start.

### 8.5 Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name yt.example.com;

    # SSL config...

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # SSE: disable buffering
    location /yt/progress/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        add_header X-Accel-Buffering no;
        add_header Cache-Control no-cache;
    }

    # File downloads: disable buffering, long timeout
    location /yt/file/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_max_temp_file_size 0;
    }
}
```

---

## 9. Configuration Reference

### 9.1 Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `APP_PASSWORD` | Login password (hashed at startup) | `my-secret-password` |
| `SECRET_KEY` | Flask session signing key | `$(openssl rand -hex 32)` |

### 9.2 Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8000` | Server port |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Parallel download limit (max 10) |
| `MAX_DURATION` | `14400` | Max video duration in seconds (4 hours) |
| `MAX_FILESIZE` | `2147483648` | Max output file size in bytes (2 GB) |
| `MAX_PLAYLIST_ITEMS` | `50` | Max items per playlist download |
| `TEMP_EXPIRY_HOURS` | `2` | Hours before temp files are cleaned up |
| `SESSION_TIMEOUT` | `1800` | Session timeout in seconds (30 min) |
| `DATA_DIR` | `/data` | Persistent storage for queue/history JSON |
| `TEMP_DIR` | `/tmp/yt` | Temp download directory |
| `AUTO_UPDATE_YTDLP` | `false` | Update yt-dlp on container start |
| `PROXY_FIX` | `false` | Enable Werkzeug ProxyFix (set `true` behind reverse proxy) |
| `LOG_LEVEL` | `INFO` | Logging level |
| `YTDL_OPTIONS` | `{}` | Extra yt-dlp options (JSON string) for advanced users |

---

## 10. Legal & Compliance

### 10.1 Disclaimer

The application must display a disclaimer in the UI footer and in the README:

> This application is intended for downloading content you have the right to access and save, such as your own uploads, Creative Commons-licensed material, or content where the rights holder has granted permission. Users are solely responsible for ensuring their use complies with applicable copyright laws and platform terms of service.

### 10.2 Legal Context

- A U.S. federal court (Feb 2026) ruled YouTube's rolling cipher qualifies as an access control measure under DMCA Section 1201(a). The Yout.com v. RIAA appeal is ongoing.
- Risk is lowest for private, self-hosted, personal-use tools. Risk increases significantly for public-facing services.
- All comparable self-hosted tools (MeTube, TubeArchivist, yt-dlp itself) remain published and actively maintained.
- This application ships as self-hosted software. It is not a public service. The operator assumes responsibility for their use.

### 10.3 Design Decisions Informed by Legal Risk

- **No public demo instance** -- documentation only describes self-hosted deployment
- **Authentication required** -- no anonymous access
- **No persistent media library** -- temp files expire after 2 hours; this is a download tool, not a hosting platform
- **YouTube-only scope** -- narrower surface than "any URL" downloading
- **No content re-distribution features** -- no sharing, no public links to downloaded files

---

## 11. Milestones

### v0.1 -- Core Loop (MVP)

- [ ] Flask app factory with auth (port from Compressify patterns)
- [ ] URL input + YouTube URL validation
- [ ] Metadata fetch + preview card (title, thumbnail, duration, channel)
- [ ] MP3 download (single quality: 192 kbps)
- [ ] MP4 download (single quality: 1080p)
- [ ] Progress via SSE (download percentage, speed, ETA)
- [ ] File serving via `send_file()`
- [ ] Temp file cleanup
- [ ] Docker image with ffmpeg + Deno
- [ ] Login page, session auth, CSRF

### v0.2 -- Quality & Polish

- [ ] Audio quality picker (128/192/320 kbps MP3, native M4A, native Opus)
- [ ] Video quality picker (360p-4K, only available resolutions shown)
- [ ] Estimated file size display per quality option
- [ ] Download queue (3 concurrent, FIFO for overflow)
- [ ] Cancel in-progress downloads
- [ ] Proper error states (private video, age-restricted, unavailable, network error)
- [ ] Dark/light theme
- [ ] Mobile-responsive layout

### v0.3 -- Completeness

- [ ] Download history (last 100, persisted JSON)
- [ ] Playlist support (list videos, select/deselect, batch download)
- [ ] PWA manifest + service worker + share target
- [ ] Queue persistence across restarts
- [ ] Rate limiting on all endpoints
- [ ] SSRF hardening (domain allowlist, private IP rejection)
- [ ] Production docker-compose with health checks
- [ ] Reverse proxy documentation (nginx, Caddy)
- [ ] `AUTO_UPDATE_YTDLP` entrypoint option

### v1.0 -- Release

- [ ] Nightly CI for yt-dlp updates
- [ ] Production deploy script (like Compressify's `run-prod.sh`)
- [ ] README with screenshots, quick start, full configuration reference
- [ ] Legal disclaimer in UI and docs
- [ ] YouTube Shorts support tested and verified
- [ ] Age-restricted video handling (cookie-based, documented)
- [ ] Resource limit enforcement (duration, filesize, concurrent)

### Future (v1.x)

- [ ] Multi-site support (yt-dlp's 1000+ extractors, opt-in via config)
- [ ] Subtitle/caption download
- [ ] Thumbnail download (JPEG, for album art use cases)
- [ ] Audio metadata embedding (artist, title, album art via mutagen)
- [ ] iOS Shortcut documentation (for Safari share -> app)
- [ ] Notification on completion (browser Notification API)
- [ ] Optional persistent download directory (keep files, serve them)
- [ ] Watchtower integration documentation

---

## 12. Dependencies

### Python

```
Flask==3.1.0
Flask-WTF==1.2.2
flask-limiter==3.10.0
python-dotenv==1.0.1
gunicorn==23.0.0
yt-dlp[default]>=2026.3.0
yt-dlp-ejs>=0.1.0
```

### System (in Docker image)

| Binary | Source | Size | Purpose |
|--------|--------|------|---------|
| `ffmpeg` | `mwader/static-ffmpeg` | ~50-70 MB | Audio extraction, stream merging, transcoding |
| `ffprobe` | `mwader/static-ffmpeg` | ~10 MB | Media analysis |
| `deno` | `deno.land/install.sh` | ~50 MB | YouTube cipher solving (required by yt-dlp-ejs) |

### Frontend (zero dependencies)

No npm packages, no build tools, no CDN imports. Entirely self-contained.

---

## 13. Open Questions

1. **App name** -- needs a name. Candidates: TubeGrab, ClipSave, MediaPull, Fetchify. Should it share Compressify's visual identity or be its own thing?

2. **Shared code with Compressify** -- auth.py, forms.py, theme system, login page, base.html are nearly identical. Extract a shared library? Or accept the duplication for independence?

3. **Multi-site from day one?** -- yt-dlp supports 1000+ sites. Scoping to YouTube-only simplifies UX (preview card, URL validation, quality options are YouTube-specific). But "any URL" support is a single config flag away. Worth the UX trade-off?

4. **Age-restricted content** -- requires a `cookies.txt` file from an authenticated YouTube session. Should the app support uploading/configuring a cookie file? Security implications of storing YouTube session cookies.

5. **Geo-restricted content** -- some videos are region-locked. Should the app support proxy/VPN configuration for yt-dlp? Or is this out of scope?

6. **Audio-only format default** -- MP3 is the most compatible but requires transcoding (lossy -> lossy). M4A is native (no transcode, no quality loss) but less universally compatible. Which should be the default?
