import io
import zipfile

from docai.doc_schema import get_schema

PDF = b"%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def _xlsx() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("xl/workbook.xml", "<workbook/>")
    return buf.getvalue()


def _upload(client, headers, *files):
    return client.post("/api/documents", headers=headers, files=[("files", f) for f in files])


def test_health_is_public(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_requires_valid_api_key(client, make_tenant):
    make_tenant()
    assert client.get("/api/documents").status_code == 401
    assert client.get("/api/documents", headers={"X-API-Key": "dak_wrong"}).status_code == 401


def test_config_returns_default_schema_and_branding(client, make_tenant):
    _, headers = make_tenant()
    body = client.get("/api/config", headers=headers).json()
    assert body["tenant"] == "acme"
    assert body["branding"]["productName"] == get_schema().branding.productName
    assert {t["name"] for t in body["schema"]["documentTypes"]} >= {"Invoice", "Bank Statement"}


def test_tenant_specific_schema(client, make_tenant):
    custom = get_schema().model_copy(deep=True)
    custom.branding.productName = "Acme Docs"
    _, headers = make_tenant(schema=custom)
    assert client.get("/api/config", headers=headers).json()["branding"]["productName"] == "Acme Docs"


def test_upload_detects_kind_from_content(client, make_tenant):
    _, headers = make_tenant()
    res = _upload(
        client,
        headers,
        ("inv.pdf", PDF, "application/pdf"),
        ("scan.png", PNG, "image/png"),
        ("book.xlsx", _xlsx(), "application/octet-stream"),
        ("tx.csv", b"date,amount\n2026-01-01,10.00\n", "text/csv"),
    ).json()
    assert [(r["outcome"], r["document"]["kind"]) for r in res] == [
        ("created", "pdf"),
        ("created", "image"),
        ("created", "spreadsheet"),
        ("created", "spreadsheet"),
    ]


def test_upload_rejects_bad_files(client, make_tenant):
    _, headers = make_tenant()
    res = _upload(
        client,
        headers,
        ("fake.pdf", b"MZ\x90\x00 not a pdf", "application/pdf"),
        ("empty.pdf", b"", "application/pdf"),
        ("big.pdf", PDF + b"\x00" * (1024 * 1024), "application/pdf"),
        ("plain.zip", _zip_without_workbook(), "application/zip"),
    ).json()
    assert [r["outcome"] for r in res] == ["rejected"] * 4
    assert "unsupported" in res[0]["error"]
    assert "empty" in res[1]["error"]
    assert "limit" in res[2]["error"]


def _zip_without_workbook() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", "hi")
    return buf.getvalue()


def test_upload_strips_path_from_filename(client, make_tenant):
    _, headers = make_tenant()
    res = _upload(client, headers, ("../../etc/passwd.pdf", PDF, "application/pdf")).json()
    assert res[0]["document"]["filename"] == "passwd.pdf"


def test_duplicates_are_per_tenant(client, make_tenant):
    _, acme = make_tenant("acme")
    _, globex = make_tenant("globex")
    first = _upload(client, acme, ("a.pdf", PDF, "application/pdf")).json()[0]
    again = _upload(client, acme, ("renamed.pdf", PDF, "application/pdf")).json()[0]
    other = _upload(client, globex, ("a.pdf", PDF, "application/pdf")).json()[0]
    assert first["outcome"] == "created"
    assert again["outcome"] == "duplicate"
    assert again["document"]["id"] == first["document"]["id"]
    assert other["outcome"] == "created"
    assert other["document"]["id"] != first["document"]["id"]


def test_tenants_cannot_see_each_others_documents(client, make_tenant):
    _, acme = make_tenant("acme")
    _, globex = make_tenant("globex")
    doc_id = _upload(client, acme, ("a.pdf", PDF, "application/pdf")).json()[0]["document"]["id"]

    assert client.get("/api/documents", headers=globex).json() == {"total": 0, "items": []}
    assert client.get(f"/api/documents/{doc_id}", headers=globex).status_code == 404
    assert client.get(f"/api/documents/{doc_id}/file", headers=globex).status_code == 404

    listing = client.get("/api/documents", headers=acme).json()
    assert listing["total"] == 1
    assert client.get(f"/api/documents/{doc_id}", headers=acme).json()["filename"] == "a.pdf"
    file = client.get(f"/api/documents/{doc_id}/file", headers=acme)
    assert file.content == PDF
    assert file.headers["content-type"] == "application/pdf"


def test_list_pagination(client, make_tenant):
    _, headers = make_tenant()
    for i in range(3):
        _upload(client, headers, (f"{i}.pdf", PDF + bytes([i]), "application/pdf"))
    page = client.get("/api/documents?limit=2&offset=2", headers=headers).json()
    assert page["total"] == 3
    assert len(page["items"]) == 1


def test_timestamps_are_utc_everywhere(client, make_tenant):
    _, headers = make_tenant()
    created = _upload(client, headers, ("a.pdf", PDF, "application/pdf")).json()[0]["document"]["created_at"]
    listed = client.get("/api/documents", headers=headers).json()["items"][0]["created_at"]
    assert created == listed
    assert listed.endswith("Z")
