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
echo "SECRET_KEY=$SECRET_KEY" > /app/instance/secrets/.env
echo "APP_PASSWORD=$APP_PASSWORD" >> /app/instance/secrets/.env
chmod 600 /app/instance/secrets/.env

# Create symlink to .env file
ln -sf /app/instance/secrets/.env /app/.env

exec "$@"