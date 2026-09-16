"""Local OCR with RapidOCR (PP-OCR models on ONNX Runtime, Apache-2.0; models ship inside the wheel).

Chosen over tesseract and torch-based engines: CPU-fast (~1 s/page on an Intel i5), no system binary,
no model download at runtime, and it runs on x86_64 macOS where PyTorch wheels stopped at 2.2.
"""

import threading
from functools import lru_cache

from PIL import Image

from docai.ingest.layout import Segment
from docai.ingest.model import BBox

# Measured on synthetic invoice text (see docs/DECISIONS.md): upscaling 2x only helped very small, noisy
# images (7px text: 0.67 -> 0.80 similarity) and was neutral otherwise; 3x made results worse.
UPSCALE_BELOW_PX = 1000

_lock = threading.Lock()


@lru_cache
def _engine():
    from rapidocr import RapidOCR  # slow import (~10 s cold): load only when OCR is actually needed

    return RapidOCR(params={"Global.log_level": "critical"})


def ocr_image(image: Image.Image, offset: BBox | None = None) -> list[Segment]:
    """OCR an image into text segments with bboxes normalised to the image, or to `offset` within a page."""
    image = image.convert("RGB")
    if max(image.size) < UPSCALE_BELOW_PX:
        image = image.resize((image.width * 2, image.height * 2), Image.Resampling.LANCZOS)

    with _lock:
        result = _engine()(image)
    if result.boxes is None or result.txts is None:
        return []

    frame = offset or BBox(x0=0, y0=0, x1=1, y1=1)
    fw, fh = frame.x1 - frame.x0, frame.y1 - frame.y0
    segments = []
    for box, text, score in zip(result.boxes, result.txts, result.scores, strict=True):
        xs, ys = [p[0] for p in box], [p[1] for p in box]
        bbox = BBox(
            x0=frame.x0 + fw * max(0.0, min(xs) / image.width),
            y0=frame.y0 + fh * max(0.0, min(ys) / image.height),
            x1=frame.x0 + fw * min(1.0, max(xs) / image.width),
            y1=frame.y0 + fh * min(1.0, max(ys) / image.height),
        )
        segments.append(Segment(text=text, bbox=bbox, source="ocr", confidence=float(score)))
    return segments
