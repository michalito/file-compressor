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

# Generate password hash and store it
python3 -c "
from werkzeug.security import generate_password_hash
import os
password = os.environ.get('APP_PASSWORD')
hash = generate_password_hash(password)
with open('/app/instance/secrets/.env', 'a') as f:
    f.write(f'\nPASSWORD_HASH={hash}\n')
"

chmod 600 /app/instance/secrets/.env

# Create symlink to .env file
ln -sf /app/instance/secrets/.env /app/.env

exec "$@"