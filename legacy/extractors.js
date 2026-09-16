/**
 * ============================================================================
 * From-scratch field extractors (no LLM, no ML model)
 * ============================================================================
 * Pure heuristic/regex logic that reads plain document text (from pdfIngest)
 * and pulls out the fields a financial/company document typically carries:
 * document type, a document/reference number, company name, address, date,
 * and total amount.
 *
 * Each field in config/schema.json names an `extractor` (labeledId / company
 * / address / date / amount); this module maps those names to functions.
 * Classification (which document type) is scored from the per-type keyword
 * lists in the schema. Everything here is deterministic and inspectable —
 * there is no model to train and nothing leaves the machine.
 *
 * These are heuristics, not magic: they do well on the common, cleanly-laid-
 * out cases and degrade on unusual layouts or noisy OCR. See the "Gaps and
 * limitations" section of the README for the honest boundary of what this
 * can and can't do.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Splits raw text into trimmed, non-empty lines. Line structure matters a lot
 * for heuristics (a company name is usually its own line near the top; an
 * address is a run of consecutive lines), so we keep lines rather than
 * collapsing everything to one blob.
 *
 * @param {string} text
 * @returns {string[]}
 */
const toLines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
    // Drop pdf-parse's page markers ("-- 1 of 2 --") so they don't get
    // mistaken for content by the top-of-document heuristics.
    .filter((l) => !/^-{2,}\s*\d+\s+of\s+\d+\s*-{2,}$/i.test(l));

/** Escapes a literal string for safe embedding in a RegExp. */
const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An ID value: alphanumerics plus / - _, at least one digit, min 3 chars. */
const ID_TOKEN = /((?=[A-Za-z0-9/_-]*\d)[A-Za-z0-9][A-Za-z0-9/_-]{2,})/;

// ---------------------------------------------------------------------------
// Labeled ID (invoice number, PO number, receipt number, transaction id, …)
// ---------------------------------------------------------------------------

/**
 * Finds an identifier that follows one of the field's configured labels.
 * Tries every label, tries every occurrence of each label, and returns the
 * first plausible value (a label's nearest neighbour in flattened text is
 * sometimes a stray column number, so we scan past too-short hits).
 *
 * @param {string} text  Collapsed single-line text.
 * @param {object} field The field config (uses field.labels).
 * @returns {string|null}
 */
