"""PDF → pages of positioned lines, deciding per page between the embedded text layer and OCR.

pypdfium2 (Apache-2.0/BSD-3) is used for both text and rendering. PyMuPDF is excluded (AGPL) and
pdfplumber is avoided because its cryptography dependency has no x86_64 macOS wheels any more.
"""

from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_raw

from docai.ingest.errors import ParseError
from docai.ingest.layout import Segment, build_lines
from docai.ingest.model import BBox, Page, ParsedDocument
from docai.ingest.ocr import ocr_image

RENDER_DPI = 200
MIN_TEXT_CHARS = 20
MAX_BAD_CHAR_RATIO = 0.1
REPLACEMENT_CHAR = chr(0xFFFD)
# Images down to 2% of the page are OCR'd: a pasted receipt can be <10% of a page, and logos often carry
# the issuer name. Capped per page to bound CPU time (~1 s per OCR call on the dev machine).
MIN_IMAGE_AREA = 0.02
MAX_IMAGE_REGIONS = 10


def _normalizer(page: pdfium.PdfPage):
    """Map PDF user-space rects (l, b, r, t) to 0..1 top-left coordinates of the page as displayed."""
    cl, cb, cr, ct = page.get_cropbox()
    rotation = page.get_rotation() % 360
    cw, ch = (cr - cl) or 1.0, (ct - cb) or 1.0

    def rotate(u: float, v: float) -> tuple[float, float]:
        match rotation:
            case 90:
                return 1 - v, u
            case 180:
                return 1 - u, 1 - v
            case 270:
                return v, 1 - u
        return u, v

    def normalize(left: float, bottom: float, right: float, top: float) -> BBox:
        corners = [rotate((x - cl) / cw, (ct - y) / ch) for x, y in ((left, top), (right, bottom))]
        xs, ys = [c[0] for c in corners], [c[1] for c in corners]
        clamp = lambda v: min(1.0, max(0.0, v))  # noqa: E731
        return BBox(x0=clamp(min(xs)), y0=clamp(min(ys)), x1=clamp(max(xs)), y1=clamp(max(ys)))

    return normalize


def _is_bad_char(c: str) -> bool:
    return c == REPLACEMENT_CHAR or (ord(c) < 32 and c not in "\t\n\r")


def _text_segments(page: pdfium.PdfPage, normalize) -> list[Segment]:
    textpage = page.get_textpage()
    segments = []
    for i in range(textpage.count_rects()):
        rect = textpage.get_rect(i)
        text = textpage.get_text_bounded(*rect)
        if text.strip():
            segments.append(Segment(text=text, bbox=normalize(*rect), source="text"))
    return segments


def _text_layer_usable(segments: list[Segment]) -> bool:
    chars = "".join(s.text for s in segments)
    visible = [c for c in chars if not c.isspace()]
    if len(visible) < MIN_TEXT_CHARS:
        return False
    # Broken font encodings extract as replacement/control characters: such a layer is worse than OCR.
    return sum(map(_is_bad_char, visible)) / len(visible) <= MAX_BAD_CHAR_RATIO


def _inside(box: BBox, region: BBox) -> bool:
    cx, cy = (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2
    return region.x0 <= cx <= region.x1 and region.y0 <= cy <= region.y1


def _image_regions_without_text(page: pdfium.PdfPage, normalize, segments: list[Segment]) -> list[BBox]:
    regions = []
    for obj in page.get_objects(filter=[pdfium_raw.FPDF_PAGEOBJ_IMAGE], max_depth=1):
        if obj.level != 0:
            continue  # bounds of objects nested in form XObjects are not in page space
        box = normalize(*obj.get_bounds())
        if (box.x1 - box.x0) * (box.y1 - box.y0) < MIN_IMAGE_AREA:
            continue
        # A searchable scan has an invisible text layer over its image; don't OCR what is already text.
        covered = sum(len(s.text.strip()) for s in segments if _inside(s.bbox, box))
        if covered < MIN_TEXT_CHARS:
            regions.append(box)
    regions.sort(key=lambda b: (b.x1 - b.x0) * (b.y1 - b.y0), reverse=True)
    return regions[:MAX_IMAGE_REGIONS]


def parse_pdf(path: Path, max_pages: int) -> ParsedDocument:
    try:
        pdf = pdfium.PdfDocument(path)
    except pdfium.PdfiumError as e:
        raise ParseError(f"cannot open PDF (encrypted, password-protected or corrupt): {e}") from None

    try:
        if len(pdf) > max_pages:
            raise ParseError(f"PDF has {len(pdf)} pages; the limit is {max_pages}")
        doc = ParsedDocument(kind="pdf")
        for index in range(len(pdf)):
            page = pdf[index]
            number = index + 1
            width, height = page.get_size()
            normalize = _normalizer(page)
            segments = _text_segments(page, normalize)

            if not _text_layer_usable(segments):
                image = page.render(scale=RENDER_DPI / 72).to_pil()
                lines = build_lines(ocr_image(image), number)
                source = "ocr"
                if not lines:
                    doc.warnings.append(f"page {number}: no text found by OCR")
            else:
                regions = _image_regions_without_text(page, normalize, segments)
                if regions:
                    image = page.render(scale=RENDER_DPI / 72).to_pil()
                    for region in regions:
                        crop = image.crop(
                            (region.x0 * image.width, region.y0 * image.height,
                             region.x1 * image.width, region.y1 * image.height)
                        )  # fmt: skip
                        segments.extend(ocr_image(crop, offset=region))
                lines = build_lines(segments, number)
                source = "mixed" if regions else "text"

            doc.pages.append(Page(number=number, width=width, height=height, source=source, lines=lines))
            page.close()
        return doc
    finally:
        pdf.close()
