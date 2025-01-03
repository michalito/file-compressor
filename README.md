# Image Compression Application

A web-based image compression tool that provides efficient, in-memory image processing with multiple compression options and batch processing capabilities.

## Features

- **Multiple Compression Modes**:
  - Lossless: Preserves image quality while reducing file size
  - Web Optimization: Balanced compression for web assets (target ~200KB)
  - High Compression: Maximum size reduction for storage/email
  
- **Batch Processing**: Process multiple images simultaneously
- **In-Memory Processing**: No server-side storage of files
- **Format Support**:
  - Input: JPG, PNG, WebP, TIFF, HEIC
  - Output: JPG, PNG, WebP
- **User Interface Features**:
  - Drag-and-drop file upload
  - Image preview
  - Progress tracking
  - Dark/Light theme
  - Responsive design
  - Batch download as ZIP

## Requirements

- Python 3.11+
- Docker (optional)
- Modern web browser with JavaScript enabled

## Installation

### Using Docker (Recommended)

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd image-compressor
   ```

2. Build and run with Docker:
   ```bash
   docker build -t image-compressor:prod .
   docker run -d --name image-compressor -p 8000:8000 -e SECRET_KEY=your-production-secret-key image-compressor:prod
   ```

The application will be available at `http://localhost:8000`

### Manual Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd image-compressor
   ```

2. Create and activate a virtual environment:
   ```bash
   python -m venv venv
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
   cp .env.example .env
   # Edit .env file with your configuration
   ```

5. Run the application:
   ```bash
   python run.py
   ```

The application will be available at `http://localhost:5000`

## Production Deployment

For production deployment, the application uses Gunicorn as the WSGI server with the following configuration:

- 4 worker processes
- 2 threads per worker
- 120 second timeout
- Maximum file size: 16MB (configurable)

### Environment Variables

- `FLASK_ENV`: Set to `production` for production environment
- `SECRET_KEY`: Required for session management (must be changed from default)
- `MAX_CONTENT_LENGTH`: Maximum allowed file size in bytes (default: 16MB)

### Security Considerations

1. Always set a strong `SECRET_KEY` in production
2. Configure a reverse proxy (e.g., Nginx) in front of Gunicorn
3. Enable HTTPS in production
4. Configure appropriate CORS settings if needed
5. Monitor memory usage for large batch operations

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

1. **Upload Images**:
   - Drag and drop images onto the upload area
   - Click the upload area to select files
   - Supported formats: JPG, PNG, WebP, TIFF, HEIC

2. **Configure Compression**:
   - Select compression mode:
     - Lossless: For preserving quality
     - Web: For balanced compression
     - High: For maximum size reduction
   - Adjust quality settings if needed
   - Set maximum dimensions (optional)

3. **Process Images**:
   - Click "Compress" for individual images
   - Use "Compress Selected" for batch processing
   - Monitor progress through the progress bars

4. **Download Results**:
   - Download individual images
   - Use "Download Selected" for multiple files (creates ZIP)
   - Check compression statistics in the interface

## Memory Management

The application is designed to process files entirely in memory:

- Maximum file size limit: 16MB (configurable)
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