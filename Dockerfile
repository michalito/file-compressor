FROM python:3.11-slim AS web-builder

WORKDIR /app
ENV U2NET_HOME=/opt/rembg

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libheif-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

RUN mkdir -p "${U2NET_HOME}" && \
    /opt/venv/bin/python -c "from rembg import new_session; new_session()"


FROM python:3.11-slim AS upscaler-builder

WORKDIR /app

COPY requirements-upscaler.txt .
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir torch==2.6.0 --index-url https://download.pytorch.org/whl/cpu && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements-upscaler.txt


FROM python:3.11-slim AS upscaler-cpu-runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libheif1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=upscaler-builder /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

RUN useradd -m appuser && \
    mkdir -p /models /tmp/compressify-upscaler && \
    chown -R appuser:appuser /app /models /tmp/compressify-upscaler

COPY upscaler_service upscaler_service/
COPY run_upscaler.py .

USER appuser

VOLUME /models
VOLUME /tmp/compressify-upscaler

EXPOSE 8765

CMD ["gunicorn", \
     "--bind", "0.0.0.0:8765", \
     "--workers", "1", \
     "--threads", "2", \
     "--timeout", "600", \
     "--keep-alive", "5", \
     "--worker-class", "sync", \
     "--access-logfile", "/dev/null", \
     "--error-logfile", "-", \
     "run_upscaler:app"]


FROM python:3.11-slim AS web-runtime

WORKDIR /app
ENV U2NET_HOME=/opt/rembg

RUN apt-get update && apt-get install -y --no-install-recommends \
    libzbar0 \
    libheif1 \
    dos2unix \
    && rm -rf /var/lib/apt/lists/*

COPY --from=web-builder /opt/venv /opt/venv
COPY --from=web-builder /opt/rembg /opt/rembg

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    FLASK_ENV=production \
    FLASK_APP=run.py \
    PYTHONPATH=/app \
    U2NET_HOME=/opt/rembg

RUN useradd -m appuser && \
    chown -R appuser:appuser /app && \
    mkdir -p /app/instance/secrets && \
    chown -R appuser:appuser /app/instance && \
    chown -R appuser:appuser /opt/rembg && \
    chmod -R a+rX /opt/rembg && \
    chmod 700 /app/instance/secrets

COPY app app/
COPY run.py .
COPY VERSION .

COPY docker-entrypoint.sh /app/
RUN dos2unix /app/docker-entrypoint.sh && \
    chmod +x /app/docker-entrypoint.sh && \
    chown appuser:appuser /app/docker-entrypoint.sh

RUN mkdir -p instance/temp && \
    chown -R appuser:appuser instance && \
    chmod 644 app/compression/*.py && \
    chmod 644 app/auth.py

USER appuser

VOLUME /app/instance/secrets

EXPOSE 8000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["gunicorn", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "1", \
     "--threads", "2", \
     "--timeout", "120", \
     "--keep-alive", "5", \
     "--worker-class", "sync", \
     "--preload", \
     "--access-logfile", "/dev/null", \
     "--error-logfile", "-", \
     "run:app"]
