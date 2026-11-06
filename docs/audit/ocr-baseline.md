# OCR baseline audit (AUD-4)

Read-only baseline of this repository as of `main` commit `f8b893d` (branch `jarvis/AUD-4`). Audited 6 Nov 2026, 5:57 PM IST, by reading the pipeline and running `npm test`. No application code was changed.

The ticket calls this repo `ocr`. The package on disk is `document-classifier` (`package.json` name and version `2.0.0`). There is no separate OCR service, Python package, or `ocr/` directory. OCR is one stage inside a Node.js PDF classifier. This audit follows that layout.

There is no `docs/audit/` history before this file. Project context used for the audit: `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/HISTORY.md`, `config/schema.json`, and the modules named below.

## What the pipeline does

```
PDF bytes
  → pdfIngest.js          embedded text, or rasterize + preprocess + OCR
  → analyze.js            keyword classification
  → extractors.js         schema-selected field heuristics
  → index.js              union-find batching on shared batch-key values
  → batches.json or POST /api/classify
```

Everything is local. Classification and extraction are deterministic heuristics. The only recognizer is offline Tesseract (English LSTM). There is no cloud OCR, no LLM, and no layout model. `docs/DECISIONS.md` records Docling as considered and not adopted.

## Input types

Accepted today:

| Surface | What it accepts | Limits |
| --- | --- | --- |
| CLI `node index.js [dir] [out]` | Files in a directory whose extension is `.pdf` (case-insensitive). Non-PDFs are ignored. | No file-count or byte cap beyond process memory. Default directory `./pdfs`, default output `./batches.json`. |
| `POST /api/classify` | Multipart field `documents`. A file is kept when `mimetype` is `application/pdf` or the name ends in `.pdf`. | 200 files, 25 MB each (`server.js`). In memory only; nothing is written to disk. |
| Library | `extractTextFromBuffer` / `processBuffers` take PDF bytes. `extractTextFromPdfFile` / `processDirectory` read PDF paths. | Same PDF-only ingestion. |

Two PDF kinds are distinguished inside `pdfIngest.js`, for the whole file, not per page:

1. **Text PDF.** `pdf-parse` `getText()` returns at least 25 alphanumeric characters (`MIN_TEXT_CHARS`). Those characters are the document text. `source` is `"text"`. No rasterization, no preprocessing, no OCR.
2. **Scanned / image PDF.** Embedded text is sparser than that floor. Each page is rasterized with `getScreenshot({ scale: 2 })` and OCR'd. If OCR yields at least one alphanumeric character, `source` is `"ocr"`.

Not accepted by any entry point: standalone images (PNG, JPEG, TIFF), DOCX, email, HTML, or camera frames. `ocr.js` `ocrImage()` can recognize a PNG/JPEG buffer, and `imagePreprocess.js` can clean a PNG buffer, but the only caller is the scanned-PDF path after rasterization. The README states the same limit.

Mixed PDFs (a text layer on some pages, scans on others) take the text path for the whole file and skip OCR. The decision is one count of alphanumeric characters, not a per-page check.

If the OCR path runs and still produces no alphanumeric characters, the function returns the sparse embedded text with `source: "text"`. A failed scan is therefore not labeled `ocr`. Callers cannot tell "text layer was enough" from "OCR was attempted and failed."

## Preprocessing

Preprocessing runs only on the OCR path, after rasterization, in `imagePreprocess.js` `preprocessForOcr`. Embedded-text PDFs are not touched.

Order, for every page image:

1. **Rasterize** at scale 2 (`OCR_RENDER_SCALE` in `pdfIngest.js`) via the same `pdf-parse` instance that read the text. A second PDF library is intentionally not used (`docs/DECISIONS.md`).
2. **Upscale 2×** when the rendered width is under 1500 px (`UPSCALE_WIDTH_THRESHOLD`, `UPSCALE_FACTOR`). Wider renders stay at 1×. Scaling is a canvas `drawImage` while the image is still continuous-tone.
3. **Grayscale** with Rec. 601 weights (`0.299 R + 0.587 G + 0.114 B`).
4. **3×3 median filter** on interior pixels. Edge pixels are copied unchanged.
5. **Otsu binarization** from that page's own histogram. Pixels above the threshold become white (255); the rest become black (0). Alpha is left as-is.
6. The result is re-encoded as PNG and passed to Tesseract.