const extractLabeledId = (text, field) => {
  const labels = field.labels || [];
  for (const label of labels) {
    const labelPattern = escapeRegExp(label).replace(/\\?\s+/g, '\\s+');
    // Separator is any run of spaces/punctuation, so "No: X", "No.: X",
    // "No - X", "No #X" all work (a single optional char misses "No.:").
    const re = new RegExp(`\\b${labelPattern}\\b[\\s:.#-]*` + ID_TOKEN.source, 'gi');
    for (const match of text.matchAll(re)) {
      const value = match[1]?.trim();
      // Guard: reject a capture that's just the tail of the label itself
      // (e.g. "No" in "PO No") or a lone short number that's likely a column
      // index rather than a real identifier.
      if (value && value.length >= 3 && /\d/.test(value)) {
        return value.toUpperCase();
      }
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Amount (grand total / total payable)
// ---------------------------------------------------------------------------

/** A currency symbol or 3-letter code optionally preceding an amount. */
const CURRENCY = /(?:(?:rs\.?|inr|usd|eur|gbp|aud|cad|₹|\$|€|£)\s*)?/i;

/**
 * A money-formatted number, anchored by word boundaries so it captures the
 * WHOLE run (not a leading fragment). Two accepted shapes:
 *   - comma-grouped: 1,234 / 1,234.56 / 1,23,456 (Indian grouping)
 *   - decimal:       1234.56 / 500.00
 * A bare integer with neither grouping nor decimals (e.g. "9911", "122001")
 * is deliberately NOT money-shaped — those are usually IDs, postal codes, or
 * quantities, and treating them as an amount is the classic false positive.
 */
const MONEY_FORMATTED = /(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2})/;
/** A looser money number (also allows a bare integer) — used ONLY next to an explicit total label. */
const MONEY_LABELED = /(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;

/**
 * Extracts the document's total amount. Preference order:
 *   1. A number on a line whose label is one of the field's configured
 *      "total"-type labels (Grand Total, Amount Due, …). Later matches win,
 *      because "Grand Total" / "Net Payable" typically appear below running
 *      subtotals and are the figure that actually matters. Next to an
 *      explicit label, even a bare integer ("Amount Paid: 1250") is accepted.
 *   2. Failing a labeled hit, the single largest *money-formatted* number
 *      (comma-grouped or decimal) in the document. Requiring money formatting
 *      here avoids inventing an amount for documents that have none (a PO's
 *      largest number is a PO/postal digit run, not a total).
 *
 * Returns the numeric string as printed (grouping/decimals preserved), minus
 * any currency symbol.
 *
 * @param {string[]} lines
 * @param {object} field
 * @returns {string|null}
 */
const extractAmount = (lines, field) => {
  const labels = field.labels || [];
  let labeledValue = null;

  for (const line of lines) {
    for (const label of labels) {
      const labelPattern = escapeRegExp(label).replace(/\\?\s+/g, '\\s+');
      const re = new RegExp(`\\b${labelPattern}\\b\\s*[:.]?\\s*` + CURRENCY.source + MONEY_LABELED.source + `\\b`, 'i');
      const m = line.match(re);
      if (m) labeledValue = m[1]; // keep the last (lowest-in-doc) labeled match
    }
  }
  if (labeledValue) return labeledValue;

  // Fallback: largest money-FORMATTED number anywhere (never a bare integer).
  let best = null;
  let bestNum = -1;
  const moneyGlobal = new RegExp(`\\b` + MONEY_FORMATTED.source + `\\b`, 'g');
  for (const line of lines) {
    for (const m of line.matchAll(moneyGlobal)) {
      const raw = m[1];
      const numeric = Number.parseFloat(raw.replace(/,/g, ''));
      if (Number.isFinite(numeric) && numeric > bestNum) {
        bestNum = numeric;
        best = raw;
      }
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

const MONTHS =
  '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const DATE_PATTERNS = [
  // 01/04/2025, 1-4-25, 2025.04.01
  /\b(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4})\b/,
  // 01 Apr 2025 / 1 April 2025
  new RegExp(`\\b(\\d{1,2}\\s+${MONTHS}\\.?\\s+\\d{2,4})\\b`, 'i'),
  // Apr 01, 2025 / April 1 2025
  new RegExp(`\\b(${MONTHS}\\.?\\s+\\d{1,2},?\\s+\\d{2,4})\\b`, 'i'),
];

/**
 * Extracts a date. Prefers a date near one of the field's configured labels
 * (Invoice Date, Order Date, …); otherwise returns the first date-looking
 * string anywhere. Returned verbatim as printed — normalization to a single
 * format is intentionally NOT done (see README gaps: date formats are
 * locale-ambiguous and normalizing risks corrupting the value).
 *
 * @param {string[]} lines
 * @param {object} field
 * @returns {string|null}
 */
const extractDate = (lines, field) => {
  const labels = field.labels || [];
  const joined = lines.join('\n');

  // Labeled first: look on the same line as a date label.
  for (const line of lines) {
    const hasLabel = labels.some((label) => new RegExp(`\\b${escapeRegExp(label).replace(/\\?\s+/g, '\\s+')}\\b`, 'i').test(line));
    if (!hasLabel) continue;
    for (const pattern of DATE_PATTERNS) {
      const m = line.match(pattern);
      if (m) return m[1];
    }
  }

  // Fallback: first date anywhere in the document.
  for (const pattern of DATE_PATTERNS) {
    const m = joined.match(pattern);
    if (m) return m[1];
  }
  return null;
};

// ---------------------------------------------------------------------------
// Company name
// ---------------------------------------------------------------------------

/** Corporate suffixes that strongly signal "this line is a company name". */
const COMPANY_SUFFIX =
  /\b(?:pvt\.?\s*ltd\.?|private\s+limited|ltd\.?|limited|llp|llc|inc\.?|incorporated|corp\.?|corporation|co\.?|company|gmbh|s\.?a\.?|b\.?v\.?|plc|enterprises?|traders?|industries|exports?|imports?|solutions|services|technologies|systems)\b/i;

/** Lines that look like a label/field rather than a name — never a company. */
const NON_COMPANY_LINE =
  /\b(?:invoice|receipt|purchase\s+order|statement|bill\s+to|ship\s+to|date|gstin|tax|total|amount|tel|phone|email|www|http|page)\b/i;

/**
 * Extracts the issuing company name. Strategy:
 *   1. Prefer the earliest line (documents put the issuer at the top) that
 *      contains a corporate suffix (Pvt Ltd, LLC, Inc, …) and doesn't look
 *      like a label line — this is the strongest, most reliable signal.
 *   2. Failing that, fall back to the first "title-ish" line near the top:
 *      not a label, not mostly digits, of reasonable length.
 *
 * @param {string[]} lines
 * @returns {string|null}
 */
const extractCompany = (lines) => {
  const head = lines.slice(0, 15); // company name is a top-of-document feature

  for (const line of head) {
    if (COMPANY_SUFFIX.test(line) && !NON_COMPANY_LINE.test(line)) {
      return cleanCompany(line);
    }
  }

  for (const line of head) {
    if (NON_COMPANY_LINE.test(line)) continue;
    const digitRatio = (line.replace(/[^0-9]/g, '').length) / line.length;
    const looksTitle = line.length >= 4 && line.length <= 60 && digitRatio < 0.3 && /[A-Za-z]/.test(line);
    if (looksTitle) return cleanCompany(line);
  }
  return null;
};

/** Trims trailing punctuation and any address tail after a comma-number run. */
const cleanCompany = (line) => line.replace(/[,;:]\s*$/, '').trim();

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

/** Tokens that commonly appear in postal addresses. */
const ADDRESS_HINT =
  /\b(?:road|rd\.?|street|st\.?|lane|ln\.?|avenue|ave\.?|nagar|marg|estate|survey|plot|block|sector|floor|building|near|opp\.?|po\s+box|p\.?o\.?|district|dist\.?|state|pin|pincode|zip|postal)\b/i;
/**
 * A standalone 5-6 digit postal code (Indian PIN / US ZIP). The lookbehind/
 * lookahead ensure it isn't part of a longer alphanumeric token — otherwise
 * the "88213" inside an identifier like "TXN-88213" reads as a postal code
 * and drags a labeled ID line into the address block.
 */
const POSTAL = /(?<![\w-])\d{5,6}(?![\d-])/;
/** A "Label: value-with-a-digit" line (e.g. "Transaction ID: TXN-88213") — a field, never an address. */
const KEY_VALUE_ID_LINE = /^[A-Za-z][\w .#/-]*:\s*\S*\d/;

/**
 * Extracts an address block: finds the run of consecutive lines (within the
 * top portion of the document, where issuer/billing addresses live) richest
 * in address hints, and returns them joined by ", ". Heuristic and best-
 * effort — real addresses span a variable number of lines and no single
 * regex captures them, so we score a small sliding window instead.
 *
 * @param {string[]} lines
 * @returns {string|null}
 */
const extractAddress = (lines) => {
  const head = lines.slice(0, 25);
  const scoreLine = (line) => {
    let s = 0;
    if (ADDRESS_HINT.test(line)) s += 2;
    if (POSTAL.test(line)) s += 2;
    if (/,/.test(line)) s += 1;
    if (NON_COMPANY_LINE.test(line)) s -= 3; // "Invoice", "Total", etc. aren't address
    if (COMPANY_SUFFIX.test(line)) s -= 3; // the company-name line is not part of the address block
    if (KEY_VALUE_ID_LINE.test(line)) s -= 4; // a "Label: ID" field line is never an address
    return s;
  };

  // Find the best-scoring window of up to 4 consecutive lines.
  let bestStart = -1;
  let bestScore = 0;
  let bestLen = 0;
  for (let i = 0; i < head.length; i++) {
    let windowScore = 0;
    for (let len = 1; len <= 4 && i + len <= head.length; len++) {
      windowScore += scoreLine(head[i + len - 1]);
      if (windowScore > bestScore) {
        bestScore = windowScore;
        bestStart = i;
        bestLen = len;
      }
    }
  }

  if (bestStart === -1 || bestScore < 2) return null;
  return head.slice(bestStart, bestStart + bestLen).join(', ');
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Runs the extractor named by a field config against the document text.
 *
 * @param {object} field  A field config from schema.json (has .extractor).
 * @param {{ text: string, lines: string[] }} doc Pre-split document text.
 * @returns {string|null}
 */
export const runExtractor = (field, doc) => {
  switch (field.extractor) {
    case 'labeledId':
      return extractLabeledId(doc.text, field);
    case 'amount':
      return extractAmount(doc.lines, field);
    case 'date':
      return extractDate(doc.lines, field);
    case 'company':
      return extractCompany(doc.lines);
    case 'address':
      return extractAddress(doc.lines);
    default:
      return null;
  }
};

/** Exposed for index.js so it splits text the same way extractors expect. */
export const splitLines = toLines;
