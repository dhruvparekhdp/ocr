# Architecture

This describes the system as it exists today. For why it looks this way
(including approaches that were tried and rejected), see `DECISIONS.md`. For
the chronological path that got here, see `HISTORY.md`.

## Pipeline

```
                    ┌──────────────── per PDF ────────────────┐
   PDF file ─▶ pdfIngest ─▶ (embedded text?) ── yes ─▶ text ──┐
                    │                                          │
                    └─ no (scanned) ─▶ rasterize ─▶ preprocess ─▶ OCR ─▶ text┤
                                                               ▼
                                              analyze  (classify + extract)
                                                               │
                                                               ▼
                                              segregateIntoBatches (union-find)
                                                               │
                                                               ▼
                                                        batches.json / web UI
```

Everything runs in one Node.js process, locally. No network call happens at
any point in this pipeline (see `docs/DECISIONS.md` — "no cloud, no LLM").

## Modules

| File | Responsibility |
| --- | --- |
| `config/schema.json` | The single source of truth for document types, extractable fields (with an `extractor` name each), which fields count as batch keys, and web UI branding. This is the only file a new deployment/client should need to edit. |
| `schema.js` | Loads and validates `config/schema.json` (memoized per process); exports getters (`getDocumentTypes`, `getFields`, `getFieldsForType`, `getBatchKeyFields`, `getBranding`, etc.) that every other module reads from instead of hardcoding anything schema-shaped. |
| `pdfIngest.js` | Turns a PDF into text. Tries `pdf-parse`'s embedded-text extraction first; if that comes back empty/sparse (a scanned PDF), rasterizes each page via the SAME `pdf-parse` instance's `getScreenshot` (see `DECISIONS.md` for why not a second PDF library), preprocesses each page image, and OCRs it. Returns `{ text, source: 'text' | 'ocr' }`. |
| `imagePreprocess.js` | Pre-OCR image cleanup, in order: conditional 2x upscale (if narrower than 1500px), grayscale conversion, 3x3 median filter (denoise), Otsu binarization (per-image adaptive black/white threshold). Pure pixel manipulation via `@napi-rs/canvas` — no new dependency, no model. |
| `ocr.js` | The offline tesseract.js worker. Wired entirely to local files: engine WASM from `tesseract.js-core`, English language data vendored via the `@tesseract.js-data/eng` npm package. Zero network access at OCR time. A single worker is created lazily and reused; `ocrImage()` calls are serialized through a promise chain so concurrent documents queue safely instead of racing the same worker. |
| `extractors.js` | The from-scratch field-extraction heuristics. One function per `extractor` name referenced from `config/schema.json`: `labeledId` (documentNumber/referenceNumber — regex for an ID following a known label), `company` (corporate-suffix line near the top of the document), `address` (best-scoring run of address-cue lines), `date` (near a date label, else first date-shaped string; returned as printed, never normalized), `amount` (money-formatted number near a total label, else the largest money-formatted figure in the document — a bare unformatted integer is never treated as an amount). |
| `analyze.js` | Ties classification and extraction together: scores the document's text against each configured document type's keywords (`buildClassificationRules`, memoized), picks the highest-scoring type (or "Unknown"), then runs `extractors.js` only for the fields configured to apply to that type. Returns `{ documentType, fields }`. |
| `index.js` | Orchestration. `processDirectory`/`processBuffers` run ingestion+analysis over many files with bounded concurrency (`mapWithConcurrency`, limit 4 — kept low because OCR rasterization is memory-heavy and OCR itself is serialized on one worker anyway). `segregateIntoBatches` unions documents that share a value in any batch-key field (a `UnionFind`/disjoint-set implementation) and shapes the final `{ batches, unbatched }`. Also the CLI entry point (`node index.js [pdfDir] [outFile]`). |
| `server.js` | Express server. Serves `public/index.html`, `GET /api/config` (branding + document types + field list, for the UI to render dynamically), and `POST /api/classify` (multipart upload, processed entirely in memory, same pipeline as the CLI). Tears down the OCR worker on `SIGINT`/`SIGTERM` so the process exits cleanly. |
| `public/index.html` | The bulk-upload single-page UI. Fetches `/api/config` on load to set branding (title, header, accent color, optional logo) and knows nothing about specific document types or fields ahead of time — it renders whatever comes back from `/api/classify`, including an "OCR" badge on documents whose text came from the OCR path. |
| `scripts/generate-samples.js` | Dev-only sample PDF generator (`pdfkit` + `@napi-rs/canvas`), used by `npm test`. Generates both text-based PDFs and one image-only ("scanned") PDF, so the smoke test exercises both ingestion paths, not just the easy one. |

## Data shapes

**Per-document analysis result** (from `analyze.js`, enriched with `fileName`
and `source` in `index.js`):

```jsonc
{
  "fileName": "invoice_001.pdf",
  "source": "text",          // or "ocr"
  "documentType": "Invoice",
  "fields": {
    "documentNumber": "INV-2024-001",
    "referenceNumber": "PO-7788",
    "companyName": "Acme Exports Pvt Ltd",
    "address": "12 Industrial Estate, Andheri East, Mumbai 400069",
    "date": "10/05/2024",
    "amount": "12,500.00"
  }
}
```

**Final report** (from `index.js` / `server.js`):

```jsonc
{
  "summary": { "totalPdfs": 7, "analyzed": 7, "ocrUsed": 1, "failed": 0, "batches": 1, "unbatchedGroups": 5 },
  "batches": { "BATCH-INV-2024-001": { "documentNumber": "...", "referenceNumber": "...", "fileCount": 2, "documents": [...] } },
  "unbatched": { "documentNumber:RCPT-3341": [ { "fileName": "...", "documentType": "...", "source": "...", "fields": {...} } ] },
  "errors": [ { "fileName": "...", "reason": "..." } ]
}
```

## Extending the system

- **New document type or field for the same deployment**: edit
  `config/schema.json` only. No code change needed unless the field needs an
  extraction strategy that doesn't exist yet (see next point).
- **New kind of field** (one that needs logic none of the existing
  extractors provide, e.g. a tax-ID validator): add a function to
  `extractors.js`, add a `case` in `analyze.js`'s (or `extractors.js`'s)
  dispatch, and reference it by name from the field's `extractor` key in
  the schema.
- **A different client/deployment entirely**: point `SCHEMA_PATH` at a
  different JSON file with its own document types, fields, and branding.
  Nothing else needs to change.
- **A new language for OCR**: install the matching
  `@tesseract.js-data/<lang>` package and change the language code passed to
  `createWorker` in `ocr.js`.
