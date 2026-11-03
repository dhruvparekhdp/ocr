import json
from decimal import Decimal

import pytest

from docai import cli, worker
from docai.doc_schema import get_schema
from docai.extract.batching import BatchItem, segregate
from docai.extract.heuristic import TextLine, classify, extract_offline
from docai.extract.result import Extraction, FieldValue
from docai.extract.validate import validate
from docai.extract.values import detect_currency, find_dates, parse_money, resolve_date
from docai.ingest.model import BBox, Line, Page, ParsedDocument, Sheet
from docai.ingest.pdf import parse_pdf
from tests import fixtures


def doc_from_lines(*texts: str) -> ParsedDocument:
    lines = [
        Line(id=f"p1-l{i}", text=t, bbox=BBox(x0=0, y0=i / 50, x1=1, y1=(i + 1) / 50), source="text")
        for i, t in enumerate(texts)
    ]
    return ParsedDocument(kind="pdf", pages=[Page(number=1, width=595, height=842, source="text", lines=lines)])


def dmy_schema():
    return get_schema().model_copy(update={"dateOrder": "DMY"})


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("1,234.56", "1234.56"),
        ("1.234,56", "1234.56"),
        ("1,23,456.00", "123456.00"),
        ("1'234.50", "1234.50"),
        ("(12.00)", "-12.00"),
        ("12,50", "12.50"),
        ("1.234.567", "1234567"),
        ("abc", None),
    ],
)
def test_parse_money_locales(raw, expected):
    assert parse_money(raw) == (Decimal(expected) if expected else None)


def test_dates_resolve_only_when_unambiguous():
    found = {
        raw: (d, m, y, c) for raw, d, m, y, c in find_dates("14/03/2026 03/04/2026 March 5, 2026 2026-03-01 7-Sep-26")
    }
    assert resolve_date(*found["14/03/2026"], None) == "2026-03-14"
    assert resolve_date(*found["03/04/2026"], None) is None
    assert resolve_date(*found["03/04/2026"], "DMY") == "2026-04-03"
    assert resolve_date(*found["03/04/2026"], "MDY") == "2026-03-04"
    assert resolve_date(*found["March 5, 2026"], None) == "2026-03-05"
    assert resolve_date(*found["2026-03-01"], None) == "2026-03-01"
    assert resolve_date(*found["7-Sep-26"], None) == "2026-09-07"


def test_currency_prefers_codes_and_never_guesses_dollar():
    assert detect_currency("Total EUR 29.75 (€)") == ("EUR", "EUR")
    assert detect_currency("Amount £12.00") == ("GBP", "£")
    assert detect_currency("Total $ 12.00") is None


def test_classification_prefers_longest_phrase_and_title():
    schema = get_schema()
    proforma = [
        TextLine("a", "PROFORMA INVOICE"),
        TextLine("b", "Invoice Date: 2026-01-01"),
        TextLine("c", "Valid Until 2026-02-01"),
    ]
    assert classify(proforma, schema)[0] == "Quotation"
    assert classify([TextLine("a", "Meeting notes")], schema) == ("Unknown", 0.0)


def test_credit_note_numbers_do_not_collide():
    extraction = extract_offline(
        doc_from_lines(
            "Contoso Ltd",
            "CREDIT NOTE",
            "Credit Note No: CN-0091",
            "Original Invoice No: INV-7781",
            "Amount Credited: 120.00",
        ),
        get_schema(),
    )
    assert extraction.document_type == "Credit Note"
    assert extraction.fields["documentNumber"].value == "CN-0091"
    assert extraction.fields["referenceNumber"].value == "INV-7781"
    assert extraction.fields["totalAmount"].value == "120.00"


def test_label_rules_do_not_invent_amounts_or_ids():
    extraction = extract_offline(
        doc_from_lines("Acme LLC", "TAX INVOICE", "Tax Invoice No: 20391", "Total:", "1,499.00"), get_schema()
    )
    fields = extraction.fields
    assert fields["taxAmount"].value is None  # "Tax Invoice No: 20391" is not a tax amount
    assert fields["documentNumber"].value == "20391"
    assert fields["totalAmount"].value == "1499.00"  # value on the line below its label
    assert fields["totalAmount"].line_id == "p1-l4"


def test_ambiguous_dates_are_flagged_not_guessed():
    extraction = extract_offline(doc_from_lines("Acme LLC", "INVOICE", "Invoice Date: 03/04/2026"), get_schema())
    assert extraction.fields["documentDate"].value is None
    assert extraction.fields["documentDate"].raw == "03/04/2026"
    assert any("ambiguous" in issue for issue in extraction.issues)


