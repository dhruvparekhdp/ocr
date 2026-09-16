"""Unified document model: every input format (PDF, image, spreadsheet) is parsed into this shape.

Coordinates are normalised to 0..1 of the displayed page (origin top-left, page rotation applied),
so extraction in later phases can cite a location regardless of page size, DPI or source format.
"""

from typing import Literal

from pydantic import BaseModel, Field

PARSER_VERSION = 1

CellValue = str | int | float | bool | None


class BBox(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float

    @classmethod
    def union(cls, boxes: list["BBox"]) -> "BBox":
        return cls(
            x0=min(b.x0 for b in boxes),
            y0=min(b.y0 for b in boxes),
            x1=max(b.x1 for b in boxes),
            y1=max(b.y1 for b in boxes),
        )


class Line(BaseModel):
    id: str
    text: str
    bbox: BBox
    source: Literal["text", "ocr"]
    confidence: float | None = None


class Page(BaseModel):
    number: int
    width: float
    height: float
    source: Literal["text", "ocr", "mixed"]
    lines: list[Line] = Field(default_factory=list)


class SheetImage(BaseModel):
    anchor: str
    lines: list[Line] = Field(default_factory=list)


class Sheet(BaseModel):
    name: str
    hidden: bool = False
    n_rows: int
    n_cols: int
    rows: list[list[CellValue]]
    merged: list[str] = Field(default_factory=list)
    images: list[SheetImage] = Field(default_factory=list)
    truncated: bool = False


class ParsedDocument(BaseModel):
    parser_version: int = PARSER_VERSION
    kind: Literal["pdf", "image", "spreadsheet"]
    pages: list[Page] = Field(default_factory=list)
    sheets: list[Sheet] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)

    @property
    def page_count(self) -> int:
        return len(self.pages) or len(self.sheets)

    def to_text(self) -> str:
        """Layout-preserving plain text: the input format for LLM extraction and for human inspection."""
        parts = []
        for page in self.pages:
            parts.append(f"=== Page {page.number} ({page.source}) ===")
            parts.extend(line.text for line in page.lines)
        for sheet in self.sheets:
            parts.append(f"=== Sheet {sheet.name!r}{' (hidden)' if sheet.hidden else ''} ===")
            parts.append(_sheet_table(sheet))
            if sheet.truncated:
                parts.append(f"[truncated: sheet has {sheet.n_rows} rows x {sheet.n_cols} columns]")
            for image in sheet.images:
                parts.append(f"--- Image at {image.anchor} ---")
                parts.extend(line.text for line in image.lines)
        return "\n".join(parts) + "\n"


def column_letter(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def _cell(value: CellValue) -> str:
    return "" if value is None else str(value).replace("|", "\\|").replace("\n", " ")


def _sheet_table(sheet: Sheet) -> str:
    # Row numbers and column letters are kept so extraction can cite Excel-style cell references.
    width = max((len(r) for r in sheet.rows), default=0)
    if not width:
        return "(empty)"
    header = "| # | " + " | ".join(column_letter(i) for i in range(width)) + " |"
    rule = "|---|" + "---|" * width
    body = [f"| {i + 1} | " + " | ".join(_cell(v) for v in row) + " |" for i, row in enumerate(sheet.rows)]
    return "\n".join([header, rule, *body])
