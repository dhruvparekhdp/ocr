from pathlib import Path

from docai.db import DocumentKind
from docai.ingest.errors import ParseError
from docai.ingest.image import parse_image
from docai.ingest.model import PARSER_VERSION, ParsedDocument
from docai.ingest.pdf import parse_pdf
from docai.ingest.spreadsheet import parse_csv, parse_xlsx

__all__ = ["PARSER_VERSION", "ParseError", "ParsedDocument", "parse_file"]


def parse_file(path: Path, kind: DocumentKind, mime_type: str, filename: str, max_pages: int) -> ParsedDocument:
    match kind:
        case DocumentKind.PDF:
            return parse_pdf(path, max_pages)
        case DocumentKind.IMAGE:
            return parse_image(path, max_pages)
        case DocumentKind.SPREADSHEET if mime_type == "text/csv":
            return parse_csv(path, filename)
        case DocumentKind.SPREADSHEET:
            return parse_xlsx(path)
    raise ParseError(f"no parser for {kind}")
