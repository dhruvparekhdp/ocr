# Document Classifier — self-contained, no cloud, no LLM

A Node.js tool that reads PDFs (text-based **or** scanned/image), works out
what each document is, pulls out its key fields, and groups related documents
into batches. Everything runs locally on the machine — there is **no cloud
call, no API key, and no machine-learning model of any kind**. Document text
comes from the PDF's own text layer, or, for scanned documents, from **offline
OCR**; the "understanding" is done by deterministic, inspectable from-scratch
heuristics.

This is deliberately a "basic fields" tool. It is built to answer, for a pile
of financial/company documents: *which kind of document is this, who issued
it, what's the address, the date, the amount, and the document/reference
number* — and to be honest about where those heuristics stop working (see
[Gaps and limitations](#gaps-and-limitations)).

For implementation detail beyond this README, see `docs/ARCHITECTURE.md`
(how the system fits together), `docs/DECISIONS.md` (why it's built this
way, including approaches tried and rejected), and `docs/HISTORY.md` (how it
got here — this project went through several full pivots).

## Pipeline

```
                    ┌──────────────── per PDF ────────────────┐
   PDF file ─▶ pdfIngest ─▶ (embedded text?) ── yes ─▶ text ──┐
                    │                                          │
                    └─ no (scanned) ─▶ rasterize ─▶ OCR ─▶ text┤
                                                               ▼
                                              analyze  (classify + extract)
                                                               │
                                                               ▼
                                              segregateIntoBatches (union-find)
                                                               │
                                                               ▼
                                                        batches.json / web UI
```

1. **Ingest** (`pdfIngest.js`) — try the PDF's embedded text via `pdf-parse`.
   If that comes back empty/sparse (a scanned document), rasterize each page
   and run **offline OCR** (`ocr.js`, tesseract.js). Each document records
   whether its text came from `text` or `ocr`.
2. **Analyze** (`analyze.js` + `extractors.js`) — classify the document
   against the types in `config/schema.json` (keyword scoring) and extract the
   fields configured for that type with from-scratch heuristics.
3. **Batch** (`index.js`) — group documents that share a value in any
   batch-key field (union-find).

## Offline OCR — nothing leaves the machine

Scanned PDFs are handled by tesseract.js, wired entirely to **local files**:
the WASM engine ships in `tesseract.js-core`, and the English language data is
vendored via the `@tesseract.js-data/eng` npm package. There is **no CDN
download and no network access at OCR time** — which matters for a corporate
tool handling financial documents. It works air-gapped.

Rasterization uses `pdf-parse`'s own `getScreenshot`, not a second PDF
library, on purpose: running two independent bundled builds of pdfjs in one
process corrupts pdfjs global state and the second one throws. Using
`pdf-parse` for both text and image rendering avoids that (and keeps the
dependency list small).

Before OCR, every page image goes through `imagePreprocess.js`:

1. **Upscale** if the render is small (below ~1500px wide). Character height
   in pixels is the single biggest lever on tesseract's accuracy; tested
   against genuinely tiny text (a 7px font), this alone took OCR from
   returning nothing to reading nearly everything correctly.
2. **Grayscale.**
3. **Denoise with a 3x3 median filter, then binarize with Otsu's method.**
   Otsu picks the black/white cutoff per-image by maximizing between-class
   variance, so it adapts to each page's own contrast instead of using a
   fixed threshold. The median filter runs first because thresholding alone
   is not robust to speckle noise — tested against a deliberately noisy
   image, Otsu on its own turned salt-and-pepper speckle into confident but
   wrong garbage text, worse than tesseract's own honest empty result on the
   same unprocessed image. Median-then-Otsu is the standard pairing for
   exactly that reason.

This is a real, tested improvement for genuinely low-resolution or low-detail
scans. It is not a fix for every kind of bad scan — see "OCR is only as good
as the scan" below.

## What it extracts

Fields are defined in `config/schema.json`; the defaults are:

| Field | How it's found (heuristic) |
| --- | --- |
| `documentType` | Keyword scoring per type — the type whose configured keywords score highest wins (Invoice / Purchase Order / Transaction Record / Receipt / Unknown). |
| `documentNumber` | An alphanumeric ID following a configured label (Invoice No, Receipt No, Transaction ID, …). |
| `referenceNumber` | A PO / reference number following a configured label (PO No, Order No, …). Used with `documentNumber` to batch related documents. |
| `companyName` | The top-of-document line carrying a corporate suffix (Pvt Ltd, LLC, Inc, GmbH, …); failing that, the first prominent non-label line. |
| `address` | The consecutive run of top-of-document lines richest in address cues (road/street/sector names, a 5–6 digit postal code, commas). |
| `date` | A date near a date label (Invoice Date, Order Date, …), else the first date-shaped string. Returned **as printed** — not normalized. |
| `amount` | A money-formatted number next to a total label (Grand Total, Amount Due, …); failing that, the largest *money-formatted* (comma-grouped or decimal) number in the document. A bare integer is never treated as an amount, so documents with no total (e.g. a PO) correctly get `null`. |

## White-label configuration

Document types, fields, and branding all live in **`config/schema.json`**
(override the path with `SCHEMA_PATH`). Each field names an `extractor`
(`labeledId` / `company` / `address` / `date` / `amount`) that maps to a
function in `extractors.js`, and each document type carries the `keywords`
used to classify it. To adapt the tool to a different client's document mix,
edit this one file — no code changes for adding a type, a field label, or
rebranding the web UI. (Adding a genuinely *new kind* of field — say, a
tax-ID extractor with its own logic — does mean adding a small function to
`extractors.js` and referencing it by `extractor` name.)

## Usage

```bash
npm install

# Classify a folder of PDFs (defaults: ./pdfs → ./batches.json)
node index.js [pdfDirectory] [outputFile]

# e.g.
node index.js ./my_documents ./report.json

# Different client's schema/branding
SCHEMA_PATH=./config/acme.schema.json node index.js ./my_documents ./report.json
```

Text PDFs process in milliseconds; scanned PDFs take a second or two per page
for OCR. The report's `summary.ocrUsed` counts how many documents needed OCR.

### Web upload UI

```bash
npm run web        # http://localhost:3000  (PORT=xxxx to change)
```

Drag-and-drop up to 200 PDFs. Nothing is written to disk — files are processed
in memory for that request. The page renders each document's type, extracted
fields, and an **OCR** tag on any document whose text came from OCR. Branding
and the field/type list come from `GET /api/config`, so the UI reflects
whatever schema is active.

### Smoke test

```bash
npm test   # generates sample PDFs (including one scanned/OCR PDF) and runs the pipeline
```

## Output shape

```jsonc
{
  "summary": { "totalPdfs": 7, "analyzed": 7, "ocrUsed": 1, "failed": 0, "batches": 1, "unbatchedGroups": 5 },
  "batches": {
    "BATCH-INV-2024-001": {
      "documentNumber": "INV-2024-001",
      "referenceNumber": "PO-7788",
      "fileCount": 2,
      "documents": [
        { "fileName": "invoice_001.pdf", "documentType": "Invoice", "source": "text" },
        { "fileName": "po_7788.pdf", "documentType": "Purchase Order", "source": "text" }
      ]
    }
  },
  "unbatched": {
    "documentNumber:RCPT-7788": [
      { "fileName": "receipt_scanned.pdf", "documentType": "Receipt", "source": "ocr",
        "fields": { "documentNumber": "RCPT-7788", "companyName": "Sunrise Stores Pvt Ltd", "amount": "1,499.00", "...": "..." } }
    ]
  },
  "errors": []
}
```

## Files

| File | Responsibility |
| --- | --- |
| `config/schema.json` | Document types, fields (+ their `extractor`), batch keys, branding. The only file to edit for a new client. |
| `schema.js` | Loads/validates the schema; exports getters used everywhere else. |
| `pdfIngest.js` | PDF → text, with the offline-OCR fallback for scanned PDFs. Reports `text` vs `ocr`. |
| `ocr.js` | Offline tesseract.js worker (local engine + language data); serialized so concurrent calls queue safely. |
| `imagePreprocess.js` | Pre-OCR image cleanup: conditional upscale, grayscale, median denoise, Otsu binarization. |
| `extractors.js` | The from-scratch field heuristics — one function per `extractor` type. |
| `analyze.js` | Classify + extract: text → `{ documentType, fields }`. |
| `index.js` | Orchestration: folder/buffer processing with bounded concurrency, union-find batching, CLI entry point. |
| `server.js` | Express server: web UI, `GET /api/config`, `POST /api/classify` (in-memory). |
| `public/index.html` | Bulk-upload UI — dynamic fields/branding, OCR tags. |
| `scripts/generate-samples.js` | Dev-only sample generator (text PDFs + one scanned/OCR PDF). |

## Gaps and limitations

These are heuristics over messy real-world documents, not a solved problem.
Being upfront about where this breaks is more useful than pretending it
doesn't. In rough priority order:

**Extraction accuracy is layout-dependent.**
- **Company name / address are the weakest fields.** They rely on
  "top-of-document, looks like a name / looks like an address" heuristics.
  They do well on the common header layout (issuer at top) and poorly when the
  issuer is in a footer, a logo image with no text, or interleaved with the
  recipient's details ("Bill To" vs "From" is not reliably distinguished). The
  address block is a best-effort run of lines, not a parsed
  street/city/state/postcode.
- **Amount** picks the largest money-formatted number when there's no clear
  total label. That's right for most invoices but can be wrong on documents
  with several large figures (e.g. a statement with running balances), and it
  deliberately ignores un-formatted integers, so a total written as `5000`
  with no label and no decimals/commas is missed.
- **Date is returned as printed and never normalized.** `01/04/2025` is left
  as-is because DD/MM vs MM/DD is genuinely ambiguous without knowing the
  document's locale — normalizing risks silently corrupting the value. If you
  need canonical dates, that's a deliberate follow-up (with a configured
  locale), not something to guess.

**Classification is keyword scoring, not understanding.**
- A document with unusual wording, or one type's keywords appearing on
  another type, can be misclassified. There's no semantic model — if "Invoice"
  vocabulary shows up on a delivery note, it may score as an Invoice. Tuning is
  done by editing keywords/weights in the schema, and a very different document
  domain will need that tuning.

**OCR is only as good as the scan.**
- `imagePreprocess.js` (upscale + median denoise + Otsu binarization, see
  above) measurably helps low-resolution and low-detail scans. It does
  **not** fix everything: it has no answer for **skew** (rotated pages —
  tesseract degrades badly past a few degrees of rotation, and a naive
  skew-angle estimate can make it worse by rotating text further off-axis,
  so this was deliberately left out rather than shipped half-verified), and
  on very heavy, non-scan-like noise it did not clearly help in testing —
  synthetic per-pixel static isn't a faithful model of real scan
  degradation, and a 3x3 median filter tuned against one adversarial test
  case is not a substitute for a properly evaluated denoising pipeline.
  Handwritten documents are out of scope regardless of preprocessing —
  tesseract's model here is trained for printed text.
- **English only.** Only the English language data is vendored. Other
  languages (or multilingual documents) need the matching
  `@tesseract.js-data/<lang>` package and a small change to `ocr.js`.
- **No layout/table awareness.** OCR returns a flat stream of text; line-item
  tables, multi-column layouts, and key–value grids are flattened, which is
  exactly where label→value proximity heuristics get weakest.

**Pipeline scope.**
- **Text-based and scanned PDFs only.** Not other formats (images on their
  own, DOCX, email) — though the OCR path would extend to standalone images
  with little work.
- **Mixed PDFs** (some pages real text, some scanned) take the text path off
  the first pages and may skip OCR on the image pages — the text/scanned
  decision is currently whole-document, not per-page.
- **No confidence scores.** Every field is returned as a value or `null`, with
  no indication of how sure the heuristic is. For a review workflow, per-field
  confidence (and surfacing low-confidence values for a human to check) would
  be a valuable addition.
- **No de-duplication or multi-currency parsing.** Amounts keep their printed
  formatting; currency is not separated out into its own field.

**If you later get labeled data**, the natural upgrade for the fields that
heuristics handle worst (company/address, and classification on unusual
layouts) is a small local model trained on your documents. That was
intentionally removed here to meet the "no models, from-scratch logic only"
goal — but the ingestion, schema, and batching layers are all model-agnostic,
so it could be reintroduced behind the same interface without disturbing them.
