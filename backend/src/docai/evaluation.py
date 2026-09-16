"""Ground-truth labels and field-level scoring.

A label (or prediction) is one JSON file per document, named `<document filename>.json`:
    {"file": "inv_001.pdf", "documentType": "Invoice", "fields": {"totalAmount": "1499.00", ...}}
Value conventions: dates as YYYY-MM-DD, money/number as plain decimals ("1499.00"), currency as ISO 4217,
tables as a list of row objects keyed by column name, and null when the document does not show the field.
"""

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from docai.doc_schema import Column, DocSchema, FieldSpec, FieldType, get_schema, load_schema

SUPPORTED_SUFFIXES = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".xlsx", ".csv"}
MONEY_NOISE = re.compile(r"[^\d.\-()]")


class LabelError(ValueError):
    pass


def _to_decimal(value: Any) -> Decimal:
    if isinstance(value, bool):
        raise InvalidOperation
    if isinstance(value, int | float):
        return Decimal(str(value))
    text = MONEY_NOISE.sub("", str(value))
    negative = text.startswith("(") and text.endswith(")")
    result = Decimal(text.strip("()"))
    return -result if negative else result


def normalize(value: Any, ftype: FieldType) -> Any:
    """Canonical form used for comparison; raises ValueError/InvalidOperation for malformed values."""
    if value is None:
        return None
    match ftype:
        case FieldType.STRING:
            return re.sub(r"[\W_]+", "", str(value).casefold())
        case FieldType.ID:
            return re.sub(r"\s+", "", str(value)).casefold()
        case FieldType.CURRENCY:
            return str(value).strip().upper()
        case FieldType.DATE:
            return date.fromisoformat(str(value))
        case FieldType.MONEY | FieldType.NUMBER:
            return _to_decimal(value)
    raise ValueError(f"cannot normalize scalar of type {ftype}")


def _normalize_row(row: dict[str, Any], columns: list[Column]) -> tuple:
    return tuple(normalize(row.get(c.name), c.type) for c in columns)


@dataclass
class DocRecord:
    file: str
    document_type: str
    fields: dict[str, Any]


def parse_record(data: dict[str, Any], schema: DocSchema, source: str) -> DocRecord:
    type_names = {t.name for t in schema.documentTypes}
    doc_type = data.get("documentType")
    if doc_type not in type_names:
        raise LabelError(f"{source}: documentType {doc_type!r} is not one of {sorted(type_names)}")
    fields = data.get("fields") or {}
    specs = {f.name: f for f in schema.fields}
    unknown = set(fields) - set(specs)
    if unknown:
        raise LabelError(f"{source}: unknown fields {sorted(unknown)}")
    for name, value in fields.items():
        spec = specs[name]
        try:
            if spec.type is FieldType.TABLE:
                if value is not None:
                    [_normalize_row(r, spec.columns) for r in value]
            else:
                normalize(value, spec.type)
        except (ValueError, InvalidOperation, TypeError, AttributeError):
            raise LabelError(f"{source}: field {name!r} has malformed {spec.type} value {value!r}") from None
    return DocRecord(file=data.get("file", source), document_type=doc_type, fields=fields)


def load_records(directory: Path, schema: DocSchema, strict: bool) -> dict[str, DocRecord]:
    records = {}
    for path in sorted(directory.glob("*.json")):
        data = json.loads(path.read_text())
        if strict:
            records[path.stem] = parse_record(data, schema, path.name)
        else:
            fields = data.get("fields")
            records[path.stem] = DocRecord(
                data.get("file", path.name), data.get("documentType"), fields if isinstance(fields, dict) else {}
            )
    return records


@dataclass
class FieldScore:
    total: int = 0
    correct: int = 0
    missed: int = 0
    spurious: int = 0
    wrong: int = 0
    rows_expected: int = 0
    rows_predicted: int = 0
    rows_matched: int = 0

    @property
    def accuracy(self) -> float:
        return self.correct / self.total if self.total else 0.0

    def row_f1(self) -> float | None:
        if not (self.rows_expected or self.rows_predicted):
            return None
        p = self.rows_matched / self.rows_predicted if self.rows_predicted else 0.0
        r = self.rows_matched / self.rows_expected if self.rows_expected else 0.0
        return 2 * p * r / (p + r) if p + r else 0.0


@dataclass
class Report:
    documents: int = 0
    missing_predictions: list[str] = field(default_factory=list)
    type_correct: int = 0
    confusion: Counter = field(default_factory=Counter)
    fields: dict[str, FieldScore] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "documents": self.documents,
            "missingPredictions": self.missing_predictions,
            "documentTypeAccuracy": self.type_correct / self.documents if self.documents else 0.0,
            "confusion": {f"{t} -> {p}": n for (t, p), n in sorted(self.confusion.items(), key=str)},
            "fields": {
                name: {
                    "total": s.total,
                    "accuracy": round(s.accuracy, 4),
                    "missed": s.missed,
                    "spurious": s.spurious,
                    "wrong": s.wrong,
                    **({"rowF1": round(f1, 4)} if (f1 := s.row_f1()) is not None else {}),
                }
                for name, s in self.fields.items()
            },
        }


