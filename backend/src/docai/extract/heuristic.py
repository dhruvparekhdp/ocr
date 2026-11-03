"""Offline extraction: keyword classification + rule-based field extractors. No model, no network.

Ported from the legacy Node pipeline (legacy/analyze.js, legacy/extractors.js) and extended for global
documents: values are normalised to the schema conventions, every value is grounded to a parsed line id,
the recipient ("Bill To") block is kept out of issuer detection, and a value printed on the line below its
label is still found. See docs/DECISIONS.md for what was kept from the legacy behaviour and why.
"""

import re
from dataclasses import dataclass

from docai.doc_schema import DocSchema, Extractor, FieldSpec, FieldType
from docai.extract.result import AdditionalField, Extraction, FieldValue
from docai.extract.values import (
    CURRENCY_CODE_RE,
    MONEY_TOKEN,
    detect_currency,
    find_dates,
    is_formatted_money,
    money_str,
    parse_money,
    resolve_date,
)
from docai.ingest.model import ParsedDocument

UNKNOWN = "Unknown"
TITLE_LINES = 5
HEAD_LINES = 25
CELL_GAP = re.compile(r"\s{2,}")
# After a label: optional "No"/"Number" word ("Original Invoice No:"), then punctuation.
SEP = r"(?:\s*(?i:no|nr|number|num)\.?(?!\w))?[\s:.#=\-–]*"
IBAN = r"[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?(?![A-Z0-9])"
ID_TOKEN = (
    r"(" + IBAN + r"|(?:[A-Z]{2,3}\s)?(?=[A-Za-z0-9/_.-]*\d)[A-Za-z0-9][A-Za-z0-9/_.-]{2,}"
    r"(?:\s(?=[A-Z]*\d)[A-Z0-9]{2,})*)"
)

COMPANY_SUFFIX = re.compile(
    r"\b(?:pvt\.?\s*ltd|private\s+limited|pte\.?\s*ltd|pty\.?\s*ltd|sdn\.?\s*bhd|ltd|limited|llp|llc|l\.l\.c|"
    r"inc|incorporated|corp|corporation|co\.|company|gmbh|ag|s\.?a\.?s?|s\.?a\.?r\.?l|s\.?r\.?l|s\.?p\.?a|b\.?v|"
    r"n\.?v|plc|lp|oy|ab|a/s|as|k\.?k|fze|fzco|fz-llc|w\.?l\.?l|bank|enterprises?|traders?|trading|industries|"
    r"exports?|imports?|solutions|services|technologies|systems|group|holdings)\b\.?",
    re.IGNORECASE,
)
NON_COMPANY_LINE = re.compile(
    r"\b(?:invoice|receipt|purchase\s+order|quotation|credit\s+note|statement|bill(?:ed)?\s+to|ship\s+to|sold\s+to|"
    r"customer|date|gstin|vat|tax|total|amount|subtotal|tel|phone|fax|email|e-mail|www|http|page|account|iban|"
    r"swift|bic)\b",
    re.IGNORECASE,
)
ADDRESS_HINT = re.compile(
    r"\b(?:road|rd|street|st|str|straße|strasse|lane|ln|avenue|ave|boulevard|blvd|drive|dr|way|place|pl|court|"
    r"ct|square|sq|highway|hwy|suite|ste|floor|fl|unit|building|bldg|tower|plaza|p\.?\s?o\.?\s+box|po\s+box|"
    r"rue|via|calle|avenida|marg|nagar|sector|estate|plot|block|district|dist|city|state|province|zip|"
    r"postcode|pin|pincode|united\s+states|usa|united\s+kingdom|uk|germany|deutschland|india|france|spain|"
    r"italy|netherlands|singapore|uae|united\s+arab\s+emirates|australia|canada|japan|china|ireland)\b\.?",
    re.IGNORECASE,
)
POSTAL = re.compile(
    r"(?<![\w-])\d{5,6}(?![\d-])"  # IN/US/DE/FR style
    r"|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b"  # UK
    r"|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b"  # CA
    r"|\b[A-Z]{2}\s\d{5}(?:-\d{4})?\b"  # US state + ZIP
)
KEY_VALUE_ID_LINE = re.compile(r"^[A-Za-z][\w .#/-]*:\s*\S*\d")
ADDITIONAL_FIELD = re.compile(r"^([A-Za-z][\w .#/&()'-]{1,40}?)\s*[:：]\s*(\S.{0,120})$")


