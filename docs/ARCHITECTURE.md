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

Built so far: **P0** (upload, storage, tenants, schema, eval tooling).

## Backend layout (`backend/`)

| Module | Responsibility |
| --- | --- |
| `docai/settings.py` | Environment/`.env` configuration (`DATABASE_URL`, `STORAGE_DIR`, `SCHEMA_PATH`, `MAX_UPLOAD_MB`, `GROQ_API_KEY`). Paths default to the repo's `data/` and `config/`. |
| `docai/db.py` | SQLAlchemy models (`Tenant`, `Document`), engine/session setup, SQLite pragmas (WAL, foreign keys), `UTCDateTime` column type, constraint naming convention for portable migrations. |
| `docai/doc_schema.py` | Pydantic model of `config/schema.json` (v2): branding, document types, typed fields, table columns. Validates cross-references (unknown types, duplicate names, columns only on tables). |
| `docai/tenants.py` | Tenant creation, API key generation (`dak_` + 256-bit token, stored as SHA-256 hash only), key rotation, lookup, tenant schema resolution (own schema or default). |
| `docai/storage.py` | Streams an upload to a temp file while hashing and enforcing the size limit, sniffs the real type from content (magic bytes; XLSX by zip contents; CSV by extension + UTF-8 check), then moves it to `data/files/<tenant_id>/<sha[:2]>/<sha256>`. |
| `docai/main.py` | FastAPI app. `X-API-Key` auth dependency resolves the tenant; every query filters by `tenant_id`; other tenants' IDs return 404. Endpoints: health, config, upload, list, get, download. |
| `docai/cli.py` | `docai-admin`: create-tenant, list-tenants, rotate-key. |
| `docai/evaluation.py` | `docai-eval`: label templates, label validation, scoring of predictions vs labels (type-aware normalisation, table row F1, document-type confusion). |
| `migrations/` | Alembic; batch mode on SQLite. |
| `tests/` | API (incl. cross-tenant isolation), schema validation, evaluation. |

## Data model

- **Tenant**: `id`, `slug` (unique), `name`, `api_key_hash` (unique),
  `schema_json` (nullable → default schema), `created_at`.
- **Document**: `id`, `tenant_id` → tenant (cascade), `filename` (basename
  only), `sha256` (unique per tenant), `mime_type`, `kind`
  (`pdf`/`image`/`spreadsheet`), `size_bytes`, `status` (`uploaded`),
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
