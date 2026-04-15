import os

from upscaler_service import create_upscaler_app


app = create_upscaler_app()


if __name__ == '__main__':
    host = os.getenv('AI_UPSCALER_HOST', '127.0.0.1')
    port = int(os.getenv('AI_UPSCALER_PORT', '8765'))
    app.run(host=host, port=port, debug=False, use_reloader=False)