Not done: deskew, orientation detection, contrast stretch beyond Otsu, morphological open/close, border removal, DPI metadata, language detection, or any learned enhancement. `docs/DECISIONS.md` explains why deskew was left out (a wrong angle makes recognition worse, and it was not verified). Handwriting is out of scope; the vendored model is for printed English.

`@napi-rs/canvas` supplies the pixel operations. No extra dependency was added for preprocessing.

## OCR engines

One engine: **tesseract.js 7** (`ocr.js`), OEM `1` (LSTM only), language `eng`.

Local files only:

- WASM core from `tesseract.js-core`.
- English traineddata from `@tesseract.js-data/eng`, subdirectory `4.0.0` (the path is hardcoded in `resolveLangPath`).
- Worker script from `tesseract.js`'s Node worker. `gzip: true`, `cacheMethod: 'none'`.

A single worker is created on first use and reused. `recognize()` calls are serialized on a promise chain so concurrent PDFs cannot share the worker unsafely. `processDirectory` / `processBuffers` still parse up to 4 PDFs at a time (`CONCURRENCY_LIMIT`); only the recognize step is queued. `terminateOcr()` shuts the worker down. The CLI calls it when OCR ran. The web server calls it on `SIGINT` / `SIGTERM`.

`worker.recognize(imageBuffer)` is called with no rectangle, no PSM override, and no `output` option. The code keeps `data.text` and drops the rest of the result.

Not present: EasyOCR, PaddleOCR, RapidOCR, Docling, Google Vision, AWS Textract, Azure Document Intelligence, or a second Tesseract language. Adding a language means installing `@tesseract.js-data/<lang>` and changing the language code in `createWorker` (`docs/ARCHITECTURE.md`).

## Document classification

`analyze.js` `classify()` scores `config/schema.json` document types. `"Unknown"` is not scored (weight 0, empty keywords); it is the result when every other score stays 0.

For each other type, every keyword that matches as a case-insensitive whole phrase (`\b`, whitespace flexible) adds that type's `keywordWeight`. The highest score wins. Ties keep the earlier type in the schema, because a later type replaces the leader only when `score > bestScore`.

| Type | Weight per hit | Keywords |
| --- | --- | --- |
| Invoice | 5 | Tax Invoice, Commercial Invoice, Invoice To, Bill To, Total Due, Amount Due, Invoice No, GSTIN |
| Purchase Order | 5 | Purchase Order, PO No, P.O., Order Date, Proforma Invoice, Vendor |
| Transaction Record | 5 | Transaction ID, Transaction Date, Statement, Account Number, Debit, Credit, Payment Reference, Balance |
| Receipt | 4 | Receipt No, Receipt Number, Paid, Payment Received, Amount Paid, Cash Receipt |
| Unknown | 0 | none |

The numeric score and the other candidates are discarded. The public result is only the winning type string. Keyword overlap can mis-label a document; there is no semantic model. Tuning is an edit to `config/schema.json` (or `SCHEMA_PATH`). `schema.js` memoizes the file for the process lifetime.

## Field extraction

After classification, `analyze.js` runs `extractors.js` only for fields whose `appliesTo` includes the winning type. Every other field is `null`. `"Unknown"` matches nothing, so every field is `null`.

Values are strings as printed, or `null`. They are not objects. There is no line-item, tax, GSTIN, currency, IBAN, or account-number field. GSTIN is only a classification keyword. `pdf-parse` can detect vector tables (`getTable`); this pipeline never calls it. OCR text is a flat string, so columns and key/value grids are already collapsed before the heuristics run.

