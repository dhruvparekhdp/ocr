import logging
import threading
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import PurePath
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Security, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from docai.db import Document, DocumentKind, DocumentStatus, Tenant, get_session
from docai.doc_schema import Branding, DocSchema
from docai.ingest import ParsedDocument
from docai.settings import Settings, get_settings
from docai.storage import UploadRejected, blob_path, parsed_path, store_upload
from docai.tenants import find_by_api_key, tenant_schema

MAX_FILES_PER_REQUEST = 200


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Single-process deployments (free hosting) can run the parser in the API process instead of docai-worker.
    stop = threading.Event()
    thread = None
    if get_settings().embedded_worker:
        from docai import worker

        logging.getLogger("docai").setLevel(logging.INFO)
        if not logging.getLogger().handlers:
            logging.basicConfig(format="%(levelname)s:     %(name)s: %(message)s")

        thread = threading.Thread(target=worker.run, kwargs={"stop": stop}, name="docai-worker", daemon=True)
        thread.start()
    yield
    stop.set()
    if thread:
        thread.join(timeout=30)


app = FastAPI(title="DocAI", version="0.1.0", lifespan=lifespan)

SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def current_tenant(session: SessionDep, api_key: Annotated[str | None, Security(api_key_header)]) -> Tenant:
    tenant = find_by_api_key(session, api_key) if api_key else None
    if tenant is None:
        raise HTTPException(401, "missing or invalid API key", headers={"WWW-Authenticate": "ApiKey"})
    return tenant


TenantDep = Annotated[Tenant, Depends(current_tenant)]


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    sha256: str
    mime_type: str
    kind: DocumentKind
    size_bytes: int
    status: DocumentStatus
    created_at: datetime
    error: str | None
    page_count: int | None
    parsed_at: datetime | None


class UploadResult(BaseModel):
    filename: str
    outcome: Literal["created", "duplicate", "rejected"]
    document: DocumentOut | None = None
    error: str | None = None


class DocumentPage(BaseModel):
    total: int
    items: list[DocumentOut]


class TenantConfig(BaseModel):
    tenant: str
    branding: Branding
    schema_: DocSchema = Field(serialization_alias="schema")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config")
def config(tenant: TenantDep) -> TenantConfig:
    schema = tenant_schema(tenant)
    return TenantConfig(tenant=tenant.slug, branding=schema.branding, schema_=schema)


def _find_document(session: Session, tenant_id: str, sha256: str) -> Document | None:
    return session.scalar(select(Document).where(Document.tenant_id == tenant_id, Document.sha256 == sha256))


@app.post("/api/documents")
def upload_documents(
    files: list[UploadFile], tenant: TenantDep, session: SessionDep, settings: SettingsDep
) -> list[UploadResult]:
    if len(files) > MAX_FILES_PER_REQUEST:
        raise HTTPException(413, f"at most {MAX_FILES_PER_REQUEST} files per request")

    results = []
    for upload in files:
        filename = PurePath(upload.filename or "unnamed").name[:255] or "unnamed"
        try:
            stored = store_upload(
                upload.file, filename, settings.storage_dir, tenant.id, settings.max_upload_mb * 1024 * 1024
            )
        except UploadRejected as e:
            results.append(UploadResult(filename=filename, outcome="rejected", error=str(e)))
            continue

        existing = _find_document(session, tenant.id, stored.sha256)
        if existing:
            results.append(UploadResult(filename=filename, outcome="duplicate", document=existing))
            continue

        doc = Document(
            tenant_id=tenant.id,
            filename=filename,
            sha256=stored.sha256,
            mime_type=stored.mime_type,
            kind=stored.kind,
            size_bytes=stored.size_bytes,
        )
        session.add(doc)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            existing = _find_document(session, tenant.id, stored.sha256)
            results.append(UploadResult(filename=filename, outcome="duplicate", document=existing))
            continue
        results.append(UploadResult(filename=filename, outcome="created", document=doc))
    return results


@app.get("/api/documents")
def list_documents(
    tenant: TenantDep,
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> DocumentPage:
    scoped = select(Document).where(Document.tenant_id == tenant.id)
    total = session.scalar(select(func.count()).select_from(scoped.subquery())) or 0
    rows = session.scalars(scoped.order_by(Document.created_at.desc()).limit(limit).offset(offset)).all()
    return DocumentPage(total=total, items=rows)


def _get_or_404(session: Session, tenant: Tenant, document_id: str) -> Document:
    doc = session.get(Document, document_id)
    if doc is None or doc.tenant_id != tenant.id:
        raise HTTPException(404, "document not found")
    return doc


@app.get("/api/documents/{document_id}")
def get_document(document_id: str, tenant: TenantDep, session: SessionDep) -> DocumentOut:
    return _get_or_404(session, tenant, document_id)


@app.get("/api/documents/{document_id}/file")
def get_document_file(document_id: str, tenant: TenantDep, session: SessionDep, settings: SettingsDep) -> FileResponse:
    doc = _get_or_404(session, tenant, document_id)
    return FileResponse(
        blob_path(settings.storage_dir, tenant.id, doc.sha256), media_type=doc.mime_type, filename=doc.filename
    )


@app.post("/api/documents/{document_id}/reparse", status_code=202)
def reparse_document(document_id: str, tenant: TenantDep, session: SessionDep) -> DocumentOut:
    doc = _get_or_404(session, tenant, document_id)
    if doc.status in (DocumentStatus.QUEUED, DocumentStatus.PROCESSING):
        raise HTTPException(409, f"document is already {doc.status}")
    session.execute(
        update(Document)
        .where(Document.id == doc.id, Document.status == doc.status)
        .values(status=DocumentStatus.QUEUED, attempts=0, error=None, locked_at=None)
    )
    session.commit()
    session.refresh(doc)
    return doc


@app.get("/api/documents/{document_id}/parsed", response_model=None)
def get_parsed_document(
    document_id: str,
    tenant: TenantDep,
    session: SessionDep,
    settings: SettingsDep,
    format: Literal["json", "text"] = "json",
) -> ParsedDocument | PlainTextResponse:
    doc = _get_or_404(session, tenant, document_id)
    path = parsed_path(settings.storage_dir, tenant.id, doc.id)
    if doc.status != DocumentStatus.PARSED or not path.exists():
        raise HTTPException(409, f"document is {doc.status}" + (f": {doc.error}" if doc.error else ""))
    parsed = ParsedDocument.model_validate_json(path.read_text())
    if format == "text":
        return PlainTextResponse(parsed.to_text())
    return parsed
