from pathlib import Path

from PIL import Image, ImageOps, ImageSequence, UnidentifiedImageError

from docai.ingest.errors import ParseError
from docai.ingest.layout import build_lines
from docai.ingest.model import Page, ParsedDocument
from docai.ingest.ocr import ocr_image

MAX_SIDE_PX = 4000  # phone photos can be 8000+ px; OCR detection downsizes anyway, this bounds memory


def parse_image(path: Path, max_pages: int) -> ParsedDocument:
    try:
        source = Image.open(path)
    except (UnidentifiedImageError, Image.DecompressionBombError) as e:
        raise ParseError(f"cannot open image: {e}") from None

    doc = ParsedDocument(kind="image")
    with source:
        for index, frame in enumerate(ImageSequence.Iterator(source)):  # multi-page TIFF
            if index >= max_pages:
                raise ParseError(f"image has more than {max_pages} pages")
            # Phone photos store rotation in EXIF instead of rotating pixels.
            image = ImageOps.exif_transpose(frame).convert("RGB")
            if max(image.size) > MAX_SIDE_PX:
                image.thumbnail((MAX_SIDE_PX, MAX_SIDE_PX), Image.Resampling.LANCZOS)
            number = index + 1
            lines = build_lines(ocr_image(image), number)
            if not lines:
                doc.warnings.append(f"page {number}: no text found by OCR")
            doc.pages.append(Page(number=number, width=image.width, height=image.height, source="ocr", lines=lines))
    return doc