| Field | Extractor | Invoice | Purchase Order | Transaction Record | Receipt |
| --- | --- | --- | --- | --- | --- |
| `documentNumber` | `labeledId` | yes | no | yes | yes |
| `referenceNumber` | `labeledId` | yes | yes | no | no |
| `companyName` | `company` | yes | yes | yes | yes |
| `address` | `address` | yes | yes | yes | yes |
| `date` | `date` | yes | yes | yes | yes |
| `amount` | `amount` | yes | no | yes | yes |

`documentNumber` and `referenceNumber` are the batch keys (`isBatchKey: true`).

### `labeledId` (document and reference numbers)

Searches the whitespace-collapsed text for a configured label, then a separator of spaces or `:.#-`, then an ID token. The token must contain a digit, start alphanumerically, and be at least 3 characters (`A-Za-z0-9/_-`). The first label that hits wins, in schema label order. The value is uppercased.

Invoice / receipt / transaction labels for `documentNumber`: Invoice No, Invoice Number, Inv No, Inv #, Receipt No, Receipt Number, Transaction ID, Transaction No, Bill No, Reference No, Ref No.

Invoice / PO labels for `referenceNumber`: PO No, P.O. Number, PO Ref, Purchase Order No, Purchase Order Number, Order No.

A purchase order's own PO number is stored in `referenceNumber`, not `documentNumber`. A receipt or transaction record never gets `referenceNumber`, even if the page prints a PO.

### `company`

Looks at the first 15 non-empty lines. Prefers the earliest line with a corporate suffix (Pvt Ltd, Private Limited, Ltd, Limited, LLP, LLC, Inc, Corp, GmbH, SA, BV, PLC, Enterprise(s), Trader(s), Industries, Export(s), Import(s), Solutions, Services, Technologies, Systems, Co, Company) that does not look like a label line. Otherwise the first short title-like line (4–60 chars, less than 30% digits, contains a letter). Trailing comma, semicolon, or colon is stripped. Issuer versus "Bill To" is not distinguished. A logo with no text is invisible.

### `address`

Scores a window of up to 4 consecutive lines inside the first 25 lines. Address words (road, street, nagar, sector, pin, …), a standalone 5–6 digit postal code, and commas raise the score. Label lines, company-suffix lines, and `Label: <id-with-a-digit>` lines lower it. The best window is joined with `", "`. Below a score of 2 the field is `null`. The string is not split into street, city, state, or postcode.

### `date`

Prefers a date on the same line as Invoice Date, Transaction Date, Order Date, Receipt Date, or Date. Otherwise the first date-shaped token in the document. Recognized shapes: `D/M/Y` with `/`, `.`, or `-`; `01 Apr 2025`; `Apr 01, 2025`. The printed string is returned unchanged. Day/month order is not resolved. There is no ISO date.

### `amount`

Prefers the last line whose label is Grand Total, Total Due, Amount Due, Amount Paid, Total Amount, Net Payable, or Total, then a number. Next to a label, a bare integer is allowed. Optional currency (`Rs`, `INR`, `USD`, `EUR`, `GBP`, `AUD`, `CAD`, `₹`, `$`, `€`, `£`) is skipped and not returned as its own field. If no label hits, the largest comma-grouped or decimal number in the document is used. A bare integer is not money in that fallback, so a purchase order with only an ID and a PIN does not invent a total. A total written as `5000` with no label and no decimal or comma is missed. Several large figures (statement balances) can pick the wrong one. Purchase orders do not run this extractor at all.

### Batching (not a field, but it changes the payload)

`segregateIntoBatches` in `index.js` unions documents that share any non-null batch-key value. Groups of one go to `unbatched` with full `fields`. Groups of two or more go to `batches` as `BATCH-<first key value>`, and each member keeps only `fileName`, `documentType`, and `source`. Fields for batched documents are not in the report. Conflicting values for the same key log a warning and keep the first.

## Confidence scores

**No confidence score is returned today.** README "Gaps and limitations" says this, and the code matches it.

