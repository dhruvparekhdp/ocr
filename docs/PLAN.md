# Development plan (replanned 2026-11-03)

This is the working plan for whoever continues development (human, Cursor, or
Claude). It is written to be executed task by task. Before starting any task,
read `CLAUDE.md` (working rules), then `docs/DECISIONS.md` (why things are the
way they are). When a task changes a decision, record it in `DECISIONS.md`;
when it finishes, tick it here and add a line to `HISTORY.md`.

---

## 1. Product in one paragraph

A white-label document analyser for **finance documents** (invoices, credit
notes, purchase orders, quotations, receipts, bank statements; PDF, scans,
phone photos, XLSX/CSV, including images embedded in PDFs and spreadsheets).
It turns each document into **validated, structured data** with every value
traceable to its location in the document, groups related documents, and
(later) answers questions over them. It is sold to clients as a branded
product or run as a service. **Global documents, English first.**

## 2. Non-negotiable rules (from the owner, all recorded in DECISIONS.md)

1. **Client data never goes to a third-party AI API.** Live processing uses
   only (a) offline rules or (b) **our own self-hosted model**. Groq (or any
   API model) is used **only to create training data** from synthetic or
   public documents. Enforce this in code, with a test.
2. **Three processing modes per client:** `offline` (rules only, no network),
   `llm` (our model), `hybrid` (rules first, our model for missing,
   low-confidence or failing fields). Default `offline`.
3. **Commercial licences only** — every library, model weight and dataset.
   No AGPL (e.g. PyMuPDF), no non-commercial model or dataset licences.
4. **Multi-tenant everywhere.** Every query, file and endpoint is
   tenant-scoped; other tenants' IDs return 404. Every new endpoint gets a
   cross-tenant test.
5. **Schema-driven.** Document types, fields, labels, validation rules and
   branding come from `config/schema.json` or a tenant's own schema. Never
   hardcode a type or field name in pipeline or UI code.
6. **Never delete old context.** Mark it superseded, keep the text, list
   conflicts in DECISIONS.md for the owner.
7. **Measure, don't assume.** Accuracy claims need the eval set or a
   reproducible test. Record measurements next to the decision.
8. **Hardware:** dev machine is an Intel x86_64 Mac, 8 GB RAM, no GPU, no
   Docker. Many wheels are missing on that platform (torch > 2.2.2,
   onnxruntime > 1.23.2, cryptography > 48). Check a dependency installs
   there before designing around it; training happens on free cloud
   notebooks.

## 3. Current state (as of commit `a9d8170`, branch `claude/python-backend`)

| Phase | Status | What exists |
| --- | --- | --- |
| P0 Foundation | ✅ done | FastAPI backend (`backend/`), tenants + hashed API keys, per-tenant schema, content-sniffed uploads, per-tenant storage + dedupe, Alembic migrations, `docai-admin`, `docai-eval` (label templates, validation, per-field scoring). |
| P1 Ingestion | ✅ done | PDF (pypdfium2; per-page text layer vs OCR; OCR of embedded images), images (EXIF, multi-page TIFF), XLSX (values/formulas/merges/hidden sheets/embedded images), CSV → one `ParsedDocument` model with line ids and bboxes. RapidOCR (ONNX, CPU). DB-polled worker (`docai-worker` or `EMBEDDED_WORKER=true`). |
| P2.1 Offline extraction | ✅ done | `docai/extract/`: keyword classification, rule extractors ported from `legacy/` and extended for global formats, `additional_fields`, schema validation rules, union-find batching, `docai-admin analyze <dir>` (legacy parity), `/extraction` and `/batches` endpoints. |
| P2.2 LLM runtime | ⬜ next | — |
| P2.3 Review UI | ⬜ | — |
| P2.4 Eval baseline | ⬜ | Tooling exists; no labelled real documents yet. |
| P3 Q&A / reasoning | ⬜ | — |
| P4 Own model | ⬜ | — |
| P5 Hardening & deploy | ⬜ | — |

**Run it**

