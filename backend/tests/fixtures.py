"""Builders for realistic test documents, generated at test time so no binary fixtures live in git."""

import io
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.drawing.image import Image as XLImage
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
]


def _font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size)


def text_image(lines: list[str], size: int = 32, width: int = 1400) -> Image.Image:
    img = Image.new("RGB", (width, int(size * 1.9 * len(lines) + size * 2)), "white")
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        draw.text((size, size + i * int(size * 1.9)), line, fill="black", font=_font(size))
    return img


INVOICE_LINES = ["ACME TRADING LLC", "Invoice No: INV-2026-0042", "Date: 2026-03-14", "TOTAL DUE EUR 29.75"]
RECEIPT_LINES = ["CORNER CAFE", "Receipt R-7781", "Cappuccino 4.50", "Paid by card 4.50"]


def _draw_image(c: canvas.Canvas, img: Image.Image, x: float, y: float, width: float) -> None:
    """Draw keeping the aspect ratio: stretched glyphs are not what real scans look like."""
    c.drawImage(ImageReader(img), x, y, width=width, height=width * img.height / img.width)


def text_pdf(path: Path) -> Path:
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica", 11)
    c.drawString(50, 800, "ACME TRADING LLC")
    c.drawString(50, 780, "Invoice No: INV-2026-0042")
    c.drawString(380, 780, "Date: 2026-03-14")
    c.drawString(50, 700, "Widget A")
    c.drawString(300, 700, "2")
    c.drawString(450, 700, "25.00")
    c.drawString(50, 660, "TOTAL DUE EUR 29.75")
    c.showPage()
    c.setPageRotation(90)
    c.setFont("Helvetica", 11)
    c.drawString(50, 560, "Rotated page annex with terms and conditions")
    c.showPage()
    c.save()
    return path


def scanned_pdf(path: Path) -> Path:
    c = canvas.Canvas(str(path), pagesize=A4)
    _draw_image(c, text_image(INVOICE_LINES), 30, 550, width=535)
    c.showPage()
    c.save()
    return path


def mixed_pdf(path: Path) -> Path:
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica", 11)
    c.drawString(50, 800, "Expense report for March 2026, employee Jane Doe")
    _draw_image(c, text_image(RECEIPT_LINES), 50, 450, width=450)
    c.showPage()
    c.save()
    return path


def searchable_scan_pdf(path: Path) -> Path:
    """An image with an invisible OCR text layer on top, as produced by scanners."""
    c = canvas.Canvas(str(path), pagesize=A4)
    _draw_image(c, text_image(RECEIPT_LINES), 50, 450, width=450)
    text = c.beginText(60, 535)  # inside the image, which spans y=450..549
    text.setTextRenderMode(3)
    text.setFont("Helvetica", 14)
    for line in RECEIPT_LINES:
        text.textLine(line)
    c.drawText(text)
    c.showPage()
    c.save()
    return path


def encrypted_pdf(path: Path) -> Path:
    c = canvas.Canvas(str(path), pagesize=A4, encrypt="secret")
    c.drawString(50, 800, "Confidential")
    c.showPage()
    c.save()
    return path


def rotated_photo(path: Path) -> Path:
    """Pixels stored sideways with an EXIF orientation tag, like a phone camera."""
    upright = text_image(RECEIPT_LINES)
    stored = upright.transpose(Image.Transpose.ROTATE_90)
    exif = Image.Exif()
    exif[0x0112] = 6  # display = rotate stored pixels 90 degrees clockwise
    stored.save(path, format="JPEG", exif=exif, quality=95)
    return path


def multipage_tiff(path: Path) -> Path:
    first, second = text_image(INVOICE_LINES), text_image(RECEIPT_LINES)
    first.save(path, format="TIFF", save_all=True, append_images=[second])
    return path


def workbook(path: Path) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "Ledger"
    ws.append(["Statement for Globex GmbH"])
    ws.merge_cells("A1:D1")
    ws.append(["Date", "Description", "Amount", "Account"])
    ws.append([date(2026, 1, 5), "Office rent", 1200.5, "00123"])
    ws.append([date(2026, 1, 9), "Hosting | cloud", 89, "00456"])
    ws["C5"] = "=SUM(C3:C4)"
    ws["H40"].number_format = "0.00"  # formatting-only cell must not widen the sheet

    buf = io.BytesIO()
    text_image(["Approved by CFO", "Ref APP-5521"], size=28, width=700).save(buf, format="PNG")
    buf.seek(0)
    picture = XLImage(buf)
    ws.add_image(picture, "F2")

    hidden = wb.create_sheet("Notes")
    hidden.sheet_state = "hidden"
    hidden["B2"] = "internal"
    wb.save(path)
    return path


def semicolon_csv(path: Path) -> Path:
    path.write_text("id;name;amount\n007;Globex;1.234,50\n008;Initech;99\n", encoding="utf-8")
    return path


