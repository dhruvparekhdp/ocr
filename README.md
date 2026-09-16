# DocAI — white-label document analyser for finance

Turns finance documents (PDFs, scans, photos, Excel/CSV) into validated structured data, with
per-client schemas and branding. Built to be sold as a white-label product or run as a service.

> Status: **P1 (ingestion)** — multi-tenant upload API, typed schema, evaluation tooling, and parsing of
> PDFs (text, scanned, mixed), images and spreadsheets into one document model. Extraction and Q&A
> arrive in P2–P3. The previous Node prototype lives in `legacy/`; its offline, rule-based pipeline is
> being integrated as the product's **offline mode** alongside an **LLM mode** (see
> [docs/DECISIONS.md](docs/DECISIONS.md) → "Dual mode" and "Open conflicts to plan").

More context: [CLAUDE.md](CLAUDE.md) (working rules), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/DECISIONS.md](docs/DECISIONS.md), [docs/HISTORY.md](docs/HISTORY.md).

## Roadmap

| Phase | Scope |
| --- | --- |
| **P0** ✅ | Python backend, tenants + API keys, uploads with content-type sniffing, schema v2, labelled eval set tooling |
| **P1** ✅ | Ingestion: per-page PDF text/scan routing, images, XLSX/CSV + embedded images → unified document model, background worker |
| P2 | Extraction in both modes — offline (ported legacy heuristics) and LLM (Groq: schema-constrained JSON, grounding, confidence) — plus validation, batching, review UI |
| P3 | Reasoning / Q&A: retrieval over text, SQL (DuckDB) over tables |
| P4 | Own model: distil reviewed outputs → fine-tune a small, commercially licensed VLM → run offline, drop the API |
| P5 | Hardening: billing/usage metering, admin UI, deployment, monitoring |

## Setup

Requires [uv](https://docs.astral.sh/uv/). Python 3.12 is installed by uv automatically.

```bash
cd backend
uv sync
uv run alembic upgrade head                            # creates ../data/docai.db
uv run docai-admin create-tenant acme "Acme Finance"   # prints the API key once
uv run uvicorn docai.main:app --reload                 # http://localhost:8000/docs
uv run docai-worker                                    # in a second terminal: parses queued documents
```

Single process instead (e.g. a free host): `EMBEDDED_WORKER=true uv run uvicorn docai.main:app`.
Debug a file without the server: `uv run docai-admin parse invoice.pdf` (or `--format json`).
The first OCR call loads the models (~10 s); after that it's about 1 s per page on a laptop CPU.

Configuration is via environment variables or a root `.env` (see `.env.example`). SQLite is the
default; set `DATABASE_URL` to use Postgres.

## API (P0)

All endpoints except `/api/health` need the `X-API-Key` header.

| Method | Path | |
| --- | --- | --- |
| GET | `/api/health` | liveness |
| GET | `/api/config` | tenant's branding + schema |
| POST | `/api/documents` | multipart `files` (≤200 per request); per-file `created` / `duplicate` / `rejected` |
| GET | `/api/documents?limit&offset` | tenant's documents, newest first |
| GET | `/api/documents/{id}` | metadata |
| GET | `/api/documents/{id}/file` | original file |
| GET | `/api/documents/{id}/parsed` | parsed document JSON; `?format=text` for layout text. 409 until `status` is `parsed` |
| POST | `/api/documents/{id}/reparse` | queue a parsed/failed document again |

Uploaded documents start `queued`, then become `processing` → `parsed` or `failed` (with an `error`).

File type is detected from content, not the extension. Accepted: PDF, PNG, JPEG, TIFF, WEBP, XLSX, CSV
(UTF-8). Files are stored content-addressed per tenant under `data/files/<tenant>/`, deduplicated
per tenant.

## Schema

`config/schema.json` defines document types and typed fields (`string`, `id`, `date`, `money`,
`number`, `currency`, `table` with columns). A tenant can be created with its own schema
(`docai-admin create-tenant … --schema path.json`); otherwise it uses the default.

## Evaluation set — do this before P2

Every model/prompt decision is measured against real labelled documents. Aim for 50–100 documents
covering each type, including bad scans and multi-page statements.

```bash
cd backend
# 1. put documents in ../eval/documents/ (git-ignored), then create empty label files
uv run docai-eval template ../eval/documents ../eval/labels
# 2. fill each ../eval/labels/<file>.json by hand, then check them
uv run docai-eval validate ../eval/labels
# 3. later: score a pipeline's predictions (same file format)
uv run docai-eval score ../eval/labels ../eval/runs/<run> --json report.json
```

Label conventions: dates `YYYY-MM-DD`; money/numbers as plain decimals (`"1499.00"`); currency as
ISO 4217; tables as a list of row objects; `null` when the document doesn't show the field. Only
fields that apply to the labelled `documentType` are scored.

## Ingestion: what's supported and known limits

| Input | How |
| --- | --- |
| Text PDF | Embedded text with positions, per page; rotated pages and crop boxes handled |
| Scanned PDF page | Rendered at 200 DPI → local OCR (RapidOCR) |
| Mixed page | Text layer + OCR of embedded images (≥2% of page) that have no text over them |
| Image (PNG/JPEG/TIFF/WEBP) | EXIF rotation applied, multi-page TIFF, OCR |
| XLSX | Every sheet (hidden flagged), cached values or formula text, merged ranges, embedded images OCR'd |
| CSV | UTF-8, delimiter detected, values kept as text |

Known limits (P1):
- **Tables are rows of text**, not reconstructed cells; column gaps are preserved as spaces. Table
  structure is left to extraction (P2).
- **No deskew / 90° page-rotation detection for scans** — upside-down or sideways scans without EXIF
  or PDF rotation metadata OCR poorly.
- **Handwriting** is not supported. **English-focused** models (they also read digits and Latin text).
- **Charts** in XLSX are not extracted (a warning is recorded); `.xls` (old binary Excel) and
  password-protected PDFs are rejected.
- **Form XObject images** (images nested inside PDF forms) on text pages are not OCR'd separately.
- Very large sheets are truncated at 100k cells per sheet (flagged `truncated`).
- Mac development note: this project runs on Intel Macs, which limits some libraries (no recent
  PyTorch). See DECISIONS "P1 ingestion decisions".

## Development

```bash
cd backend
uv run pytest
uv run ruff check . && uv run ruff format .
uv run alembic revision --autogenerate -m "..."   # after changing models in db.py
```