def _safe_normalize(value: Any, spec: FieldSpec) -> Any:
    try:
        if spec.type is FieldType.TABLE:
            return None if value is None else [_normalize_row(r, spec.columns) for r in value]
        return normalize(value, spec.type)
    except (ValueError, InvalidOperation, TypeError, AttributeError):
        return object()  # malformed prediction: never equal to anything


def _score_field(score: FieldScore, spec: FieldSpec, expected: Any, predicted: Any) -> None:
    score.total += 1
    exp = _safe_normalize(expected, spec)
    pred = _safe_normalize(predicted, spec)
    if spec.type is FieldType.TABLE:
        exp_rows, pred_rows = Counter(exp or []), Counter(pred if isinstance(pred, list) else [])
        score.rows_expected += sum(exp_rows.values())
        score.rows_predicted += sum(pred_rows.values())
        score.rows_matched += sum((exp_rows & pred_rows).values())
        exp = exp_rows or None
        if pred is None or isinstance(pred, list):
            pred = pred_rows or None
    if exp == pred:
        score.correct += 1
    elif pred is None:
        score.missed += 1
    elif exp is None:
        score.spurious += 1
    else:
        score.wrong += 1


def score(labels: dict[str, DocRecord], predictions: dict[str, DocRecord], schema: DocSchema) -> Report:
    report = Report(fields={f.name: FieldScore() for f in schema.fields})
    for key, label in labels.items():
        report.documents += 1
        pred = predictions.get(key)
        if pred is None:
            report.missing_predictions.append(key)
        pred_type = pred.document_type if pred else None
        report.confusion[(label.document_type, pred_type)] += 1
        if pred_type == label.document_type:
            report.type_correct += 1
        for spec in schema.fields_for(label.document_type):
            predicted = pred.fields.get(spec.name) if pred else None
            _score_field(report.fields[spec.name], spec, label.fields.get(spec.name), predicted)
    report.fields = {k: v for k, v in report.fields.items() if v.total}
    return report


def write_templates(docs_dir: Path, labels_dir: Path, schema: DocSchema) -> list[Path]:
    labels_dir.mkdir(parents=True, exist_ok=True)
    created = []
    for doc in sorted(p for p in docs_dir.iterdir() if p.suffix.lower() in SUPPORTED_SUFFIXES):
        target = labels_dir / f"{doc.name}.json"
        if target.exists():
            continue
        template = {"file": doc.name, "documentType": None, "fields": {f.name: None for f in schema.fields}}
        target.write_text(json.dumps(template, indent=2) + "\n")
        created.append(target)
    return created


def _print_report(report: Report) -> None:
    d = report.to_dict()
    print(f"documents: {d['documents']}   document type accuracy: {d['documentTypeAccuracy']:.1%}")
    if d["missingPredictions"]:
        print(f"missing predictions: {len(d['missingPredictions'])}")
    print(f"\n{'field':<18}{'n':>5}{'acc':>8}{'missed':>8}{'spurious':>10}{'wrong':>7}{'rowF1':>8}")
    for name, s in d["fields"].items():
        f1 = f"{s['rowF1']:.1%}" if "rowF1" in s else ""
        print(
            f"{name:<18}{s['total']:>5}{s['accuracy']:>8.1%}{s['missed']:>8}{s['spurious']:>10}{s['wrong']:>7}{f1:>8}"
        )
    mistakes = {k: v for k, v in d["confusion"].items() if k.split(" -> ")[0] != k.split(" -> ")[1]}
    if mistakes:
        print("\ntype errors (label -> predicted):")
        for k, v in mistakes.items():
            print(f"  {k}: {v}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="docai-eval")
    parser.add_argument("--schema", type=Path, help="schema JSON (defaults to config/schema.json)")
    sub = parser.add_subparsers(dest="command", required=True)

    tpl = sub.add_parser("template", help="create empty label files for documents that have none")
    tpl.add_argument("documents", type=Path)
    tpl.add_argument("labels", type=Path)

    val = sub.add_parser("validate", help="check label files against the schema")
    val.add_argument("labels", type=Path)

    sc = sub.add_parser("score", help="score predictions against labels")
    sc.add_argument("labels", type=Path)
    sc.add_argument("predictions", type=Path)
    sc.add_argument("--json", type=Path, help="also write the report as JSON")

    args = parser.parse_args(argv)
    schema = load_schema(args.schema) if args.schema else get_schema()

    if args.command == "template":
        created = write_templates(args.documents, args.labels, schema)
        print(f"created {len(created)} label templates in {args.labels}")
        return 0

    if args.command == "validate":
        errors = []
        for path in sorted(args.labels.glob("*.json")):
            try:
                parse_record(json.loads(path.read_text()), schema, path.name)
            except (LabelError, json.JSONDecodeError) as e:
                errors.append(str(e) if isinstance(e, LabelError) else f"{path.name}: invalid JSON: {e}")
        for e in errors:
            print(e, file=sys.stderr)
        print(f"{len(errors)} invalid label files")
        return 1 if errors else 0

    try:
        labels = load_records(args.labels, schema, strict=True)
    except LabelError as e:
        print(f"invalid label: {e}", file=sys.stderr)
        return 1
    report = score(labels, load_records(args.predictions, schema, strict=False), schema)
    _print_report(report)
    if args.json:
        args.json.write_text(json.dumps(report.to_dict(), indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