# Documents from the legacy Node sample generator (legacy/scripts/generate-samples.js), kept for parity.
LEGACY_TEXT_SAMPLES = {
    "po_7788.pdf": [
        "Acme Exports Pvt Ltd",
        "12 Industrial Estate, Andheri East, Mumbai 400069",
        "",
        "PURCHASE ORDER",
        "PO No: PO-7788",
        "Order Date: 01/05/2024",
        "Vendor: Global Traders Inc",
    ],
    "invoice_001.pdf": [
        "Acme Exports Pvt Ltd",
        "12 Industrial Estate, Andheri East, Mumbai 400069",
        "GSTIN: 27ABCDE1234F1Z5",
        "",
        "TAX INVOICE",
        "Invoice No.: INV-2024-001",
        "Invoice Date: 10/05/2024",
        "PO Ref: PO-7788",
        "Bill To: Global Traders Inc",
        "Subtotal: 11,000.00",
        "Grand Total: 12,500.00",
    ],
    "transaction_001.pdf": [
        "HDFC Bank Ltd",
        "ACCOUNT STATEMENT",
        "Transaction ID: TXN-88213",
        "Transaction Date: 15/06/2024",
        "Debit: 450.00",
    ],
    "receipt_001.pdf": [
        "Zenith Retail LLP",
        "4 Market Street, Pune 411001",
        "",
        "CASH RECEIPT",
        "Receipt No: RCPT-3341",
        "Date: 20/06/2024",
        "Payment Received",
        "Amount Paid: 990.00",
    ],
    "invoice_orphan.pdf": [
        "Nowhere Trading Co",
        "9 Nowhere Lane, Nashik 422001",
        "",
        "COMMERCIAL INVOICE",
        "Invoice Number: INV-2024-999",
        "Invoice Date: 22/06/2024",
        "Grand Total: 3,300.00",
    ],
    "random_note.pdf": ["Meeting notes", "Discussed quarterly planning and staffing."],
}
LEGACY_SCANNED_SAMPLES = {
    "receipt_scanned.pdf": [
        "Sunrise Stores Pvt Ltd",
        "CASH RECEIPT",
        "Receipt No: RCPT-7788",
        "Date: 25/06/2024",
        "Amount Paid: 1,499.00",
    ],
}


def lines_pdf(path: Path, lines: list[str]) -> Path:
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica", 12)
    y = 800
    for line in lines:
        if line:
            c.drawString(50, y, line)
        y -= 18
    c.showPage()
    c.save()
    return path


def lines_scanned_pdf(path: Path, lines: list[str]) -> Path:
    c = canvas.Canvas(str(path), pagesize=A4)
    _draw_image(c, text_image(lines, size=30, width=1000), 40, 500, width=500)
    c.showPage()
    c.save()
    return path


def legacy_samples(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name, lines in LEGACY_TEXT_SAMPLES.items():
        lines_pdf(directory / name, lines)
    for name, lines in LEGACY_SCANNED_SAMPLES.items():
        lines_scanned_pdf(directory / name, lines)
    return directory


def layout_invoice_pdf(path: Path) -> Path:
    """A two-column international invoice: issuer top-left, 'Bill To' left, meta right, totals bottom-right."""
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(50, 800, "Nordwind Logistik GmbH")
    c.setFont("Helvetica", 10)
    c.drawString(50, 784, "Hafenstraße 12, 20457 Hamburg, Germany")
    c.drawString(50, 770, "VAT No: DE 123456789")
    c.setFont("Helvetica-Bold", 14)
    c.drawString(400, 800, "INVOICE")
    c.setFont("Helvetica", 10)
    c.drawString(400, 784, "Invoice No: NW-2026-0142")
    c.drawString(400, 770, "Invoice Date: 14 March 2026")
    c.drawString(400, 756, "Due Date: 13/04/2026")
    c.drawString(400, 742, "Your PO: PO-55120")
    c.drawString(50, 720, "Bill To:")
    c.drawString(50, 706, "Brightline Retail Ltd")
    c.drawString(50, 692, "88 King Street, Manchester M2 4WU")
    c.drawString(50, 678, "United Kingdom")
    c.drawString(50, 640, "Description")
    c.drawString(300, 640, "Qty")
    c.drawString(360, 640, "Unit Price")
    c.drawString(470, 640, "Amount")
    c.drawString(50, 624, "Sea freight Hamburg - Felixstowe")
    c.drawString(300, 624, "1")
    c.drawString(360, 624, "1.850,00")
    c.drawString(470, 624, "1.850,00")
    c.drawString(50, 610, "Customs clearance")
    c.drawString(300, 610, "2")
    c.drawString(360, 610, "150,00")
    c.drawString(470, 610, "300,00")
    c.drawString(360, 580, "Subtotal")
    c.drawString(470, 580, "EUR 2.150,00")
    c.drawString(360, 566, "VAT 19%")
    c.drawString(470, 566, "EUR 408,50")
    c.drawString(360, 552, "Total Due")
    c.drawString(470, 552, "EUR 2.558,50")
    c.drawString(50, 520, "Payment Terms: Net 30")
    c.drawString(50, 506, "IBAN: DE89 3704 0044 0532 0130 00")
    c.showPage()
    c.save()
    return path