@dataclass
class TextLine:
    id: str
    text: str

    @property
    def cells(self) -> list[str]:
        return [c for c in CELL_GAP.split(self.text.strip()) if c]


@dataclass
class Match:
    value: object
    raw: str
    line_id: str
    confidence: float
    label: str = ""


def document_lines(parsed: ParsedDocument) -> list[TextLine]:
    lines = [TextLine(line.id, line.text) for page in parsed.pages for line in page.lines]
    for sheet in parsed.sheets:
        for r, row in enumerate(sheet.rows, start=1):
            cells = [str(v) for v in row if v is not None]
            if cells:
                lines.append(TextLine(f"{sheet.name}!{r}", "   ".join(cells)))
        for image in sheet.images:
            lines.extend(TextLine(line.id, line.text) for line in image.lines)
    return [line for line in lines if line.text.strip()]


def label_pattern(label: str) -> str:
    return r"(?<!\w)(?i:" + r"\s+".join(re.escape(part) for part in label.split()) + r")(?!\w)"


# ---------------------------------------------------------------------------------------------- classification


def classify(lines: list[TextLine], schema: DocSchema) -> tuple[str, float]:
    """Weighted keyword scoring, each keyword counted once per document (as in the legacy classifier).

    Overlapping matches keep only the longest phrase, so 'Proforma Invoice' doesn't also count as 'Invoice';
    a keyword found in the first lines (the document title) counts double.
    """
    matches = []
    for index, line in enumerate(lines):
        for doc_type in schema.documentTypes:
            for keyword in doc_type.keywords:
                for m in re.finditer(label_pattern(keyword), line.text):
                    matches.append((len(keyword), index, m.start(), m.end(), doc_type, keyword))

    taken: dict[int, list[tuple[int, int]]] = {}
    weights: dict[tuple[str, str], float] = {}
    for _, index, start, end, doc_type, keyword in sorted(matches, key=lambda m: -m[0]):
        spans = taken.setdefault(index, [])
        if any(start < e and s < end for s, e in spans):
            continue
        spans.append((start, end))
        weight = doc_type.keywordWeight * (2 if index < TITLE_LINES else 1)
        key = (doc_type.name, keyword.lower())
        weights[key] = max(weights.get(key, 0), weight)

    scores: dict[str, float] = {}
    for (name, _), weight in weights.items():
        scores[name] = scores.get(name, 0) + weight
    order = {t.name: i for i, t in enumerate(schema.documentTypes)}
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], order[kv[0]]))
    if not ranked:
        return UNKNOWN, 0.0
    best, best_score = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0
    return best, round(best_score / (best_score + second), 3)


# ---------------------------------------------------------------------------------------------- labelled values


def _labels_for(field: FieldSpec, document_type: str) -> list[str]:
    """Labels naming the document type come first: on a credit note, 'Credit Note No' beats 'Invoice No'
    (which would otherwise match inside 'Original Invoice No')."""
    type_words = set(document_type.lower().split())
    return sorted(field.labels, key=lambda label: -len(type_words & set(label.lower().split())))


def _after_labels(field: FieldSpec, document_type: str, lines: list[TextLine]):
    """Yield (label, line index, text after the label, first cell after the label, next line), label priority first."""
    for label in _labels_for(field, document_type):
        pattern = re.compile(label_pattern(label))
        for index, line in enumerate(lines):
            for m in pattern.finditer(line.text):
                after = line.text[m.end() :]
                tail = re.sub(r"^[:.#=\-–]*", "", after).strip()
                rest = CELL_GAP.split(tail, maxsplit=1)[0] if tail else ""
                following = lines[index + 1] if index + 1 < len(lines) else None
                yield label, index, after, rest, following