LEGACY_EXPECTED = {
    "invoice_001.pdf": (
        "Invoice",
        {
            "documentNumber": "INV-2024-001",
            "referenceNumber": "PO-7788",
            "issuerName": "Acme Exports Pvt Ltd",
            "issuerAddress": "12 Industrial Estate, Andheri East, Mumbai 400069",
            "issuerTaxId": "27ABCDE1234F1Z5",
            "recipientName": "Global Traders Inc",
            "documentDate": "2024-05-10",
            "subtotal": "11000.00",
            "totalAmount": "12500.00",
        },
    ),
    "po_7788.pdf": ("Purchase Order", {"documentNumber": "PO-7788", "documentDate": "2024-05-01"}),
    "receipt_001.pdf": (
        "Receipt",
        {
            "documentNumber": "RCPT-3341",
            "issuerName": "Zenith Retail LLP",
            "totalAmount": "990.00",
            "documentDate": "2024-06-20",
        },
    ),
    "invoice_orphan.pdf": ("Invoice", {"documentNumber": "INV-2024-999", "totalAmount": "3300.00"}),
    "transaction_001.pdf": ("Bank Statement", {"issuerName": "HDFC Bank Ltd"}),
    "random_note.pdf": ("Unknown", {}),
    "receipt_scanned.pdf": (
        "Receipt",
        {"documentNumber": "RCPT-7788", "issuerName": "Sunrise Stores Pvt Ltd", "totalAmount": "1499.00"},
    ),
}


def test_legacy_samples_parity(tmp_path):
    """The legacy Node smoke-test documents give the same answers (v2 field names, normalised values)."""
    directory = fixtures.legacy_samples(tmp_path / "samples")
    schema = dmy_schema()
    for name, (doc_type, expected) in LEGACY_EXPECTED.items():
        extraction = extract_offline(parse_pdf(directory / name, 5), schema)
        assert extraction.document_type == doc_type, name
        for field, value in expected.items():
            assert extraction.fields[field].value == value, (name, field)
    txn = extract_offline(parse_pdf(directory / "transaction_001.pdf", 5), schema)
    # no schema field for a transaction ID on a bank statement: kept under the document's own label
    assert ("Transaction ID", "TXN-88213") in [(a.label, a.value) for a in txn.additional_fields]


def test_two_column_international_invoice(tmp_path):
    extraction = validate(
        extract_offline(parse_pdf(fixtures.layout_invoice_pdf(tmp_path / "inv.pdf"), 5), get_schema()), get_schema()
    )
    assert extraction.values() | {} == extraction.values()
    expected = {
        "documentNumber": "NW-2026-0142",
        "referenceNumber": "PO-55120",
        "issuerName": "Nordwind Logistik GmbH",
        "issuerAddress": "Hafenstraße 12, 20457 Hamburg, Germany",
        "issuerTaxId": "DE 123456789",
        "recipientName": "Brightline Retail Ltd",
        "recipientAddress": "88 King Street, Manchester M2 4WU, United Kingdom",
        "documentDate": "2026-03-14",
        "dueDate": "2026-04-13",
        "currency": "EUR",
        "subtotal": "2150.00",
        "taxAmount": "408.50",
        "totalAmount": "2558.50",
    }
    for field, value in expected.items():
        assert extraction.fields[field].value == value, field
    assert not extraction.issues  # subtotal + tax = total, due date after issue date
    assert extraction.fields["totalAmount"].confidence > 0.9  # boosted by the passing check
    extra = {a.label: a.value for a in extraction.additional_fields}
    assert extra["Payment Terms"] == "Net 30"
    assert extra["IBAN"].startswith("DE89")  # not an invoice field, still returned


def test_validation_rules():
    schema = get_schema()
    ex = Extraction(
        document_type="Invoice",
        fields={
            "subtotal": FieldValue(value="100.00", confidence=0.8),
            "taxAmount": FieldValue(value="20.00", confidence=0.8),
            "totalAmount": FieldValue(value="125.00", confidence=0.8),
            "documentDate": FieldValue(value="2026-03-10", confidence=0.8),
            "dueDate": FieldValue(value="2026-03-01", confidence=0.8),
            "lineItems": FieldValue(value=[{"amount": "60.00"}, {"amount": "40.00"}], confidence=0.6),
        },
    )
    validate(ex, schema)
    assert any("subtotal + taxAmount = 120.00 but totalAmount = 125.00" in i for i in ex.issues)
    assert any("dueDate 2026-03-01 is before documentDate" in i for i in ex.issues)
    assert ex.fields["totalAmount"].confidence == 0.4
    assert ex.fields["lineItems"].confidence == 0.75  # line items sum to the subtotal

    statement = Extraction(
        document_type="Bank Statement",
        fields={
            "openingBalance": FieldValue(value="1000.00", confidence=0.8),
            "closingBalance": FieldValue(value="1150.00", confidence=0.8),
            "transactions": FieldValue(value=[{"credit": "200.00"}, {"debit": "50.00"}], confidence=0.6),
        },
    )
    assert not validate(statement, schema).issues


