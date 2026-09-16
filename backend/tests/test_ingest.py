import pytest

from docai.db import DocumentKind
from docai.ingest import ParseError, parse_file
from docai.ingest.layout import Segment, build_lines
from docai.ingest.model import BBox
from docai.ingest.pdf import _text_layer_usable
from docai.storage import sniff_file
from tests import fixtures


def parse(path):
    mime, kind = sniff_file(path, path.name)
    return parse_file(path, kind, mime, path.name, max_pages=50)


def page_text(page) -> str:
    return "\n".join(line.text for line in page.lines)


def _seg(text, x0, y0, x1, y1):
    return Segment(text=text, bbox=BBox(x0=x0, y0=y0, x1=x1, y1=y1), source="text")


def test_build_lines_orders_rows_and_keeps_column_gaps():
    lines = build_lines(
        [
            _seg("Total", 0.1, 0.50, 0.15, 0.52),
            _seg("29.75", 0.8, 0.505, 0.85, 0.525),
            _seg("Invoice", 0.1, 0.10, 0.17, 0.12),
            _seg("No", 0.17, 0.10, 0.19, 0.12),
        ],
        page_number=2,
    )
    assert [line.text for line in lines] == ["InvoiceNo", "Total" + " " * 8 + "29.75"]
    assert lines[0].id == "p2-l0"
    assert lines[1].bbox == BBox(x0=0.1, y0=0.5, x1=0.85, y1=0.525)


def test_text_layer_usable_rejects_sparse_and_garbled_text():
    good = [_seg("Invoice number INV-1 total 29.75", 0, 0, 1, 0.1)]
    assert _text_layer_usable(good)
    assert not _text_layer_usable([_seg("Page 1", 0, 0, 1, 0.1)])
    assert not _text_layer_usable([_seg(chr(0xFFFD) * 15 + "abcdefghij", 0, 0, 1, 0.1)])


def test_text_pdf_uses_text_layer_with_positions_and_rotation(tmp_path):
    doc = parse(fixtures.text_pdf(tmp_path / "a.pdf"))
    first, rotated = doc.pages
    assert first.source == "text"
    text = page_text(first)
    assert "Invoice No: INV-2026-0042" in text
    assert "TOTAL DUE EUR 29.75" in text
    row = next(line for line in first.lines if line.text.startswith("Widget A"))
    assert row.text.split() == ["Widget", "A", "2", "25.00"]
    assert "  " in row.text  # column gap preserved
    assert 0 < row.bbox.x0 < row.bbox.x1 <= 1 and 0 < row.bbox.y0 < row.bbox.y1 <= 1
    title = next(line for line in first.lines if line.text == "ACME TRADING LLC")
    assert title.bbox.y0 < row.bbox.y0  # top-left origin

    assert rotated.source == "text"
    [annex] = rotated.lines
    assert annex.text == "Rotated page annex with terms and conditions"
    # text runs horizontally in PDF space; on a page displayed rotated 90 degrees it becomes a tall, narrow box
    assert (annex.bbox.y1 - annex.bbox.y0) * rotated.height > (annex.bbox.x1 - annex.bbox.x0) * rotated.width


def test_scanned_pdf_is_ocrd(tmp_path):
    doc = parse(fixtures.scanned_pdf(tmp_path / "scan.pdf"))
    page = doc.pages[0]
    assert page.source == "ocr"
    text = page_text(page)
    for expected in ("ACME TRADING LLC", "INV-2026-0042", "29.75"):
        assert expected in text
    assert all(line.confidence and line.confidence > 0.5 for line in page.lines)
    # the image sits in the upper half of the page; OCR boxes are mapped onto page coordinates
    assert all(line.bbox.y1 < 0.6 for line in page.lines)


def test_mixed_pdf_ocrs_only_the_embedded_image(tmp_path):
    page = parse(fixtures.mixed_pdf(tmp_path / "mixed.pdf")).pages[0]
    assert page.source == "mixed"
    sources = {line.text: line.source for line in page.lines}
    assert sources["Expense report for March 2026, employee Jane Doe"] == "text"
    assert any("R-7781" in t and s == "ocr" for t, s in sources.items())


def test_searchable_scan_is_not_ocrd_again(tmp_path):
    page = parse(fixtures.searchable_scan_pdf(tmp_path / "searchable.pdf")).pages[0]
    assert page.source == "text"
    assert "Receipt R-7781" in page_text(page)


def test_encrypted_pdf_fails_with_clear_error(tmp_path):
    with pytest.raises(ParseError, match="password-protected"):
        parse(fixtures.encrypted_pdf(tmp_path / "locked.pdf"))


def test_page_limit(tmp_path):
    path = fixtures.text_pdf(tmp_path / "a.pdf")
    mime, kind = sniff_file(path, path.name)
    with pytest.raises(ParseError, match="limit is 1"):
        parse_file(path, kind, mime, path.name, max_pages=1)


def test_photo_exif_rotation_is_applied(tmp_path):
    doc = parse(fixtures.rotated_photo(tmp_path / "photo.jpg"))
    page = doc.pages[0]
    assert page.width > page.height  # displayed upright (landscape), not as stored (portrait)
    assert "Receipt R-7781" in page_text(page)


def test_multipage_tiff(tmp_path):
    doc = parse(fixtures.multipage_tiff(tmp_path / "scan.tiff"))
    assert [p.number for p in doc.pages] == [1, 2]
    assert "INV-2026-0042" in page_text(doc.pages[0])
    assert "R-7781" in page_text(doc.pages[1])


def test_workbook_values_formulas_merges_images_and_hidden_sheets(tmp_path):
    doc = parse(fixtures.workbook(tmp_path / "ledger.xlsx"))
    assert doc.kind == DocumentKind.SPREADSHEET
    ledger, notes = doc.sheets
    assert (ledger.n_rows, ledger.n_cols) == (5, 4)
    assert ledger.rows[1] == ["Date", "Description", "Amount", "Account"]
    assert ledger.rows[2] == ["2026-01-05", "Office rent", 1200.5, "00123"]
    assert ledger.rows[4][2] == "=SUM(C3:C4)"
    assert ledger.merged == ["A1:D1"]
    assert any("no cached value" in w for w in doc.warnings)
    [image] = ledger.images
    assert image.anchor == "F2"
    assert "APP-5521" in "\n".join(line.text for line in image.lines)
    assert notes.hidden and notes.rows == [[None, None], [None, "internal"]]

    text = doc.to_text()
    assert "| 3 | 2026-01-05 | Office rent | 1200.5 | 00123 |" in text
    assert "Hosting \\| cloud" in text
    assert "--- Image at F2 ---" in text


def test_csv_sniffs_delimiter_and_keeps_strings(tmp_path):
    doc = parse(fixtures.semicolon_csv(tmp_path / "export.csv"))
    [sheet] = doc.sheets
    assert sheet.name == "export.csv"
    assert sheet.rows == [["id", "name", "amount"], ["007", "Globex", "1.234,50"], ["008", "Initech", "99"]]