def extract_labeled_id(field: FieldSpec, document_type: str, lines: list[TextLine]) -> Match | None:
    for label, index, after, rest, following in _after_labels(field, document_type, lines):
        m = re.match(SEP + ID_TOKEN, after)
        line_id = lines[index].id
        if not m and not re.search(r"\d", rest) and following:
            m, line_id = re.match(r"\s*" + ID_TOKEN, following.text), following.id
        if m:
            value = m.group(1).rstrip(".-/")
            if len(value) >= 3 and re.search(r"\d", value):
                return Match(value, value, line_id, 0.8, label)
    return None


def _first_amount(text: str) -> str | None:
    """First amount after a label. Formatted money wins over bare integers; percentages and dates are skipped;
    at most one word may sit between label and number ('Total Due EUR 29.75' yes, 'Tax Invoice No: 123' no)."""
    date_spans = [(text.find(raw), text.find(raw) + len(raw)) for raw, *_ in find_dates(text)]
    candidates = []
    for token in MONEY_TOKEN.finditer(text):
        if re.match(r"\s*%", text[token.end() :]) or any(s <= token.start() < e for s, e in date_spans):
            continue
        between = CURRENCY_CODE_RE.sub(" ", text[: token.start()])
        words = re.findall(r"[A-Za-z]{2,}", between)
        if len(words) > 1:
            break
        candidates.append(token.group(0))
    formatted = [c for c in candidates if is_formatted_money(c)]
    return formatted[0] if formatted else candidates[0] if candidates else None


def extract_amount(field: FieldSpec, document_type: str, lines: list[TextLine]) -> Match | None:
    best: Match | None = None
    best_label = None
    for label, index, after, _, following in _after_labels(field, document_type, lines):
        if best_label is not None and label != best_label:
            break  # a higher-priority label already matched; within one label the last occurrence wins
        raw, line_id = _first_amount(after), lines[index].id
        if raw is None and following and re.match(r"\s*[^\w\s]?\s*\(?-?\d", following.text):
            raw, line_id = _first_amount(following.text), following.id
        value = parse_money(raw) if raw else None
        if value is not None:
            best, best_label = Match(money_str(value), raw, line_id, 0.8, label), label
    return best


def largest_amount(lines: list[TextLine]) -> Match | None:
    """Legacy fallback: the largest money-formatted number (never a bare integer, which is usually an ID)."""
    best = None
    for line in lines:
        for token in MONEY_TOKEN.finditer(line.text):
            raw = token.group(0)
            value = parse_money(raw) if is_formatted_money(raw) else None
            if value is not None and (best is None or value > best[0]):
                best = (value, raw, line.id)
    return Match(money_str(best[0]), best[1], best[2], 0.4) if best else None


def extract_date(field: FieldSpec, document_type: str, lines: list[TextLine], order: str | None) -> Match | None:
    for label, index, after, _, following in _after_labels(field, document_type, lines):
        candidates = [(d, lines[index].id) for d in find_dates(after)[:1]]
        if not candidates and following and not after.strip(" :.#=-–"):
            candidates = [(d, following.id) for d in find_dates(following.text)[:1]]
        for (raw, day, month, year, certainty), line_id in candidates:
            return Match(resolve_date(day, month, year, certainty, order), raw, line_id, 0.8, label)
    return None


def first_date(lines: list[TextLine], order: str | None) -> Match | None:
    for line in lines:
        for raw, day, month, year, certainty in find_dates(line.text):
            return Match(resolve_date(day, month, year, certainty, order), raw, line.id, 0.4)
    return None


# ---------------------------------------------------------------------------------------------- parties