def test_batching_links_documents_across_key_fields():
    items = [
        BatchItem("1", "inv.pdf", "Invoice", {"documentNumber": "INV-1", "referenceNumber": "PO-9"}),
        BatchItem("2", "po.pdf", "Purchase Order", {"documentNumber": "po-9"}),
        BatchItem("3", "rcpt.pdf", "Receipt", {"documentNumber": "R-1", "referenceNumber": "INV-1"}),
        BatchItem("4", "other.pdf", "Invoice", {"documentNumber": "INV-2"}),
        BatchItem("5", "note.pdf", "Unknown", {}),
    ]
    result = segregate(items, ["documentNumber", "referenceNumber"])
    [batch] = result["batches"]
    assert {d["document_id"] for d in batch["documents"]} == {"1", "2", "3"}
    assert batch["batch_id"] == "BATCH-INV-1"
    assert {d["document_id"] for d in result["unbatched"]} == {"4", "5"}


def test_spreadsheet_statement_values():
    sheet = Sheet(
        name="Statement",
        n_rows=4,
        n_cols=2,
        rows=[
            ["Northbank plc", None],
            ["Account Number", "GB29 NWBK 6016 1331 9268 19"],
            ["Opening Balance", "1,000.00"],
            ["Closing Balance", "1,150.00"],
        ],
    )
    extraction = extract_offline(ParsedDocument(kind="spreadsheet", sheets=[sheet]), get_schema())
    assert extraction.document_type == "Bank Statement"
    assert extraction.fields["openingBalance"].value == "1000.00"
    assert extraction.fields["closingBalance"].line_id == "Statement!4"
    assert extraction.fields["accountNumber"].value == "GB29 NWBK 6016 1331 9268 19"


def test_analyze_cli_matches_legacy_report(tmp_path, capsys):
    directory = fixtures.legacy_samples(tmp_path / "samples")
    (directory / "notes.txt").write_text("not a document")
    out = tmp_path / "report.json"
    assert cli.main(["analyze", str(directory), "--out", str(out)]) == 0
    report = json.loads(out.read_text())
    assert report["summary"] == {
        "totalFiles": 8,
        "analyzed": 7,
        "ocrUsed": 1,
        "failed": 1,
        "batches": 1,
        "unbatched": 5,
    }
    [batch] = report["batches"]
    assert batch["batch_id"] == "BATCH-INV-2024-001"
    assert {d["filename"] for d in batch["documents"]} == {"invoice_001.pdf", "po_7788.pdf"}


def _upload(client, headers, path):
    return client.post("/api/documents", headers=headers, files=[("files", (path.name, path.read_bytes()))]).json()[0][
        "document"
    ]


def test_extraction_and_batches_api(client, make_tenant, tmp_path):
    _, acme = make_tenant("acme")
    _, globex = make_tenant("globex")
    samples = fixtures.legacy_samples(tmp_path / "samples")
    inv = _upload(client, acme, samples / "invoice_001.pdf")
    po = _upload(client, acme, samples / "po_7788.pdf")
    _upload(client, globex, samples / "invoice_001.pdf")
    worker.run(once=True)

    extraction = client.get(f"/api/documents/{inv['id']}/extraction", headers=acme).json()
    assert extraction["document_type"] == "Invoice"
    assert extraction["fields"]["documentNumber"]["value"] == "INV-2024-001"
    assert extraction["fields"]["documentNumber"]["line_id"] == "p1-l4"
    assert client.get(f"/api/documents/{inv['id']}/extraction", headers=globex).status_code == 404

    batches = client.get("/api/batches", headers=acme).json()
    [batch] = batches["batches"]
    assert {d["document_id"] for d in batch["documents"]} == {inv["id"], po["id"]}
    assert client.get("/api/batches", headers=globex).json()["batches"] == []  # never grouped across tenants


def test_llm_mode_without_model_keeps_parse(client, make_tenant, tmp_path, session):
    tenant, headers = make_tenant()
    tenant.mode = "llm"
    session.commit()
    doc = _upload(client, headers, fixtures.semicolon_csv(tmp_path / "a.csv"))
    worker.run(once=True)
    meta = client.get(f"/api/documents/{doc['id']}", headers=headers).json()
    assert meta["status"] == "parsed"
    assert "self-hosted model" in meta["error"]
    assert client.get(f"/api/documents/{doc['id']}/parsed", headers=headers).status_code == 200
    assert client.get(f"/api/documents/{doc['id']}/extraction", headers=headers).status_code == 409
