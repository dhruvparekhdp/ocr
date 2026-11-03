"""Parsing printed values (money, dates, currencies) into the schema's canonical forms."""

import re
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Literal

# A money-looking number: optional sign/parentheses, digit groups with , . ' or thin spaces, optional decimals.
MONEY_TOKEN = re.compile(
    r"(?<![\w.,])\(?-?\d{1,3}(?:[,.'\u202f]\d{2,3})*(?:[.,]\d{1,2})?\)?(?![\w%])|(?<![\w.,])\(?-?\d+(?:[.,]\d{1,2})?\)?(?![\w%])"
)

CURRENCY_CODES = [
    "USD",
    "EUR",
    "GBP",
    "INR",
    "AUD",
    "CAD",
    "SGD",
    "AED",
    "SAR",
    "JPY",
    "CNY",
    "CHF",
    "HKD",
    "NZD",
    "ZAR",
    "MYR",
    "THB",
    "IDR",
    "PHP",
    "KRW",
    "SEK",
    "NOK",
    "DKK",
    "PLN",
    "CZK",
    "HUF",
    "TRY",
    "BRL",
    "MXN",
    "ARS",
    "CLP",
    "COP",
    "PEN",
    "NGN",
    "KES",
    "EGP",
    "QAR",
    "KWD",
    "BHD",
    "OMR",
    "PKR",
    "BDT",
    "LKR",
    "NPR",
    "VND",
    "ILS",
    "RUB",
    "UAH",
    "RON",
    "BGN",
]
CURRENCY_CODE_RE = re.compile(r"\b(" + "|".join(CURRENCY_CODES) + r")\b")
# Only unambiguous symbols. "$", "¥" and "kr" are shared by several currencies and are not guessed.
CURRENCY_SYMBOLS = {"€": "EUR", "£": "GBP", "₹": "INR", "₩": "KRW", "₦": "NGN", "₱": "PHP", "₺": "TRY", "₪": "ILS"}
RUPEE_RE = re.compile(r"\bRs\.?\s?\d", re.IGNORECASE)

MONTHS = {
    m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])
}
_MONTH = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
DATE_PATTERNS = [
    ("ymd", re.compile(r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b")),
    ("numeric", re.compile(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b")),
    ("d_mon_y", re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+" + _MONTH + r"[\s,-]+(\d{4}|\d{2})\b", re.IGNORECASE)),
    ("mon_d_y", re.compile(r"\b" + _MONTH + r"\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b", re.IGNORECASE)),
]


def parse_money(raw: str) -> Decimal | None:
    """'1,234.56', '1.234,56', '1,23,456.00', "1'234.50", '(12.00)' → Decimal. None if not a number."""
    text = raw.strip().replace("\u202f", "").replace("'", "")
    negative = text.startswith("(") and text.endswith(")") or text.startswith("-")
    text = text.strip("()-")
    if not text or not text[0].isdigit():
        return None
    if "," in text and "." in text:
        decimal_sep = "," if text.rfind(",") > text.rfind(".") else "."
    elif "," in text:
        # "1,234" / "1,23,456" are grouping; "12,50" is a decimal comma.
        decimal_sep = "," if re.fullmatch(r"\d+,\d{1,2}", text) else None
    elif "." in text:
        decimal_sep = None if re.fullmatch(r"\d{1,3}(\.\d{3}){2,}", text) else "."
    else:
        decimal_sep = None
    thousands = {",": ".", ".": ",", None: ",."}[decimal_sep]
    for sep in thousands:
        text = text.replace(sep, "")
    if decimal_sep == ",":
        text = text.replace(",", ".")
    try:
        value = Decimal(text)
    except InvalidOperation:
        return None
    return -value if negative else value


def is_formatted_money(raw: str) -> bool:
    """Legacy rule: a bare integer (IDs, postcodes, quantities) is never treated as an amount without a label."""
    return bool(re.search(r"\d[.,]\d{1,2}\)?$|\d[,.'\u202f]\d{3}", raw))


def money_str(value: Decimal) -> str:
    """Canonical amount string: at least two decimals ('2558.50'), more only if printed ('0.125')."""
    return format(value.quantize(Decimal("0.01")) if value.as_tuple().exponent >= -2 else value, "f")


def _year(text: str) -> int:
    y = int(text)
    return y if y >= 100 else 2000 + y if y < 70 else 1900 + y


def find_dates(text: str) -> list[tuple[str, int, int, int, Literal["exact", "ambiguous"]]]:
    """All date-looking substrings as (raw, a, b, year, certainty); for 'ambiguous', a/b are the two numeric parts."""
    found = []
    for kind, pattern in DATE_PATTERNS:
        for m in pattern.finditer(text):
            raw = m.group(0)
            if kind == "ymd":
                found.append((m.start(), raw, int(m[3]), int(m[2]), int(m[1]), "exact"))
            elif kind == "numeric":
                a, b, y = int(m[1]), int(m[2]), _year(m[3])
                if a > 12 and b <= 12:
                    found.append((m.start(), raw, a, b, y, "exact"))
                elif b > 12 and a <= 12:
                    found.append((m.start(), raw, b, a, y, "exact"))
                elif a <= 12 and b <= 12:
                    found.append((m.start(), raw, a, b, y, "ambiguous" if a != b else "exact"))
            elif kind == "d_mon_y":
                found.append((m.start(), raw, int(m[1]), MONTHS[m[2][:3].lower()], _year(m[3]), "exact"))
            else:
                found.append((m.start(), raw, int(m[2]), MONTHS[m[1][:3].lower()], _year(m[3]), "exact"))
    found.sort()
    return [(raw, d, mo, y, c) for _, raw, d, mo, y, c in found]


def resolve_date(day: int, month: int, year: int, certainty: str, order: str | None) -> str | None:
    """ISO date, or None when ambiguous (DD/MM vs MM/DD) and no dateOrder is configured, or invalid."""
    if certainty == "ambiguous":
        if order is None:
            return None
        if order == "MDY":
            day, month = month, day
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def detect_currency(text: str) -> tuple[str, str] | None:
    """(ISO code, raw match). ISO codes win over symbols; the most frequent code wins."""
    codes = CURRENCY_CODE_RE.findall(text)
    if codes:
        best = max(set(codes), key=codes.count)
        return best, best
    for symbol, code in CURRENCY_SYMBOLS.items():
        if symbol in text:
            return code, symbol
    if RUPEE_RE.search(text):
        return "INR", "Rs"
    return None
