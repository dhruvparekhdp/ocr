"""Schema-declared cross-field checks. A passing check raises confidence of the fields involved; a failing one
lowers it and records an issue, which is what routes a field to human review (and to the LLM in hybrid mode)."""

from datetime import date
from decimal import Decimal, InvalidOperation

from docai.doc_schema import BalanceRule, DocSchema, NotBeforeRule, SumColumnRule, SumRule
from docai.extract.result import Extraction

PASS_BOOST = 0.15
FAIL_FACTOR = 0.5


def _money(value) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def _close(a: Decimal, b: Decimal) -> bool:
    return abs(a - b) <= max(Decimal("0.02"), abs(b) * Decimal("0.005"))


def _column_sum(rows, column: str) -> Decimal | None:
    if not isinstance(rows, list) or not rows:
        return None
    total = Decimal(0)
    for row in rows:
        value = _money(row.get(column)) if isinstance(row, dict) else None
        total += value or 0
    return total


def validate(extraction: Extraction, schema: DocSchema) -> Extraction:
    fields = extraction.fields

    def value(name):
        return fields[name].value if name in fields else None

    for rule in schema.validations:
        involved: list[str]
        ok: bool | None = None
        message = ""
        match rule:
            case SumRule():
                involved = [*rule.fields, rule.equals]
                parts = [_money(value(n)) for n in rule.fields]
                target = _money(value(rule.equals))
                if target is not None and parts and all(p is not None for p in parts):
                    ok = _close(sum(parts, Decimal(0)), target)
                    message = f"{' + '.join(rule.fields)} = {sum(parts, Decimal(0))} but {rule.equals} = {target}"
            case SumColumnRule():
                involved = [rule.table, rule.equals]
                total, target = _column_sum(value(rule.table), rule.column), _money(value(rule.equals))
                if total is not None and target is not None:
                    ok = _close(total, target)
                    message = f"sum of {rule.table}.{rule.column} = {total} but {rule.equals} = {target}"
            case NotBeforeRule():
                involved = [rule.field, rule.reference]
                try:
                    a, b = date.fromisoformat(str(value(rule.field))), date.fromisoformat(str(value(rule.reference)))
                except ValueError:
                    continue
                ok = a >= b
                message = f"{rule.field} {a} is before {rule.reference} {b}"
            case BalanceRule():
                involved = [rule.opening, rule.table, rule.closing]
                opening, closing = _money(value(rule.opening)), _money(value(rule.closing))
                credits, debits = (
                    _column_sum(value(rule.table), rule.credit),
                    _column_sum(value(rule.table), rule.debit),
                )
                if None not in (opening, closing, credits, debits):
                    expected = opening + credits - debits
                    ok = _close(expected, closing)
                    message = f"{rule.opening} + credits - debits = {expected} but {rule.closing} = {closing}"

        if ok is None:
            continue
        present = [n for n in involved if n in fields and fields[n].value is not None]
        for name in present:
            fv = fields[name]
            fv.confidence = round(min(1.0, fv.confidence + PASS_BOOST) if ok else fv.confidence * FAIL_FACTOR, 3)
        if not ok:
            extraction.issues.append(f"check failed: {message}")
    return extraction
