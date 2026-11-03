"""Database-polled job worker for document parsing.

The documents table is the queue: no Redis/broker to run, which keeps local and free-tier deployment to a
single database. Claims are an optimistic compare-and-set UPDATE, so several workers (or processes) are
safe on both SQLite and Postgres. A document stuck in `processing` (worker crashed) is reclaimed after
STALE_AFTER and fails permanently after MAX_ATTEMPTS.
"""

import argparse
import logging
import sys
import threading
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, or_, select, update
from sqlalchemy.orm import Session

from docai.db import Document, DocumentStatus, Tenant, get_sessionmaker
from docai.ingest import PARSER_VERSION, ParsedDocument, ParseError, parse_file
from docai.pipeline import ModeUnavailable, extract_document
from docai.settings import Settings, get_settings
from docai.storage import blob_path, extraction_path, parsed_path, write_atomic
from docai.tenants import tenant_schema

log = logging.getLogger("docai.worker")

STALE_AFTER = timedelta(minutes=15)
MAX_ATTEMPTS = 3


def claim_next(session: Session) -> Document | None:
    now = datetime.now(UTC)
    claimable = or_(
        Document.status == DocumentStatus.QUEUED,
        and_(Document.status == DocumentStatus.PROCESSING, Document.locked_at < now - STALE_AFTER),
    )
    candidates = session.execute(
        select(Document.id, Document.status, Document.locked_at).where(claimable).order_by(Document.created_at).limit(5)
    ).all()
    for doc_id, status, locked_at in candidates:
        unchanged = Document.locked_at.is_(None) if locked_at is None else Document.locked_at == locked_at
        result = session.execute(
            update(Document)
            .where(Document.id == doc_id, Document.status == status, unchanged)
            .values(status=DocumentStatus.PROCESSING, locked_at=now, attempts=Document.attempts + 1)
        )
        session.commit()
        if result.rowcount == 1:
            return session.get(Document, doc_id, populate_existing=True)
    return None


def _finish(session: Session, doc: Document, **values) -> None:
    session.execute(update(Document).where(Document.id == doc.id).values(locked_at=None, **values))
    session.commit()


def process(session: Session, doc: Document, settings: Settings) -> None:
    if doc.attempts > MAX_ATTEMPTS:
        _finish(session, doc, status=DocumentStatus.FAILED, error="processing did not complete after repeated attempts")
        return
    started = time.monotonic()
    try:
        parsed = parse_file(
            blob_path(settings.storage_dir, doc.tenant_id, doc.sha256),
            doc.kind,
            doc.mime_type,
            doc.filename,
            settings.max_pages,
        )
    except ParseError as e:
        _finish(session, doc, status=DocumentStatus.FAILED, error=str(e))
        log.info("document %s rejected: %s", doc.id, e)
        return
    except Exception:
        log.exception("document %s: unexpected parser error (attempt %d)", doc.id, doc.attempts)
        retry = doc.attempts < MAX_ATTEMPTS
        _finish(
            session,
            doc,
            status=DocumentStatus.QUEUED if retry else DocumentStatus.FAILED,
            error="internal error while parsing" + ("; will retry" if retry else ""),
        )
        return

    write_atomic(parsed_path(settings.storage_dir, doc.tenant_id, doc.id), parsed.model_dump_json())
    parsed_values = dict(page_count=parsed.page_count, parser_version=PARSER_VERSION, parsed_at=datetime.now(UTC))
    status, error, document_type = _extract(session, doc, parsed, settings)
    _finish(session, doc, status=status, error=error, document_type=document_type, **parsed_values)
    log.info("document %s %s: %d page(s) in %.1fs", doc.id, status, parsed.page_count, time.monotonic() - started)


def _extract(
    session: Session, doc: Document, parsed: ParsedDocument, settings: Settings
) -> tuple[DocumentStatus, str | None, str | None]:
    """Extraction failures keep the parse: the document stays `parsed` with an error and can be reprocessed."""
    tenant = session.get(Tenant, doc.tenant_id)
    try:
        extraction = extract_document(parsed, tenant_schema(tenant), tenant.mode)
    except ModeUnavailable as e:
        return DocumentStatus.PARSED, str(e), None
    except Exception:
        log.exception("document %s: unexpected extraction error", doc.id)
        return DocumentStatus.PARSED, "internal error while extracting", None
    write_atomic(extraction_path(settings.storage_dir, doc.tenant_id, doc.id), extraction.model_dump_json())
    return DocumentStatus.EXTRACTED, None, extraction.document_type


def run(once: bool = False, poll_interval: float = 1.0, stop: threading.Event | None = None) -> int:
    """Process queued documents; with `once`, return after the queue is empty. Returns the number processed."""
    settings = get_settings()
    stop = stop or threading.Event()
    processed = 0
    while not stop.is_set():
        with get_sessionmaker()() as session:
            doc = claim_next(session)
            if doc is not None:
                process(session, doc, settings)
                processed += 1
                continue
        if once:
            break
        stop.wait(poll_interval)
    return processed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="docai-worker", description="parse queued documents")
    parser.add_argument("--once", action="store_true", help="exit when the queue is empty")
    parser.add_argument("--poll-interval", type=float, default=1.0)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        count = run(once=args.once, poll_interval=args.poll_interval)
    except KeyboardInterrupt:
        return 0
    log.info("processed %d document(s)", count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