```bash
cd backend
uv sync
uv run alembic upgrade head
uv run docai-admin create-tenant acme "Acme"          # prints API key once
uv run uvicorn docai.main:app --reload                 # API docs: http://localhost:8000/docs
uv run docai-worker                                    # second terminal
uv run pytest                                          # 68 tests, ~90 s (OCR model load dominates)
uv run docai-admin analyze ./some-folder --out report.json
```

**Code map** — see `docs/ARCHITECTURE.md`. Key files: `doc_schema.py`
(schema model), `ingest/` (parsing), `extract/heuristic.py` (offline rules),
`extract/validate.py`, `extract/batching.py`, `pipeline.py` (mode dispatch —
LLM modes currently raise `ModeUnavailable`), `worker.py`, `main.py` (API).

## 4. Owner actions (blocking items are marked)

| # | Action | Blocks |
| --- | --- | --- |
| O1 | Merge `claude/python-backend` into `main` (PR, or push as the owner account — this Mac's git login is a different account, `DhruvDpVoloTrade`). | Nothing technically; do it before Cursor starts so it works on `main`. |
| O2 | Put `GROQ_API_KEY=...` in the repo-root `.env` (git-ignored). | P4.2 teacher labelling only. |
| O3 | Collect **50–100 real finance documents** you are allowed to use for testing, across all types, including bad scans. Put them in `eval/documents/` (git-ignored). | P2.4 and every accuracy decision after it. |
| O4 | Approve downloading a base model (~1–3 GB GGUF) and installing a local model server (llama.cpp `llama-server` or Ollama). | P2.2 real-model testing (P2.2 code can be built against a fake server first). |
| O5 | Check Groq's terms of service allow using outputs to train a model; confirm the teacher model's licence (prefer Apache-2.0 models such as gpt-oss). | P4.2 |
| O6 | Choose where the product runs first (local only / a free Linux host / a small paid VPS). The model server needs ~4–8 GB RAM. | P5 |

## 5. Phased tasks

Each task lists **goal → work → done when**. Keep tasks as separate commits;
run `uv run ruff check . && uv run ruff format . && uv run pytest` before each.

### P2.1-close — tidy what's just landed (small)

- [ ] **Docs:** update `README.md` (status, extraction endpoints, `analyze`
  command, offline-mode limitations) and `docs/ARCHITECTURE.md` (extract
  package, pipeline, statuses `parsed`/`extracted`, tenant `mode`,
  `document_type`). DECISIONS already has the P2.1 decisions.
- [ ] **Set a tenant's mode:** `docai-admin set-mode <slug> offline|llm|hybrid`
  and `set-schema <slug> <file>`; validate the schema on load.
- [ ] **Reprocess on schema change:** `docai-admin reprocess <slug>` re-queues
  that tenant's documents.
- **Done when:** commands tested; docs describe the system as it is.

### P2.2 — LLM runtime: our self-hosted model behind one interface

Goal: `llm` and `hybrid` modes work with a model we run ourselves.

1. **Provider interface** `docai/llm/provider.py`
   - One method: `complete_json(messages, json_schema, *, max_tokens, temperature) -> dict`.
   - Implementation `OpenAICompatibleProvider` using `httpx` against
     `/v1/chat/completions` — both `llama-server` (llama.cpp) and Ollama
     expose this, so no vendor SDK. Pass the JSON schema via
     `response_format` (`{"type": "json_schema", ...}`); fall back to
     "JSON only" prompting + parsing if the server rejects it.
   - Settings: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TIMEOUT_S` (default 120),
     `LLM_MAX_INPUT_CHARS`.
   - Timeouts, 2 retries with exponential backoff, clear error types
     (`LLMUnavailable`, `LLMBadOutput`).
2. **Teacher provider is separate and fenced**
   - `docai/llm/teacher.py` (Groq, also OpenAI-compatible) is importable only
     from `training/`. Add a test that walks `docai/` (excluding
     `docai/llm/teacher.py`) and fails if anything else imports it or
     references `GROQ_API_KEY`. This is rule 1 enforced in code.
3. **Prompt + output contract** `docai/llm/extraction_prompt.py`
   - Build the system prompt from the schema: document types with
     descriptions, fields applicable per type with type + description, value
     conventions (ISO dates, plain decimals, ISO currency, `null` if absent).
   - Input = `ParsedDocument` rendered with **line ids** (`[p1-l4] Invoice No: …`;
     sheets as rows with cell refs). Truncate long documents by page with a
     marker; record truncation as an issue.
   - Output JSON schema built from the doc schema:
     `{documentType, fields: {name: {value, line_id}}, additionalFields: [{label, value, line_id}]}`.
     Tables as arrays of row objects.
   - **This module is shared with training** (P4) so training prompts and
     runtime prompts can never drift. Version it (`PROMPT_VERSION`) and store
     it on each extraction.
4. **LLM extraction** `docai/extract/llm.py`
   - Call provider, validate with Pydantic, normalise values with the same
     helpers as offline (`extract/values.py`), so `"1.234,50"` from the model
     still becomes `"1234.50"`.
   - **Grounding check:** a value is "grounded" if its normalised text occurs
     in the cited line (or adjacent line). Ungrounded → confidence × 0.5 and an
     issue. Unknown `line_id` → treat as ungrounded.
   - Confidence: start 0.75 grounded / 0.35 ungrounded; then
     `validate()` adjusts as today.
5. **Hybrid merge** `docai/extract/hybrid.py`
   - Run offline first. Ask the model only for fields that are missing,
     below a confidence threshold (default 0.6), or involved in a failed
     validation — plus document type if type confidence < 0.6. (Smaller
     prompts = faster on CPU.)
   - Merge per field: agree → take value, confidence = max + 0.1; disagree →
     prefer the grounded one; both grounded → prefer the one that passes
     validation, else keep offline and add an issue. `method="hybrid"`.
6. **Pipeline + worker**
   - `pipeline.extract_document` dispatches by mode; `LLMUnavailable` keeps
     the doc `parsed` with an error and **retries later with backoff**
     (add `next_attempt_at` column; the worker skips rows not yet due).
7. **Base model (until our fine-tuned one exists)**
   - Pick a small instruct model with a **commercial licence** and a GGUF
     build that runs on CPU in 8 GB RAM, e.g. a Qwen3 1.7B–4B instruct
     (Apache-2.0 — verify the licence on the model card at download time).
     Q4_K_M quantisation. Record the choice and measured speed in DECISIONS.
   - Measure on the dev Mac: seconds per document for a 1-page invoice. If
     > 60 s, default new tenants to `hybrid` (smaller prompts), not `llm`.
8. **Tests**
   - A fake OpenAI-compatible server (FastAPI app in `tests/`) returning
     canned JSON — covers: valid output, malformed JSON, schema-violating
     output, ungrounded values, timeout, 500s, hybrid merge cases.
   - The teacher-isolation test from step 2.
- **Done when:** with the fake server, all three modes pass tests; with a
  real local model (after O4), the 7 legacy samples + layout invoice extract
  correctly in `llm` and `hybrid` mode, and speed is recorded.

### P2.3 — Review UI (new page, not a port of the legacy HTML)

Goal: a client can upload, watch processing, check every field against the
document, correct mistakes, and export.

1. **Stack:** React + TypeScript + Vite, built to static files served by
   FastAPI at `/` (no Next.js — keeps one process and fits 8 GB RAM). Put it
   in `frontend/`. UI kit: Tailwind + shadcn/ui (MIT). PDF/image viewing via
   page images from the API (below), not a PDF.js dependency.
2. **API additions** (each with cross-tenant tests)
   - `GET /api/documents/{id}/pages/{n}.png?dpi=120` — rendered page image
     (pypdfium2 for PDF, the image itself for images); cache to disk.
   - `PUT /api/documents/{id}/review` — corrected `{documentType, fields}`;
     store as a `reviews` row (tenant_id, document_id, reviewer, JSON,
     created_at) and mark the document `reviewed`. Keep the model's
     extraction unchanged (we need both for training/eval).
   - `GET /api/export?format=csv|xlsx|json&status=reviewed` — one row per
     document, schema fields as columns (xlsx via openpyxl).
   - Upload progress: list endpoint already has status; poll every 2 s.
3. **Screens**
   - Login: API key entry for now (stored in `sessionStorage`); real user
     accounts are P5.
   - Documents: drag-and-drop upload (multi-file), table with filename,
     type, status, issues count, OCR badge, uploaded time; filters.
   - Document review: left = page image with **bbox highlight** of the
     line behind the selected field (line ids → bboxes from the parsed
     JSON); right = form generated from the schema (field types → inputs;
     tables → editable grid), confidence colour per field, issues list,
     additional fields, "Approve" button. Keyboard: next/prev field.
   - Batches: grouped documents with their keys.
   - Branding from `/api/config` (name, colour, logo).
- **Done when:** golden path verified in a browser (upload → extracted →
  correct a field → approve → export xlsx contains the correction), plus an
  edge case per screen (failed document, empty list, spreadsheet document).

### P2.4 — Eval baseline (needs O3)

1. Label `eval/documents/` by **reviewing them in the UI** (P2.3) — a
   reviewed document *is* a label. Add `docai-admin export-labels <slug>
   <dir>` writing `docai-eval` label files from reviews.
2. `docai-admin predict <dir> --mode offline|llm|hybrid --out <run-dir>`
   writing prediction files in the label format.
3. Score each mode with `docai-eval score`; commit the **report** (not the
   documents) under `eval/reports/<date>-<mode>.json` and summarise in
   DECISIONS.
- **Done when:** a baseline table (per field accuracy, per mode) exists and
  the default mode for new tenants is chosen from it.

### P3 — Questions and reasoning over documents

Goal: "What did we pay Acme in March?", "Which invoices are overdue?",
"Does this statement's closing balance match?" — answered with citations,
by our own model only.

1. **Structured store first:** write each extraction's fields and table rows
   into per-tenant SQL tables (`extracted_fields`, `extracted_rows`) on
   extract/review. Most finance questions are SQL questions.
2. **Spreadsheets:** load parsed sheets into DuckDB (MIT) per question;
   the model writes SQL over it rather than reading the whole sheet
   (LLMs are unreliable at arithmetic over big tables).
3. **Text retrieval:** SQLite FTS5 over parsed lines (no extra service);
   pgvector + embeddings only if FTS proves insufficient on the eval
   questions.
4. **Agent loop** (`docai/qa/`): tools = `sql(query)` (read-only, tenant
   filter injected server-side, never trusted from the model),
   `search(text)`, `get_document(id)`. Answer must cite document ids + line
   ids; the API returns citations the UI can highlight.
5. **API/UI:** `POST /api/ask` (+ per-document variant); a chat panel in the
   review UI.
6. **Eval:** 50 question/answer pairs over the eval set; score exact answers
   + citation correctness.
- **Done when:** ≥ the target accuracy the owner sets on the question set,
  with no cross-tenant data reachable (test with two tenants' data loaded).

### P4 — Our own model (distillation; no client data)

Goal: a small, commercially licensed model fine-tuned on teacher outputs that
beats the base model on the eval set and runs on CPU.

Code lives in `training/` (its own `pyproject.toml`; may use heavier deps;
never imported by `backend/`).

1. **Synthetic document generator** `training/synth/`
   - Programmatic documents with **known ground truth**: invoices, credit
     notes, POs, quotes, receipts, statements; many layouts (1/2 columns,
     header/footers, tables), locales (US/UK/EU/IN/AE/SG/AU), currencies,
     date formats, number formats, multi-page, noisy scans (render → blur,
     rotate ±3°, JPEG artefacts, stains), phone-photo perspective.
   - Use Faker (MIT) for names/addresses; reportlab for PDFs; PIL/OpenCV for
     degradation; openpyxl for spreadsheets.
   - Output: the document + exact labels in `docai-eval` format.
   - Because labels are exact, **extraction training data needs no teacher**.
2. **Teacher data (needs O2, O5)** `training/teacher/`
   - Use the teacher for what synthetic labels can't give: more varied
     *realistic text content* (the teacher writes invoice contents that the
     generator then lays out), Q&A pairs and short reasoning for P3, and
     labels for public, commercially usable documents if any are found.
   - Cache every call (hash of prompt → response) so reruns cost nothing;
     log token usage; respect rate limits.
3. **Dataset builder** — runs the *real* ingestion (`backend` parser) on each
   generated document and builds chat examples with the **shared runtime
   prompt** (P2.2 step 3). Filter out examples whose labels fail schema
   validation rules. Split train/val/test by template, not by document, so
   the test set has unseen layouts.
4. **Fine-tuning** on free Colab/Kaggle GPUs: LoRA/QLoRA with Unsloth or
   TRL (both Apache-2.0) on the P2.2 base model. Notebook + script in
   `training/finetune/`; checkpoint to the owner's storage (HF private repo
   or Drive). Merge → convert to GGUF → quantise (llama.cpp tools).
5. **Gate:** a new model ships only if it beats the current one on (a) the
   synthetic test split and (b) the real eval set (P2.4), per field, without
   regressing any field by > 2 points. Record results in DECISIONS.
6. **Model registry:** `models/registry.json` (name, base, data version,
   prompt version, eval scores, sha256 of GGUF). The runtime logs which model
   produced each extraction (`Extraction.model`).
- **Done when:** the fine-tuned model is the default for `llm`/`hybrid`
  tenants and the Groq dependency is only in `training/`.

### P5 — Hardening and deployment

1. **Postgres** via `DATABASE_URL` (migrations are already portable); keep
   SQLite for local/dev.
2. **Containers** (built and run on Linux, not on the dev Mac): `api`,
   `worker`, `llm` (llama-server), `postgres`; docker-compose for a single
   VPS.
3. **Users and roles** for the UI (tenant admin, reviewer); sessions or
   OAuth; API keys stay for integrations. Audit log of reviews/exports.
4. **Usage metering** per tenant (pages processed, LLM calls) for billing;
   per-tenant quotas and rate limits.
5. **Data lifecycle:** delete document (files + parsed + extraction +
   reviews), per-tenant retention setting, tenant export, backups.
6. **Security:** upload limits already exist — add a malware-scan hook,
   zip-bomb guards for XLSX, dependency audit (`uv pip audit` or
   `pip-audit`), secrets only from env, HTTPS behind a proxy. Run
   `/security-review` before the first client.
7. **CI:** GitHub Actions on Ubuntu — `uv sync`, ruff, pytest, alembic
   check; build the frontend.
8. **White-label packaging:** per-tenant branding in the UI (done via
   schema), custom domain notes, an onboarding guide (create tenant →
   schema → mode → first upload).
9. **Retire `legacy/`** once parity is confirmed: move its README to
   `docs/legacy/`, delete code, record in HISTORY (old docs stay).

## 6. Backlog of known gaps (from README limitations and reviews)

- Scans rotated 90°/180° without metadata: add orientation detection
  (RapidOCR's text-direction classifier, or try 4 rotations and keep the
  highest OCR confidence) — measure first.
- Deskew for slightly skewed scans — measure; legacy notes warn naive
  deskew can hurt.
- Table structure (line items / transactions) in offline mode: today only
  the LLM fills table fields. Options: column detection from bbox x-gaps;
  a table model later (Docling/TableFormer needs torch → Linux only).
- `.xls` (old Excel) and password-protected PDFs (accept a password on
  upload).
- Images inside PDF form XObjects aren't OCR'd on text pages.
- `/api/batches` loads every extraction file per request — move to the SQL
  tables from P3.1.
- Other OCR languages once English is solid (RapidOCR has multilingual
  models; check licences).

## 7. Notes for an AI coding agent (Cursor)

- Work on a feature branch per phase; small commits; never push to `main`
  directly.
- Don't add dependencies without checking (a) licence, (b) an x86_64 macOS
  wheel exists (`uv add` on the dev Mac), (c) it isn't redundant with
  something already used.
- Tests generate their own fixtures (`tests/fixtures.py`) — don't commit
  binary documents or anything from `eval/documents/`.
- The OCR engine loads in ~10 s; tests that OCR are slow. Keep pure-logic
  tests separate and fast.
- When a heuristic or prompt change is made, run `docai-admin analyze` on
  the legacy samples and (once available) `docai-eval` on the eval set, and
  paste the before/after numbers in the commit message.
- If an instruction here conflicts with the owner's latest request, follow
  the owner and update this file and DECISIONS.md.
