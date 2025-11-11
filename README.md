# Image Compression Application

A web-based image compression tool that provides efficient, in-memory image processing with multiple compression options and batch processing capabilities.

## Quick Start with Docker

### Prerequisites
- Docker Desktop installed ([Download here](https://www.docker.com/products/docker-desktop))
- Git (to clone the repository)

### Step-by-Step Instructions

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/file-compressor.git
   cd file-compressor
   ```

2. **Create environment file:**
   ```bash
   cp example.env .env
   ```

3. **Edit the .env file with your secure values:**
   ```bash
   # Open with your preferred editor
   nano .env
   # OR
   vim .env
   # OR on macOS
   open -e .env
   ```

   Set the following variables:
   ```env
   SECRET_KEY=your-very-long-random-secret-key-here
   APP_PASSWORD=your-secure-password-here
   ```

   **Important:**
   - Use a strong, unique password for APP_PASSWORD
   - Generate a random SECRET_KEY (at least 32 characters)
   - You can generate a secret key with: `python3 -c "import secrets; print(secrets.token_hex(32))"`

4. **Build and start the application:**
   ```bash
   docker-compose up --build
   ```

   This command will:
   - Build the Docker image
   - Start the container
   - Show logs in your terminal

5. **Access the application:**
   - Open your browser and go to: `http://localhost:8000`
   - Login with the password you set in the .env file

6. **Stop the application:**
   - Press `Ctrl+C` in the terminal where docker-compose is running
   - OR run: `docker-compose down`

### Running in Background (Detached Mode)

To run the application in the background:

```bash
# Start in background
docker-compose up -d --build

# View logs
docker-compose logs -f

# Stop the application
docker-compose down
```

### Testing the Application

1. **Login:**
   - Navigate to `http://localhost:8000`
   - Enter the password from your .env file

2. **Upload and Compress Images:**
   - Drag and drop images or click to select
   - Supported formats: JPG, PNG, WebP, TIFF, HEIC
   - Maximum file size: 50MB per image

3. **Choose Compression Settings:**

   **Compression Modes:**
   - **Lossless**: Preserves quality, maintains original format
   - **Web**: Balanced compression (~200KB target)
   - **High**: Maximum compression (<100KB target)

   **Additional Options:**
   - Resize dimensions (maintains aspect ratio)
   - Output format selection (JPEG or WebP)
   - Quality adjustment slider

4. **Process Images:**
   - Click "Process" for individual images
   - Use "Process All" for batch processing
   - Monitor progress bars during processing

5. **Download Results:**
   - Download individual compressed images
   - Select multiple and download as ZIP archive
   - View compression statistics (size reduction %)

### Troubleshooting

**Container won't start:**
```bash
# Check if port 8000 is already in use
lsof -i :8000  # macOS/Linux
# OR
netstat -ano | findstr :8000  # Windows

# Use a different port by editing docker-compose.yml:
# Change "8000:8000" to "8080:8000" then access via http://localhost:8080
```

**Permission denied errors:**
```bash
# Rebuild with no cache
docker-compose build --no-cache
docker-compose up
```

**Can't login:**
- Verify APP_PASSWORD is set in .env file
- Check logs for errors: `docker-compose logs web`
- Ensure you're using the correct password

**View container status:**
```bash
docker-compose ps
```

**Reset everything:**
```bash
docker-compose down -v
docker system prune -a
# Then rebuild from step 4
```

## Features

- **Multiple Compression Modes**:
  - Lossless: Preserves image quality while reducing file size (maintains original format)
  - Web Optimization: Balanced compression for web assets
    - Optimized JPEG (default for better compatibility)
    - Optional WebP format for maximum web performance
    - Target size ~200KB
  - High Compression: Maximum size reduction for storage/email
    - Aggressive JPEG compression (default for better compatibility)
    - Optional WebP format for maximum compression
    - Target size <100KB
  
- **Batch Processing**: Process multiple images simultaneously
- **In-Memory Processing**: No server-side storage of files
- **Format Support**:
  - Input: JPG, PNG, WebP, TIFF, HEIC
  - Output: 
    - Lossless: Same as input format (JPG, PNG, WebP, TIFF)
    - Web/High Compression: JPEG (default) or WebP (optional)
  - Format Compatibility:
    - JPEG: Universal compatibility with all image viewers
    - WebP: Better compression, but limited compatibility with some desktop applications
- **User Interface Features**:
  - Drag-and-drop file upload
  - Image preview
  - Progress tracking
  - Dark/Light theme
  - Responsive design
  - Batch download as ZIP
- **Security Features**:
  - Authentication required
  - Rate limiting (60 operations/minute, 1000/day)
  - Secure session management
  - Protection against brute force attacks

## System Requirements

- **For Docker deployment:** Docker Desktop (includes everything needed)
- **For manual installation:** Python 3.11+, pip
- **Browser:** Modern web browser with JavaScript enabled (Chrome, Firefox, Safari, Edge)

## Advanced Docker Operations

### Monitoring

Monitor your deployment:

```bash
# View container status
docker-compose ps

# View resource usage
docker stats

# View application logs
docker-compose logs -f web

# View last 100 lines of logs
docker-compose logs --tail=100 web
```

### Updates and Maintenance

Update your deployment:

```bash
# Pull latest changes
git pull

# Rebuild and restart with new changes
docker-compose up -d --build

# Remove old images
docker image prune -f
```

### Using Different Ports

If port 8000 is already in use:

1. Edit `docker-compose.yml`
2. Change the ports section from `"8000:8000"` to `"YOUR_PORT:8000"`
3. Example for port 3000: `"3000:8000"`
4. Access the app at `http://localhost:3000`

### Environment Variables

Required environment variables in `.env`:

| Variable | Description | Example |
|----------|-------------|---------|
| `SECRET_KEY` | Flask secret key for sessions | `your-32-character-random-string` |
| `APP_PASSWORD` | Password to access the application | `YourSecurePassword123!` |
| `FLASK_ENV` | Environment mode (optional) | `production` or `development` |

### Docker Commands Reference

```bash
# Build image only
docker-compose build

# Start without rebuilding
docker-compose up -d

# Stop and remove containers
docker-compose down

# Stop, remove containers AND volumes
docker-compose down -v

# View real-time logs
docker-compose logs -f

# Restart a service
docker-compose restart web

# Execute command in running container
docker-compose exec web /bin/bash

# Remove all stopped containers and unused images
docker system prune -a
```

## Manual Installation (Alternative)

<details>
<summary>Click to expand manual installation instructions</summary>

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd file-compressor
   ```

2. Create and activate a virtual environment:
   ```bash
   python3 -m venv venv
   source venv/bin/activate  # Linux/Mac
   # or
   .\venv\Scripts\activate  # Windows
   ```

3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

4. Set up environment variables:
   ```bash
   cp example.env .env
   # Edit .env file with your configuration
   ```

5. Run the application:
   ```bash
   python run.py
   ```

The application will be available at `http://localhost:5000`

**Note:** Manual installation requires handling Python dependencies and potential system-specific issues. Docker is recommended for consistent deployment.

</details>

## Production Deployment

For production deployment, the application uses Gunicorn as the WSGI server with the following configuration:

- 4 worker processes
- 2 threads per worker
- 120 second timeout
- Maximum file size: 16MB (configurable)

### Environment Variables

- `FLASK_ENV`: Set to `production` for production environment
- `SECRET_KEY`: Required for session management (must be changed from default)
- `APP_PASSWORD`: Required for authentication (must be set to a secure password)
- `MAX_CONTENT_LENGTH`: Maximum allowed file size in bytes (default: 16MB)

### Security Features

The application includes comprehensive security measures:

1. **Authentication & Authorization**
   - Password-based authentication (no default passwords)
   - Secure session management
   - Rate limiting: 60 operations/minute, 1000/day
   - Brute force protection: 5-minute lockout after 5 failed attempts

2. **Data Protection**
   - CSRF protection on all forms and AJAX requests
   - Secure cookies in production (HTTPOnly, Secure, SameSite)
   - Input validation and sanitization
   - No server-side file storage (all in-memory processing)

3. **Production Security Checklist**
   - ✅ Set strong `SECRET_KEY` (32+ characters)
   - ✅ Use secure `APP_PASSWORD`
   - ✅ Enable HTTPS with reverse proxy
   - ✅ Set `FLASK_ENV=production`
   - ✅ Configure firewall rules
   - ✅ Regular security updates

### Example Nginx Configuration

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 16M;
    }
}
```

## Usage

1. **Authentication**:
   - Login with your configured password
   - Session remains active for configured duration
   - Rate limits apply to authenticated sessions

2. **Upload Images**:
   - Drag and drop images onto the upload area
   - Click the upload area to select files
   - Supported formats: JPG, PNG, WebP, TIFF, HEIC

3. **Configure Compression**:
   - Select compression mode:
     - Lossless: For preserving quality (keeps original format)
     - Web: For balanced compression (JPEG/WebP)
     - High: For maximum size reduction (JPEG/WebP)
   - Choose output format:
     - JPEG: Best compatibility with all devices and applications
     - WebP: Better compression for web use (optional)
   - Adjust quality settings if needed
   - Set maximum dimensions (optional)

4. **Format Considerations**:
   - JPEG output (default):
     - Works with all image viewers and applications
     - Good compression ratio
     - Suitable for photographs and complex images
   - WebP output (optional):
     - Better compression ratios
     - Excellent for web delivery
     - Limited compatibility with some desktop applications
     - Best used when targeting web deployment

5. *Process Images**:
   - Click "Process" for individual images
   - Use "Process Selected" for batch processing
   - Monitor progress through the progress bars
   - Note: Rate limits apply (60/minute, 1000/day)

6. Download Results**:
   - Download individual images
   - Use "Download Selected" for multiple files (creates ZIP)
   - Check compression statistics in the interface

## Memory Management

The application is designed to process files entirely in memory:

- Maximum file size limit: 50MB (configurable)
- Batch processing uses a queue system
- Memory is released after each file is processed
- No temporary files are stored on disk

## Browser Compatibility

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

## Development

### Project Structure

```
image-compressor/
├── app/
│   ├── compression/
│   │   ├── __init__.py
│   │   └── image_processor.py
│   ├── static/
│   │   ├── css/
│   │   └── js/
│   ├── templates/
│   │   └── *.html
│   ├── __init__.py
│   └── routes.py
├── tests/
├── Dockerfile
├── requirements.txt
└── run.py
```

### Running Tests

```bash
pytest tests/
```

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests
5. Submit a pull request

## Troubleshooting

### Common Issues

1. **File Upload Failures**:
   - Check file size limits
   - Verify file format support
   - Check browser console for errors

2. **Memory Issues**:
   - Reduce batch size
   - Check system memory availability
   - Monitor server logs

3. **Download Problems**:
   - Check browser download settings
   - Verify file permissions
   - Check network connectivity

### Logging

- Application logs are available in the standard output
- Use environment variable `FLASK_DEBUG=1` for debug logging
- Production logs are handled by Gunicorn

## License

[Add your license information here]

## Support

[Add support contact information here]