def recipient_block(schema: DocSchema, lines: list[TextLine]) -> set[str]:
    """Line ids of the 'Bill To' style block: the label line and up to four lines under it."""
    labels = {
        label
        for f in schema.fields
        if f.extractor in (Extractor.LABELED_TEXT, Extractor.LABELED_ADDRESS)
        for label in f.labels
    }
    block: set[str] = set()
    for index, line in enumerate(lines):
        cells = line.cells
        position = next((i for i, c in enumerate(cells) if any(re.search(label_pattern(lb), c) for lb in labels)), None)
        # Only when the block starts in the left column; a right-column "Bill To" shares rows with the issuer.
        if position == 0:
            block.update(following.id for following in lines[index : index + 5])
    return block


def extract_labeled_text(field: FieldSpec, document_type: str, lines: list[TextLine]) -> Match | None:
    for label, index, _, rest, following in _after_labels(field, document_type, lines):
        value, line_id = rest.strip(" :-"), lines[index].id
        if not value and following:
            value, line_id = following.cells[_cell_index(lines[index], label, following)], following.id
        if value and not re.fullmatch(r"[\d\W]+", value) and not NON_COMPANY_LINE.search(value):
            return Match(value, value, line_id, 0.7, label)
    return None


def _cell_index(label_line: TextLine, label: str, other: TextLine) -> int:
    """Which column of `other` sits under the label ('Bill To' left, 'Ship To' right)."""
    cells = label_line.cells
    position = next((i for i, c in enumerate(cells) if re.search(label_pattern(label), c)), 0)
    return position if len(other.cells) == len(cells) and position < len(other.cells) else 0


def _address_score(text: str) -> int:
    score = 0
    if ADDRESS_HINT.search(text):
        score += 2
    if POSTAL.search(text):
        score += 2
    if "," in text:
        score += 1
    if NON_COMPANY_LINE.search(text):
        score -= 3
    if COMPANY_SUFFIX.search(text):
        score -= 3
    if KEY_VALUE_ID_LINE.search(text):
        score -= 4
    return score


def extract_labeled_address(field: FieldSpec, document_type: str, lines: list[TextLine]) -> Match | None:
    for label, index, _, rest, _ in _after_labels(field, document_type, lines):
        start = index + 1 if rest.strip(" :-") else index + 2  # skip the name line under the label
        parts, ids = [], []
        for line in lines[start : start + 4]:
            cell = line.cells[_cell_index(lines[index], label, line)]
            if KEY_VALUE_ID_LINE.search(cell) or NON_COMPANY_LINE.search(cell) or _address_score(cell) <= 0:
                break  # e.g. a table header below the block
            parts.append(cell)
            ids.append(line.id)
        if parts and any(_address_score(p) >= 2 for p in parts):
            value = ", ".join(parts)
            return Match(value, value, ids[0], 0.6, label)
    return None


def extract_company(lines: list[TextLine], exclude: set[str]) -> Match | None:
    head = [line for line in lines[:15] if line.id not in exclude]
    for line in head:
        for cell in line.cells:
            if COMPANY_SUFFIX.search(cell) and not NON_COMPANY_LINE.search(cell) and len(cell) <= 80:
                value = cell.strip(" ,;:")
                return Match(value, value, line.id, 0.7)
    for line in head:
        for cell in line.cells:
            digits = sum(c.isdigit() for c in cell) / max(len(cell), 1)
            if (
                not NON_COMPANY_LINE.search(cell)
                and 4 <= len(cell) <= 60
                and digits < 0.3
                and re.search(r"[A-Za-z]", cell)
            ):
                value = cell.strip(" ,;:")
                return Match(value, value, line.id, 0.4)
    return None


def extract_address(lines: list[TextLine], exclude: set[str]) -> Match | None:
    head = [line for line in lines[:HEAD_LINES] if line.id not in exclude]
    best = (0, -1, 0)
    for i in range(len(head)):
        total = 0
        for length in range(1, 5):
            if i + length > len(head):
                break
            total += _address_score(head[i + length - 1].cells[0])
            if total > best[0]:
                best = (total, i, length)
    score, start, length = best
    if start < 0 or score < 2:
        return None
    value = ", ".join(line.cells[0] for line in head[start : start + length])
    return Match(value, value, head[start].id, 0.5)


