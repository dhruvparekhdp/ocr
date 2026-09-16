# Architecture

This describes the system as it exists today. For why it looks this way
(including approaches that were tried and rejected), see `DECISIONS.md`. For
the chronological path that got here, see `HISTORY.md`. The previous Node.js
pipeline is documented in `legacy/README.md`.

## Target pipeline (roadmap)

```
upload ─▶ store (tenant-scoped) ─▶ ingest ─▶ unified document ─▶ extract ─▶ validate ─▶ batch ─▶ review UI
  P0            P0                   P1          P1               P2          P2         P2        P2
                                                     └──────────▶ Q&A / reasoning (P3)
                                                     └──────────▶ training data for own model (P4)
```

Two processing modes share this pipeline (DECISIONS "Dual mode"):
**offline** (local OCR + rule-based extraction, no network) and **LLM**
(Groq now, own distilled model later). Ingestion (P1) is local in both.

Built so far: **P0** (upload, storage, tenants, schema, eval tooling) and
**P1** (ingestion into the unified document model, background worker).

```
POST /api/documents ─▶ storage (sniff type, hash, per-tenant blob) ─▶ documents row: queued
                                                                         │
docai-worker / EMBEDDED_WORKER thread ◀── claim (compare-and-set) ◀──────┘
   │
   ├─ pdf         ─▶ per page: text layer usable? ── yes ─▶ text runs (+ OCR of large images without text)
   │                                              └─ no ──▶ render 200 DPI ─▶ RapidOCR
   ├─ image       ─▶ EXIF transpose, each TIFF frame ─▶ RapidOCR
   └─ spreadsheet ─▶ openpyxl (values + formulas, merges, hidden, images ─▶ RapidOCR) | csv sniffer
   │
   ▼
ParsedDocument JSON ─▶ data/files/<tenant>/parsed/<document_id>.json ; row: parsed | failed
GET /api/documents/{id}/parsed[?format=text]
```

## Backend layout (`backend/`)

| Module | Responsibility |
| --- | --- |
| `docai/settings.py` | Environment/`.env` configuration (`DATABASE_URL`, `STORAGE_DIR`, `SCHEMA_PATH`, `MAX_UPLOAD_MB`, `GROQ_API_KEY`). Paths default to the repo's `data/` and `config/`. |
| `docai/db.py` | SQLAlchemy models (`Tenant`, `Document`), engine/session setup, SQLite pragmas (WAL, foreign keys), `UTCDateTime` column type, constraint naming convention for portable migrations. |
| `docai/doc_schema.py` | Pydantic model of `config/schema.json` (v2): branding, document types, typed fields, table columns. Validates cross-references (unknown types, duplicate names, columns only on tables). |
| `docai/tenants.py` | Tenant creation, API key generation (`dak_` + 256-bit token, stored as SHA-256 hash only), key rotation, lookup, tenant schema resolution (own schema or default). |
| `docai/storage.py` | Streams an upload to a temp file while hashing and enforcing the size limit, sniffs the real type from content (magic bytes; XLSX by zip contents; CSV by extension + UTF-8 check), then moves it to `data/files/<tenant_id>/<sha[:2]>/<sha256>`. |
| `docai/main.py` | FastAPI app. `X-API-Key` auth dependency resolves the tenant; every query filters by `tenant_id`; other tenants' IDs return 404. Endpoints: health, config, upload, list, get, download. |
| `docai/cli.py` | `docai-admin`: create-tenant, list-tenants, rotate-key, `parse <file>` (parse a local file without the database — for debugging and eval). |
| `docai/ingest/model.py` | Unified document model: `ParsedDocument` → `pages` (lines with id `p{page}-l{n}`, text, normalised top-left bbox, source `text`/`ocr`, OCR confidence) and `sheets` (rows of cell values, merged ranges, hidden flag, OCR'd images by anchor cell). `to_text()` renders layout text with page markers and Excel-style row/column references — the input for extraction. `PARSER_VERSION` is stored per document. |
| `docai/ingest/pdf.py` | pypdfium2: text runs with positions (rotation/cropbox-aware normalisation), text-layer usability check, OCR fallback per page, OCR of embedded image regions that have no text over them. |
| `docai/ingest/image.py` | Pillow: EXIF orientation, multi-frame TIFF, size cap, OCR. |
| `docai/ingest/spreadsheet.py` | openpyxl XLSX (cached values with formula fallback, trimmed dimensions, merged ranges, hidden sheets, embedded images OCR'd, chart warning) and CSV (delimiter sniffing, values kept as strings). |
| `docai/ingest/ocr.py` | RapidOCR singleton (lazy, locked), conditional 2x upscale, OCR boxes mapped into page coordinates. |
| `docai/ingest/layout.py` | Groups positioned segments into visual rows and joins them with gap-proportional spacing so columns stay readable. |
| `docai/worker.py` | `docai-worker`: DB-polled queue (claim, parse, store JSON atomically, mark parsed/failed; stale-lock reclaim; retry cap). Also runnable as a thread inside the API. |
| `docai/evaluation.py` | `docai-eval`: label templates, label validation, scoring of predictions vs labels (type-aware normalisation, table row F1, document-type confusion). |
| `migrations/` | Alembic; batch mode on SQLite. |
| `tests/` | API (incl. cross-tenant isolation), schema validation, evaluation, ingestion against generated fixtures (text/scanned/mixed/searchable/encrypted/rotated PDFs, EXIF photo, multi-page TIFF, XLSX with formulas/merges/images, CSV), worker lifecycle. |

## Data model

- **Tenant**: `id`, `slug` (unique), `name`, `api_key_hash` (unique),
  `schema_json` (nullable → default schema), `created_at`.
- **Document**: `id`, `tenant_id` → tenant (cascade), `filename` (basename
  only), `sha256` (unique per tenant), `mime_type`, `kind`
  (`pdf`/`image`/`spreadsheet`), `size_bytes`, `status`
  (`queued` → `processing` → `parsed` | `failed`), `attempts`, `locked_at`,
  `error` (tenant-safe message), `page_count`, `parser_version`, `parsed_at`,
  `created_at`.

## Schema (`config/schema.json`, v2)

Document types (name + description, used as LLM guidance) and fields with a
`type`: `id`, `string`, `date` (ISO), `money` (plain decimal), `number`,
`currency` (ISO 4217), `table` (typed `columns`). `appliesTo` scopes a field
to document types; `isBatchKey` marks identifiers used to group related
documents. A tenant may carry its own schema.

## Extending

- **New document type / field for everyone:** edit `config/schema.json`.
- **Client-specific types/fields/branding:** create the tenant with
  `docai-admin create-tenant <slug> <name> --schema file.json`.
- **New model column:** edit `db.py`, then
  `uv run alembic revision --autogenerate -m "..."` and review the migration.

## Legacy Node pipeline (in `legacy/`) — kept verbatim, to be integrated

The owner asked (2026-09-16) for the old pipeline's capabilities to be
integrated into the Python product (as the offline, no-LLM mode), not
discarded. File paths below are now under `legacy/`. The integration plan and
its open conflicts are in `DECISIONS.md` → "Open conflicts to plan".


This describes the system as it exists today. For why it looks this way
(including approaches that were tried and rejected), see `DECISIONS.md`. For
the chronological path that got here, see `HISTORY.md`.

### Pipeline

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

### Modules

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

### Data shapes

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

### Extending the system

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
