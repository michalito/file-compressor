# Stage 1: Build stage
FROM python:3.11-slim as builder

# Set work directory
WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt && \
    /opt/venv/bin/pip install --no-cache-dir flask-limiter

# Stage 2: Production stage
FROM python:3.11-slim

# Set work directory
WORKDIR /app

# Install runtime dependencies and dos2unix
RUN apt-get update && apt-get install -y --no-install-recommends \
    libzbar0 \
    dos2unix \
    && rm -rf /var/lib/apt/lists/*

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv

# Set environment variables
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    FLASK_ENV=production \
    FLASK_APP=run.py \
    PYTHONPATH=/app

# Create non-root user and secure directories
RUN useradd -m appuser && \
    chown -R appuser:appuser /app && \
    mkdir -p /app/instance/secrets && \
    chown -R appuser:appuser /app/instance && \
    chmod 700 /app/instance/secrets

# Copy application code
COPY app app/
COPY run.py .

# Copy and prepare entrypoint script
COPY docker-entrypoint.sh /app/
RUN dos2unix /app/docker-entrypoint.sh && \
    chmod +x /app/docker-entrypoint.sh && \
    chown appuser:appuser /app/docker-entrypoint.sh

# Ensure proper permissions
RUN mkdir -p instance/temp && \
    chown -R appuser:appuser instance && \
    chmod 755 app/compression/*.py && \
    chmod 755 app/auth.py

# Switch to non-root user
USER appuser

# Create a mount point for secrets
VOLUME /app/instance/secrets

# Expose port
EXPOSE 8000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "4", "--threads", "2", "--timeout", "120", "run:app"]