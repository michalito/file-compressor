import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault('APP_PASSWORD', 'test-password')
os.environ.setdefault('SECRET_KEY', 'test-secret-key')
os.environ.setdefault('FLASK_ENV', 'development')
os.environ.setdefault('PROXY_FIX', 'false')
os.environ.setdefault('LOGIN_RATE_LIMIT', '100 per minute')
os.environ.setdefault('PROCESS_RATE_LIMIT', '300 per minute')
os.environ.setdefault('DOWNLOAD_RATE_LIMIT', '300 per minute')
os.environ.setdefault('CROP_RATE_LIMIT', '100 per minute')

from app import create_app


app = create_app()


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5010, debug=False, use_reloader=False)
