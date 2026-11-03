from docai.db import ProcessingMode
from docai.doc_schema import DocSchema
from docai.extract.heuristic import extract_offline
from docai.extract.result import Extraction
from docai.extract.validate import validate
from docai.ingest.model import ParsedDocument


class ModeUnavailable(RuntimeError):
    """The tenant's mode needs a component that isn't configured (e.g. no self-hosted model)."""


def extract_document(parsed: ParsedDocument, schema: DocSchema, mode: ProcessingMode) -> Extraction:
    if mode != ProcessingMode.OFFLINE:  # plain str when loaded from the database
        raise ModeUnavailable(f"{mode} mode needs the self-hosted model, which is not configured yet")
    return validate(extract_offline(parsed, schema), schema)