| Layer | Score that exists internally | In the JSON / UI |
| --- | --- | --- |
| Field heuristics | None. Each extractor returns a string or `null`. | Value or `null` only. |
| Classification | Integer sum of keyword weights. | Discarded. Only the type name is kept. |
| Tesseract page | `RecognizeResult.data.confidence` (0–100 on the tesseract.js `Page` type). | Discarded in `ocr.js`. Only `data.text` is kept. |
| Tesseract word / line / block / symbol | Each has `confidence`. Words also have `choices[].confidence`. | Discarded. `recognize()` is not asked for TSV or hOCR either. |

`source: "text" | "ocr"` is the only quality hint, and it is not a score. As noted above, a failed OCR call is reported as `"text"`.

## Page and region positions

**No page index and no region box are returned today** on the document, on any field, or in the web UI.

What the libraries already compute, and this code drops:

| Source | Position data available | What the pipeline keeps |
| --- | --- | --- |
| `pdf-parse` `getText()` | `pages[]` with `num` and per-page `text`. The public type has no character boxes. | The concatenated `text` string. Page objects are ignored. `pdf-parse` page banners (`-- 1 of 2 --`) can appear in that string; `extractors.js` deletes those lines before extraction and does not record the page. |
| `pdf-parse` `getScreenshot()` | `pageNumber`, `width`, `height`, `scale`, PNG bytes. | PNG bytes only. Page number and pixel size are not attached to the OCR text. Pages are joined with `\n\n`. |
| tesseract.js `Page` | `bbox` (`x0,y0,x1,y1`) on blocks, paragraphs, lines, words, and symbols, in the image that was recognized. | Not read. |

Those Tesseract boxes would be in **preprocessed image pixels**, not PDF user space. Raster scale is 2, and a narrow page is upscaled another 2×. Nothing stores either scale, so a future box cannot be mapped back until those scales are kept beside the image.

`recognize()` supports a `rectangle`, which would limit OCR to a region. No caller passes one.

## Entry points

### CLI

```bash
node index.js [pdfDirectory] [outputFile]
npm start          # same, default ./pdfs → ./batches.json
npm run classify   # same
```

Runs only when the file is the process entry point (`import.meta.url` check), so importing the module does not scan a folder. Prints the full report to stdout and writes it to the output file. Report shape: `generatedAt`, `sourceDirectory`, `summary` (`totalPdfs`, `analyzed`, `ocrUsed`, `failed`, `batches`, `unbatchedGroups`), `batches`, `unbatched`, `errors`.

### HTTP

```bash
npm run web        # node server.js, port argv[2] or $PORT or 3000
```

