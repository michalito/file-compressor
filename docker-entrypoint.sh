#!/bin/bash
set -e

# Check if required environment variables are set
if [ -z "$SECRET_KEY" ]; then
    echo "ERROR: SECRET_KEY environment variable is not set"
    exit 1
fi

if [ -z "$APP_PASSWORD" ]; then
    echo "ERROR: APP_PASSWORD environment variable is not set"
    exit 1
fi

# Generate password hash
HASH=$(python3 -c "from werkzeug.security import generate_password_hash; print(generate_password_hash('$APP_PASSWORD'))")

# Create .env file with secure permissions
echo "SECRET_KEY=$SECRET_KEY" > /app/instance/secrets/.env
echo "APP_PASSWORD=$APP_PASSWORD" >> /app/instance/secrets/.env
echo "PASSWORD_HASH=$HASH" >> /app/instance/secrets/.env

chmod 600 /app/instance/secrets/.env

# Create symlink to .env file
ln -sf /app/instance/secrets/.env /app/.env

echo "Environment setup complete:"
echo "- SECRET_KEY length: ${#SECRET_KEY}"
echo "- APP_PASSWORD length: ${#APP_PASSWORD}"
echo "- Generated hash length: ${#HASH}"

exec "$@"