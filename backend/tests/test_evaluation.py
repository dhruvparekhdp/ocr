import json
from datetime import date
from decimal import Decimal

import pytest

from docai.doc_schema import FieldType, get_schema
from docai.evaluation import LabelError, load_records, main, normalize, parse_record, score, write_templates


@pytest.mark.parametrize(
    ("value", "ftype", "expected"),
    [
        ("$1,499.00", FieldType.MONEY, Decimal("1499")),
        (1499, FieldType.MONEY, Decimal("1499")),
        ("(250.50)", FieldType.MONEY, Decimal("-250.50")),
        ("2026-03-01", FieldType.DATE, date(2026, 3, 1)),
        (" inv-001 ", FieldType.ID, "inv-001"),
        ("ACME Pvt. Ltd.", FieldType.STRING, "acmepvtltd"),
        ("Müller GmbH", FieldType.STRING, "müllergmbh"),
        ("usd", FieldType.CURRENCY, "USD"),
    ],
)
def test_normalize(value, ftype, expected):
    assert normalize(value, ftype) == expected


def test_label_validation_catches_mistakes():
    schema = get_schema()
    with pytest.raises(LabelError, match="documentType"):
        parse_record({"documentType": "Payslip", "fields": {}}, schema, "a.json")
    with pytest.raises(LabelError, match="unknown fields"):
        parse_record({"documentType": "Invoice", "fields": {"tip": "1"}}, schema, "a.json")
    with pytest.raises(LabelError, match="documentDate"):
        parse_record({"documentType": "Invoice", "fields": {"documentDate": "01/03/2026"}}, schema, "a.json")


def _rec(doc_type, **fields):
    return parse_record({"documentType": doc_type, "fields": fields}, get_schema(), "x")


def test_score_counts_outcomes_per_field():
    items = [{"description": "Widget", "quantity": 2, "unitPrice": "5.00", "amount": "10.00"}]
    labels = {
        "a": _rec("Invoice", documentNumber="INV-1", totalAmount="10.00", dueDate=None, lineItems=items),
        "b": _rec("Receipt", documentNumber="R-9", totalAmount="3.50"),
        "c": _rec("Invoice", documentNumber="INV-2"),
    }
    preds = {
        "a": _rec("Invoice", documentNumber="inv-1", totalAmount="10", dueDate="2026-01-01", lineItems=items),
        "b": _rec("Invoice", documentNumber=None, totalAmount="3.60"),
    }
    report = score(labels, preds, get_schema())
    d = report.to_dict()

    assert d["documents"] == 3
    assert d["missingPredictions"] == ["c"]
    assert d["documentTypeAccuracy"] == pytest.approx(1 / 3)
    assert d["fields"]["documentNumber"] == {"total": 3, "accuracy": 0.3333, "missed": 2, "spurious": 0, "wrong": 0}
    assert d["fields"]["totalAmount"]["wrong"] == 1
    assert d["fields"]["dueDate"]["spurious"] == 1
    assert d["fields"]["lineItems"]["rowF1"] == 1.0
    assert "dueDate" not in [f.name for f in get_schema().fields_for("Receipt")]


def test_malformed_predictions_count_as_wrong_not_missing(tmp_path):
    (tmp_path / "labels").mkdir()
    (tmp_path / "preds").mkdir()
    label = {"documentType": "Invoice", "fields": {"documentDate": "2026-01-02", "lineItems": None}}
    pred = {"documentType": "Invoice", "fields": {"documentDate": "02/01/2026", "lineItems": "not a table"}}
    (tmp_path / "labels" / "a.pdf.json").write_text(json.dumps(label))
    (tmp_path / "preds" / "a.pdf.json").write_text(json.dumps(pred))
    schema = get_schema()
    report = score(
        load_records(tmp_path / "labels", schema, strict=True),
        load_records(tmp_path / "preds", schema, strict=False),
        schema,
    ).to_dict()
    assert report["missingPredictions"] == []
    assert report["fields"]["documentDate"]["wrong"] == 1
    assert report["fields"]["lineItems"]["spurious"] == 1


def test_table_row_f1_partial_match():
    row = {"date": "2026-01-01", "description": "Fee", "debit": "1.00", "credit": None, "balance": "9.00"}
    other = {**row, "debit": "2.00", "balance": "8.00"}
    labels = {"s": _rec("Bank Statement", transactions=[row, other])}
    preds = {"s": _rec("Bank Statement", transactions=[row])}
    fields = score(labels, preds, get_schema()).to_dict()["fields"]
    assert fields["transactions"]["wrong"] == 1
    assert fields["transactions"]["rowF1"] == pytest.approx(2 / 3, abs=1e-4)


def test_cli_template_validate_score(tmp_path, capsys):
    docs, labels = tmp_path / "docs", tmp_path / "labels"
    docs.mkdir()
    (docs / "inv.pdf").write_bytes(b"%PDF-")
    (docs / "notes.txt").write_text("ignored")

    assert len(write_templates(docs, labels, get_schema())) == 1
    assert write_templates(docs, labels, get_schema()) == []
    assert main(["validate", str(labels)]) == 1  # documentType still null

    path = labels / "inv.pdf.json"
    data = json.loads(path.read_text())
    data["documentType"] = "Invoice"
    data["fields"]["totalAmount"] = "12.00"
    path.write_text(json.dumps(data))
    assert main(["validate", str(labels)]) == 0

    out = tmp_path / "report.json"
    assert main(["score", str(labels), str(labels), "--json", str(out)]) == 0
    assert json.loads(out.read_text())["documentTypeAccuracy"] == 1.0
    assert "totalAmount" in capsys.readouterr().out
