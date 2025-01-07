FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy diagnostic tools
COPY verify_env.py .
COPY test_auth.py .

# Make scripts executable
RUN chmod +x verify_env.py test_auth.py

ENTRYPOINT ["python3"]
CMD ["verify_env.py"]