from dataclasses import dataclass
from typing import Literal

from docai.ingest.model import BBox, Line

MAX_GAP_SPACES = 8


@dataclass
class Segment:
    text: str
    bbox: BBox
    source: Literal["text", "ocr"]
    confidence: float | None = None


def _vertical_overlap(a: BBox, b: BBox) -> float:
    overlap = min(a.y1, b.y1) - max(a.y0, b.y0)
    shortest = min(a.y1 - a.y0, b.y1 - b.y0)
    return overlap / shortest if shortest > 0 else 0.0


def _join(row: list[Segment]) -> str:
    """Join a row's segments left to right, turning horizontal gaps into spaces so columns stay visible."""
    text = row[0].text
    for prev, seg in zip(row, row[1:], strict=False):
        char_w = (prev.bbox.x1 - prev.bbox.x0) / max(len(prev.text), 1)
        gap = seg.bbox.x0 - prev.bbox.x1
        if char_w <= 0 or gap < 0.15 * char_w:
            text += seg.text  # touching runs, e.g. a font change mid-word
        else:
            spaces = max(1, min(MAX_GAP_SPACES, round(gap / char_w)))
            text = text.rstrip() + " " * spaces + seg.text.lstrip()
    return text


def build_lines(segments: list[Segment], page_number: int, start: int = 0) -> list[Line]:
    """Group segments into visual rows (top to bottom, left to right).

    Segments on one row are merged even across columns ("Bill To: A      Ship To: B"): the gap spacing
    keeps them distinguishable for the LLM, at the cost of a wider bbox for grounding.
    """
    rows: list[list[Segment]] = []
    for seg in sorted((s for s in segments if s.text.strip()), key=lambda s: (s.bbox.y0, s.bbox.x0)):
        for row in reversed(rows[-3:]):
            if _vertical_overlap(row[0].bbox, seg.bbox) >= 0.5:
                row.append(seg)
                break
        else:
            rows.append([seg])

    lines = []
    for i, row in enumerate(rows, start=start):
        row.sort(key=lambda s: s.bbox.x0)
        confidences = [s.confidence for s in row if s.confidence is not None]
        sources = {s.source for s in row}
        lines.append(
            Line(
                id=f"p{page_number}-l{i}",
                text=_join(row).strip(),
                bbox=BBox.union([s.bbox for s in row]),
                source="ocr" if "ocr" in sources else "text",
                confidence=round(min(confidences), 3) if confidences else None,
            )
        )
    return lines
