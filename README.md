# DocAI — white-label document analyser for finance

Turns finance documents (PDFs, scans, photos, Excel/CSV) into validated structured data, with
per-client schemas and branding. Built to be sold as a white-label product or run as a service.

> Status: **P0 (foundation)** — multi-tenant upload API, typed schema, evaluation tooling.
> Parsing, extraction and Q&A arrive in P1–P3. The previous Node prototype lives in `legacy/` for
> reference only (it is not compatible with the v2 schema).

## Roadmap

| Phase | Scope |
| --- | --- |
| **P0** ✅ | Python backend, tenants + API keys, uploads with content-type sniffing, schema v2, labelled eval set tooling |
| P1 | Ingestion: per-page PDF text/scan routing, images, XLSX/CSV + embedded images → unified document model |
| P2 | Extraction via Groq (schema-constrained JSON, source grounding, validation, confidence), batching, review UI |
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
```

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

## Development

```bash
cd backend
uv run pytest
uv run ruff check . && uv run ruff format .
uv run alembic revision --autogenerate -m "..."   # after changing models in db.py
```
