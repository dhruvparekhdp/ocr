import pytest
from fastapi.testclient import TestClient

from docai.db import Base, get_sessionmaker
from docai.doc_schema import get_schema
from docai.main import app
from docai.settings import get_settings
from docai.tenants import create_tenant


def _clear_caches() -> None:
    get_settings.cache_clear()
    get_sessionmaker.cache_clear()
    get_schema.cache_clear()


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path / "files"))
    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    _clear_caches()
    Base.metadata.create_all(get_sessionmaker().kw["bind"])
    yield tmp_path
    _clear_caches()


@pytest.fixture
def session(env):
    with get_sessionmaker()() as s:
        yield s


@pytest.fixture
def client(env):
    return TestClient(app)


@pytest.fixture
def make_tenant(session):
    def _make(slug="acme", schema=None):
        tenant, key = create_tenant(session, slug, slug.title(), schema)
        return tenant, {"X-API-Key": key}

    return _make
