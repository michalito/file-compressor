import pytest
from app import create_app


@pytest.fixture()
def app():
    app = create_app()
    app.config['TESTING'] = True
    app.config['WTF_CSRF_ENABLED'] = False
    return app


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def auth_client(client):
    """Client with an authenticated session."""
    with client.session_transaction() as sess:
        sess['authenticated'] = True
    return client
