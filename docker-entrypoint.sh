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

# Create .env file with secure permissions
# Use printf with %s to avoid shell expansion of special characters in values
printf 'SECRET_KEY=%s\n' "$SECRET_KEY" > /app/instance/secrets/.env
printf 'APP_PASSWORD=%s\n' "$APP_PASSWORD" >> /app/instance/secrets/.env

chmod 600 /app/instance/secrets/.env

# Create symlink to .env file
ln -sf /app/instance/secrets/.env /app/.env

echo "Environment setup complete:"
echo "- SECRET_KEY length: ${#SECRET_KEY}"
echo "- APP_PASSWORD length: ${#APP_PASSWORD}"

exec "$@"