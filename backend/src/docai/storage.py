import hashlib
import os
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from docai.db import DocumentKind

CHUNK_SIZE = 1024 * 1024


class UploadRejected(ValueError):
    pass


@dataclass(frozen=True)
class StoredFile:
    sha256: str
    size_bytes: int
    mime_type: str
    kind: DocumentKind
    path: Path


def blob_path(storage_dir: Path, tenant_id: str, sha256: str) -> Path:
    return storage_dir / tenant_id / sha256[:2] / sha256


def _sniff(path: Path, filename: str) -> tuple[str, DocumentKind]:
    with path.open("rb") as f:
        head = f.read(4096)

    if head.startswith(b"%PDF-"):
        return "application/pdf", DocumentKind.PDF
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", DocumentKind.IMAGE
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", DocumentKind.IMAGE
    if head.startswith((b"II*\x00", b"MM\x00*")):
        return "image/tiff", DocumentKind.IMAGE
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp", DocumentKind.IMAGE
    if head.startswith(b"PK\x03\x04") and zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            if "xl/workbook.xml" in zf.namelist():
                return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", DocumentKind.SPREADSHEET
    if filename.lower().endswith(".csv") and b"\x00" not in head:
        try:
            head.decode("utf-8")
        except UnicodeDecodeError as e:
            # A multi-byte character may be cut at the 4096-byte boundary.
            if e.start < len(head) - 4:
                raise UploadRejected(f"{filename}: CSV must be UTF-8 encoded") from None
        return "text/csv", DocumentKind.SPREADSHEET

    raise UploadRejected(f"{filename}: unsupported file type (allowed: PDF, PNG, JPEG, TIFF, WEBP, XLSX, CSV)")


def store_upload(stream: BinaryIO, filename: str, storage_dir: Path, tenant_id: str, max_bytes: int) -> StoredFile:
    """Stream to a temp file while hashing, validate the content type, then move into content-addressed storage."""
    storage_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    fd, tmp_name = tempfile.mkstemp(dir=storage_dir, prefix=".upload-")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := stream.read(CHUNK_SIZE):
                size += len(chunk)
                if size > max_bytes:
                    raise UploadRejected(f"{filename}: exceeds the {max_bytes // (1024 * 1024)} MB limit")
                digest.update(chunk)
                out.write(chunk)
        if size == 0:
            raise UploadRejected(f"{filename}: file is empty")

        mime_type, kind = _sniff(tmp, filename)
        sha256 = digest.hexdigest()
        final = blob_path(storage_dir, tenant_id, sha256)
        final.parent.mkdir(parents=True, exist_ok=True)
        if final.exists():
            tmp.unlink()
        else:
            tmp.replace(final)
        return StoredFile(sha256, size, mime_type, kind, final)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
