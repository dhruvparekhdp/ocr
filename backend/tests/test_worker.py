from datetime import UTC, datetime, timedelta

from sqlalchemy import update

from docai import worker
from docai.db import Document, DocumentStatus
from tests import fixtures


def _upload(client, headers, path):
    res = client.post("/api/documents", headers=headers, files=[("files", (path.name, path.read_bytes()))])
    return res.json()[0]["document"]


def test_upload_parse_and_fetch(client, make_tenant, tmp_path):
    _, headers = make_tenant()
    doc = _upload(client, headers, fixtures.text_pdf(tmp_path / "inv.pdf"))
    assert doc["status"] == "queued"
    assert client.get(f"/api/documents/{doc['id']}/parsed", headers=headers).status_code == 409

    assert worker.run(once=True) == 1

    meta = client.get(f"/api/documents/{doc['id']}", headers=headers).json()
    assert meta["status"] == "parsed"
    assert meta["page_count"] == 2
    assert meta["parsed_at"].endswith("Z")

    parsed = client.get(f"/api/documents/{doc['id']}/parsed", headers=headers).json()
    assert parsed["kind"] == "pdf"
    assert parsed["pages"][0]["lines"][0]["id"] == "p1-l0"
    text = client.get(f"/api/documents/{doc['id']}/parsed?format=text", headers=headers)
    assert text.headers["content-type"].startswith("text/plain")
    assert "=== Page 1 (text) ===" in text.text
    assert "INV-2026-0042" in text.text


def test_parse_error_marks_failed_and_reparse_requeues(client, make_tenant, tmp_path):
    _, headers = make_tenant()
    doc = _upload(client, headers, fixtures.encrypted_pdf(tmp_path / "locked.pdf"))
    worker.run(once=True)

    meta = client.get(f"/api/documents/{doc['id']}", headers=headers).json()
    assert meta["status"] == "failed"
    assert "password-protected" in meta["error"]
    detail = client.get(f"/api/documents/{doc['id']}/parsed", headers=headers).json()["detail"]
    assert "failed" in detail and "password-protected" in detail

    requeued = client.post(f"/api/documents/{doc['id']}/reparse", headers=headers)
    assert requeued.status_code == 202
    assert requeued.json()["status"] == "queued"
    assert requeued.json()["error"] is None
    assert client.post(f"/api/documents/{doc['id']}/reparse", headers=headers).status_code == 409


def test_unexpected_errors_retry_then_fail(client, make_tenant, tmp_path, monkeypatch, session):
    _, headers = make_tenant()
    doc = _upload(client, headers, fixtures.semicolon_csv(tmp_path / "a.csv"))

    def boom(*args, **kwargs):
        raise RuntimeError("bug")

    monkeypatch.setattr(worker, "parse_file", boom)
    # Retries are immediate (parsing is local and deterministic); add backoff once network calls are involved.
    assert worker.run(once=True) == worker.MAX_ATTEMPTS
    meta = client.get(f"/api/documents/{doc['id']}", headers=headers).json()
    assert meta["status"] == "failed"
    assert meta["error"] == "internal error while parsing"  # internals are logged, not shown to tenants
    assert worker.run(once=True) == 0


def test_stale_processing_is_reclaimed(client, make_tenant, tmp_path, session):
    _, headers = make_tenant()
    doc = _upload(client, headers, fixtures.semicolon_csv(tmp_path / "a.csv"))
    fresh = datetime.now(UTC)
    session.execute(
        update(Document).where(Document.id == doc["id"]).values(status=DocumentStatus.PROCESSING, locked_at=fresh)
    )
    session.commit()
    assert worker.claim_next(session) is None  # another worker is on it

    stale = fresh - worker.STALE_AFTER - timedelta(minutes=1)
    session.execute(update(Document).where(Document.id == doc["id"]).values(locked_at=stale))
    session.commit()
    assert worker.run(once=True) == 1
    assert client.get(f"/api/documents/{doc['id']}", headers=headers).json()["status"] == "parsed"


def test_claim_is_exclusive(client, make_tenant, tmp_path, session, env):
    _, headers = make_tenant()
    _upload(client, headers, fixtures.semicolon_csv(tmp_path / "a.csv"))
    from docai.db import get_sessionmaker

    with get_sessionmaker()() as other:
        first = worker.claim_next(session)
        second = worker.claim_next(other)
    assert first is not None
    assert second is None


def test_parsed_output_is_tenant_scoped(client, make_tenant, tmp_path):
    _, acme = make_tenant("acme")
    _, globex = make_tenant("globex")
    doc = _upload(client, acme, fixtures.semicolon_csv(tmp_path / "a.csv"))
    worker.run(once=True)
    assert client.get(f"/api/documents/{doc['id']}/parsed", headers=acme).status_code == 200
    assert client.get(f"/api/documents/{doc['id']}/parsed", headers=globex).status_code == 404
    assert client.post(f"/api/documents/{doc['id']}/reparse", headers=globex).status_code == 404