`app.listen(port)` does not set a host, so it binds the process default (all interfaces), not loopback.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/` | Static `public/index.html`. On load it `GET`s `/api/config` and posts selected PDFs to `/api/classify` (XHR, field name `documents`). |
| `GET` | `/api/config` | `{ productName, primaryColor, logoUrl, documentTypes: string[], fields: string[] }` from the schema. No auth. |
| `POST` | `/api/classify` | Multipart `documents`. Same pipeline as the CLI via `processBuffers` + `segregateIntoBatches`. Adds `summary.durationMs`. `400` if no file, non-PDF, too many files, or a file over 25 MB. `500` with `{ error }` on an unexpected throw. Per-file ingestion failures stay in `errors` with HTTP 200. |

There is no auth, no CSRF check, and no rate limit. Branding in the schema can set `logoUrl`; the UI will request it.

### Library (`package.json` `"main": "index.js"`, ESM)

Stable exports used by the server:

| Module | Export | Role |
| --- | --- | --- |
| `index.js` | `processDirectory(dir)` | Every PDF in a directory → `{ analyzedDocs, errors }`. |
| `index.js` | `processBuffers([{ fileName, buffer }])` | Same, from memory. |
| `index.js` | `segregateIntoBatches(analyzedDocs)` | `{ batches, unbatched }`. |
| `index.js` | `analyzeText` | Re-export. |
| `index.js` | `extractTextFromPdfFile` | Re-export. |
| `analyze.js` | `analyzeText(rawText)` | `{ documentType, fields }`. Pure function of text + schema. |
| `pdfIngest.js` | `extractTextFromBuffer(buffer)` | `{ text, source }`. |
| `pdfIngest.js` | `extractTextFromPdfFile(path)` | Same, from disk. |
| `ocr.js` | `ocrImage(buffer)`, `terminateOcr()`, `ocrWasUsed()` | Low-level recognizer. |
| `imagePreprocess.js` | `preprocessForOcr(pngBuffer)` | PNG in, PNG out. |
| `extractors.js` | `runExtractor(field, doc)`, `splitLines(text)` | One field, or the line splitter. |
| `schema.js` | `loadSchema`, getters, `_resetSchemaCache` | Schema access. `SCHEMA_PATH` overrides the file. |

Per-document object from `processBuffers`: `{ fileName, source, documentType, fields }`. `fields` keys are always the full schema field list; inapplicable ones are `null`.

### Sample generator (not a product entry point)

```bash
npm run generate-samples    # node scripts/generate-samples.js [outputDir]
npm test                    # generator, then node index.js ./sample_pdfs
```

`pdfkit` is a devDependency used only here.

## Tests

No unit-test runner, no assertions, no fixtures with expected JSON, no ESLint config, no `tsconfig`, no `lint` script, and no `typecheck` script.

Commands run on 6 Nov 2026 (IST):

| Command | Result |
| --- | --- |
| `npm install` (existing lockfile) | Exit 0. 162 packages. npm reported 4 existing advisories (1 moderate, 2 high, 1 critical). Not upgraded. |
| `npm test` | Exit 0 in about 1.2 s of pipeline time. `generatedAt` `2026-11-06T12:27:25.576Z` (6 Nov 2026, 5:57 PM IST). |
| `npm run lint` | Exit 1. `Missing script: "lint"`. |
| `npm run typecheck` | Exit 1. `Missing script: "typecheck"`. |
| `node --check` on the nine application/script files | Exit 0. Syntax only, not types. |

`npm test` generates 6 text PDFs and 1 image-only PDF under `./sample_pdfs` (gitignored), then classifies that folder. Summary from the run:

- `totalPdfs` 7, `analyzed` 7, `ocrUsed` 1, `failed` 0, `batches` 1, `unbatchedGroups` 5, `errors` `[]`.
- Batch `BATCH-INV-2024-001`: `invoice_001.pdf` (Invoice, text) + `po_7788.pdf` (Purchase Order, text), keys `INV-2024-001` and `PO-7788`.
- Unbatched text docs matched their sample labels: orphan invoice `INV-2024-999`, receipt `RCPT-3341`, transaction `TXN-88213`, and `random_note.pdf` as Unknown with all fields `null`.
- Scanned `receipt_scanned.pdf` was `Receipt` / `source: "ocr"`. Company `Sunrise Stores Pvt Ltd`, date `25/06/2024`, and amount `1,499.00` matched the generator. **`documentNumber` came back `RCP1-7788`, not `RCPT-7788`.** The smoke test still exited 0, because it never compares fields to the strings written by `scripts/generate-samples.js`. Address was `null` because that sample draws no address line. The transaction sample also has no address line, so its address was `null`; its amount `450.00` is the unlabeled money fallback on `Debit: 450.00`.

`sample_pdfs/` and `batches.json` are gitignored and were produced by this test run. They are not source.

## Customer documents in the repo

**None.** `git ls-files` is source, schema, docs, and the lockfile only. A search for committed or working-tree `.pdf`, `.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.webp`, `.docx`, and `.csv` outside `node_modules` and `.git` found no files before the test run. `.gitignore` excludes `sample_pdfs/`, `pdfs/`, `batches.json`, and `*.log`.

`scripts/generate-samples.js` states that it generates samples so the pipeline can run without real customer documents. Issuer names in that script (including a bank name) are fixture strings in source, not uploaded paperwork. No customer-document path to list.

## Recommended service API for Jarvis

Jarvis (`dhruv-ai`) is a FastAPI orchestrator. This repo is Node. The fit is a **local read-only HTTP tool** in front of the existing functions (`processBuffers`, `analyzeText`, `segregateIntoBatches`), not a Python rewrite and not Docling, unless the owner revisits that decision.

Bind `127.0.0.1`. Do not expose the current `server.js` as the Jarvis tool: it listens on all interfaces, has no auth, and its batch members omit fields. Put the tool behind Jarvis tool permissions. It must not place orders, talk to a broker, or call the network. OCR stays on the vendored English model.

Default the response so raw page text is **absent**. Financial text should not enter Jarvis memory unless an approved tool flag asks for it.

`confidence`, `page`, and `bbox` are part of the shape and are **`null` until a later change stores them**. Returning `null` is deliberate: Jarvis can require human review whenever a value is non-null and confidence is null, without inventing a score this pipeline does not have.

### `GET /v1/schema`

Server-side schema only. Do not accept a client `SCHEMA_PATH` (arbitrary file read).

```json
{
  "productName": "DocuClassify",
  "documentTypes": ["Invoice", "Purchase Order", "Transaction Record", "Receipt", "Unknown"],
  "fields": [
    { "name": "documentNumber", "extractor": "labeledId", "appliesTo": ["Invoice", "Transaction Record", "Receipt"], "isBatchKey": true }
  ]
}
```

### `POST /v1/documents/analyze`

`multipart/form-data`, repeatable file part `documents` (PDF only). Optional query `includeText=1` (default off) and `batch=1` (default on).

```json
{
  "schemaVersion": "2.0.0",
  "summary": {
    "totalPdfs": 1,
    "analyzed": 1,
    "ocrUsed": 0,
    "failed": 0,
    "batches": 0,
    "unbatchedGroups": 1,
    "durationMs": 0
  },
  "documents": [
    {
      "fileName": "invoice_001.pdf",
      "source": "text",
      "pageCount": null,
      "documentType": "Invoice",
      "classification": { "type": "Invoice", "score": null, "candidates": [] },
      "fields": {
        "documentNumber": { "value": "INV-2024-001", "confidence": null, "page": null, "bbox": null },
        "referenceNumber": { "value": "PO-7788", "confidence": null, "page": null, "bbox": null },
        "companyName": { "value": "Acme Exports Pvt Ltd", "confidence": null, "page": null, "bbox": null },
        "address": { "value": "12 Industrial Estate, Andheri East, Mumbai 400069", "confidence": null, "page": null, "bbox": null },
        "date": { "value": "10/05/2024", "normalized": null, "confidence": null, "page": null, "bbox": null },
        "amount": { "value": "12,500.00", "currency": null, "confidence": null, "page": null, "bbox": null }
      },
      "text": null
    }
  ],
  "batches": {},
  "unbatched": {},
  "errors": []
}
```

`documents[]` is the source of truth for fields. `batches` / `unbatched` may repeat file names for grouping, which is all the current batch objects can do reliably. `source` stays `"text"` or `"ocr"` with today's meaning, including the failed-OCR labeling gap. `pageCount` stays `null` until ingestion keeps `TextResult.pages` or screenshot `pageNumber`. `bbox` stays `null`; when it exists it should be PDF user-space points, not preprocessed pixels, and the response should carry `renderScale` and `preprocessScale` used to compute it.

Errors: per-file `{ fileName, reason }` with HTTP 200 if at least the request was valid; HTTP 400 for an empty upload or a non-PDF; no stack traces in the body.

### Out of scope for that tool

Line items, normalized dates, currency codes, per-field confidence, page geometry, non-PDF inputs, non-English OCR, and any trading or payment side effect. Those are gaps in this baseline, not behavior Jarvis should pretend the service has.