def extract_currency(lines: list[TextLine]) -> Match | None:
    found = detect_currency("\n".join(line.text for line in lines))
    if not found:
        return None
    code, raw = found
    line_id = next((line.id for line in lines if raw in line.text), None)
    return Match(code, raw, line_id, 0.7 if raw == code else 0.5)


# ---------------------------------------------------------------------------------------------- orchestration


def _additional_fields(
    lines: list[TextLine], schema: DocSchema, document_type: str, used_raw: set[str]
) -> list[AdditionalField]:
    # Labels of fields that don't apply to this type (an IBAN on an invoice) are still worth returning.
    known = [re.compile(label_pattern(label)) for f in schema.fields_for(document_type) for label in f.labels]
    extra = []
    for line in lines:
        for cell in line.cells:
            m = ADDITIONAL_FIELD.match(cell)
            if not m:
                continue
            label, value = m.group(1).strip(), m.group(2).strip()
            if any(p.fullmatch(label) for p in known) or value in used_raw:
                continue
            extra.append(AdditionalField(label=label, value=value, line_id=line.id))
    return extra[:50]


def extract_offline(parsed: ParsedDocument, schema: DocSchema) -> Extraction:
    lines = document_lines(parsed)
    document_type, type_confidence = classify(lines, schema)
    recipients = recipient_block(schema, lines)

    fields: dict[str, FieldValue] = {}
    labels_used: dict[str, str] = {}
    issues = []
    for spec in schema.fields_for(document_type):
        match: Match | None = None
        match spec.extractor:
            case Extractor.LABELED_ID:
                match = extract_labeled_id(spec, document_type, lines)
            case Extractor.AMOUNT:
                match = extract_amount(spec, document_type, lines)
                if match is None and spec.fallback == "largestAmount":
                    match = largest_amount(lines)
            case Extractor.DATE:
                match = extract_date(spec, document_type, lines, schema.dateOrder)
                if match is None and spec.fallback == "firstDate":
                    match = first_date(lines, schema.dateOrder)
            case Extractor.COMPANY:
                match = extract_company(lines, recipients)
            case Extractor.ADDRESS:
                match = extract_address(lines, recipients)
            case Extractor.LABELED_TEXT:
                match = extract_labeled_text(spec, document_type, lines)
            case Extractor.LABELED_ADDRESS:
                match = extract_labeled_address(spec, document_type, lines)
            case Extractor.CURRENCY:
                match = extract_currency(lines)

        if match is None:
            fields[spec.name] = FieldValue()
            continue
        if spec.type is FieldType.DATE and match.value is None:
            issues.append(
                f"{spec.name}: date {match.raw!r} is ambiguous (day/month order); set dateOrder in the schema"
            )
        fields[spec.name] = FieldValue(
            value=match.value, raw=match.raw, line_id=match.line_id, confidence=match.confidence
        )
        labels_used[spec.name] = match.label

    # Two ID fields reading the same value off the same line: keep it for the field whose label matched more text.
    id_fields = [n for n, fv in fields.items() if fv.value is not None and schema.field(n).type is FieldType.ID]
    for a in id_fields:
        for b in id_fields:
            fa, fb = fields[a], fields[b]
            if (
                a < b
                and fa.value is not None
                and fb.value is not None
                and fa.value == fb.value
                and fa.line_id == fb.line_id
            ):
                loser = a if len(labels_used.get(a, "")) < len(labels_used.get(b, "")) else b
                fields[loser] = FieldValue()

    used_raw = {fv.raw for fv in fields.values() if fv.raw}
    return Extraction(
        document_type=document_type,
        type_confidence=type_confidence,
        fields=fields,
        additional_fields=_additional_fields(lines, schema, document_type, used_raw),
        issues=issues,
        mode="offline",
    )
