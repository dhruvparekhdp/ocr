# Decisions

A record of non-obvious choices and the reasoning behind them, including
approaches that were considered and deliberately rejected. The point of this
file is to stop a future session (human or Claude) from re-litigating a
question that was already answered, or re-trying something that was already
tried and found wanting.

Newest decisions first. Sections marked **Superseded** or **Legacy (Node)**
are kept for context; they no longer describe the current system.

## Product direction: sellable white-label analyser, Groq now, own model later (2026-09-16)

**Decision:** The goal is a commercial product — sold white-label or run as a
service — that turns finance documents (PDF, scans, photos, XLSX/CSV,
including images embedded in PDFs/spreadsheets) into validated structured
data and supports reasoning/Q&A over it. Global documents, English first.
Cloud LLM/VLM calls via **Groq** are allowed for now. Once the owner's own
fine-tuned model is good enough (roadmap P4), the API path is removed and the
product runs fully offline.

**Why:** Heuristics (the previous state) topped out on exactly the fields
that matter — issuer vs recipient, addresses, tables, unusual layouts — and
can't do reasoning at all. The owner has a Groq API key but no GPU budget, so
cloud inference now + distillation into a small own model later is the only
path that is both accurate soon and offline eventually.

**Training from scratch is rejected** (again — see `HISTORY.md` step 3): it
needs data and compute this project doesn't have. "Own model" means
fine-tuning a small, commercially licensed open-weight model on reviewed
outputs, on free cloud notebooks (the dev Mac cannot train).

**Consequence:** the old "no cloud / no LLM / no model" rule below is
superseded, and the Docling "open question" is answered: local ML models are
in scope.

## Python backend replaces the Node prototype (2026-09-16)

**Decision:** New backend in Python (FastAPI, Pydantic v2, SQLAlchemy 2,
Alembic, `uv`). The Node app moved to `legacy/` as reference only.

**Why:** Document-AI tooling (PDF parsing, OCR models, table extraction,
fine-tuning, eval) is Python-first. Running a Python sidecar next to Node
would add a process boundary for every step. The Node code was ~1.5k lines,
so porting what's worth keeping (schema-driven design, union-find batching,
preprocessing lessons) is cheaper than bridging.

## Commercial-use licences only (2026-09-16)

**Decision:** Every dependency, model weight, and dataset must permit
commercial use.

**Why:** It's sold. Concretely this rules out PyMuPDF (AGPL — use
pypdfium2/pdfplumber instead), model sizes released under non-commercial or
research licences (check each Qwen-VL/other size individually), and
non-commercial public datasets for training. When distilling from API model
outputs, prefer models whose licence allows training on outputs (e.g.
gpt-oss, Apache-2.0) and re-check Groq's terms.

## Multi-tenancy from P0 (2026-09-16)

**Decision:** Tenants (with hashed API keys and an optional per-tenant
schema) exist from the first commit; every document row and stored file is
tenant-scoped, and dedupe is per tenant.

**Why:** White-label selling means several clients on one deployment.
Retrofitting tenant isolation later means migrating every table, file path,
and query — and a missed `WHERE tenant_id` is a data leak. Cross-tenant
access returns 404 (not 403) so a tenant can't probe for other tenants'
document IDs. Blob storage is per tenant rather than globally
content-addressed so deleting one tenant's data can never affect another's
and dedupe can't be used as a cross-tenant existence oracle.

## Schema v2: typed fields instead of heuristic extractor names (2026-09-16)

**Decision:** `config/schema.json` fields declare a `type` (`id`, `string`,
`date`, `money`, `number`, `currency`, `table` with typed `columns`) instead
of an `extractor` name. Keyword lists were dropped.

**Why:** Extraction is now done by a model, so the schema must describe the
*shape* of the answer (to build a JSON schema for constrained output and to
validate it) rather than which heuristic to run. Types also let the eval
scorer compare values correctly (money numerically, dates as dates, tables
by rows).

## Evaluation set before extraction work (2026-09-16)

**Decision:** Build a labelled eval set (target 50–100 real documents) and
score every pipeline change with `docai-eval` before choosing models or
prompts (gates P2).

**Why:** The July 2026 history pivoted five times in two days largely
because there was no way to measure whether an approach was better. Labels
are one JSON file per document with normalised conventions (ISO dates, plain
decimals) so scoring is deterministic.

## SQLite by default, Postgres-ready (2026-09-16)

**Decision:** SQLAlchemy with SQLite as the default `DATABASE_URL`; Alembic
migrations with an explicit constraint naming convention and batch mode for
SQLite.

**Why:** The dev Mac has no Docker/Homebrew/Postgres, and "free server or
local" deployment favours zero infrastructure. The naming convention keeps
migrations portable to Postgres. A `UTCDateTime` column type exists because
SQLite drops tzinfo, which made API timestamps inconsistent (found while
smoke-testing a live server).

## Superseded: No cloud, no LLM, no trained ML model

*Superseded on 2026-09-16 by "Product direction" above. Kept as context.*

**Decision:** The pipeline uses zero API calls and zero machine-learning
models of any kind. Classification is keyword scoring; extraction is regex
and pixel/text heuristics. OCR (tesseract.js) is the one component that could
be called a "model," but it's a fixed, pre-trained, offline, embedded engine
— not something this project trains, fine-tunes, or calls over a network.

**Why:** Explicit instruction from the project owner (see `HISTORY.md` for
the full sequence — this project previously had a Claude-based classifier and
two different locally-fine-tuned model pipelines, both removed). The stated
reasons: (1) the tool handles financial/company documents and should be able
to run air-gapped with nothing leaving the machine, and (2) a from-scratch,
inspectable, deterministic pipeline was explicitly preferred over a model
whose behavior is a training artifact.

**Do not reintroduce** a cloud/LLM classifier as the default path, or add a
trained model as a dependency, without this being an explicit request. If it
does come up again (e.g. for the fields heuristics handle worst — see
"Docling" below), make it opt-in and clearly separated from the default
offline path, not a silent replacement.

## Docling — considered, not adopted (yet) — *open question answered*

*2026-09-16: the owner confirmed models (local and cloud) are in scope, so the
"open question" at the end of this section is resolved. Whether Docling itself
is adopted is a P1 decision recorded separately.*

**What it is:** Docling (`docling-project/docling`) is a document-understanding
*orchestration* layer, not an OCR engine — it runs a layout-analysis model
plus TableFormer (table structure recognition) ahead of OCR, and only invokes
an OCR engine (Tesseract/EasyOCR/RapidOCR/etc.) on pages that are actually
scanned. It's Python, runs fully local/offline, and outputs a structured
document model (Markdown/JSON) with correct reading order and real table
structure — which would directly help this project's weakest heuristics
(company/address relies on "top of document, looks like a name," and
multi-column/tabular text gets flattened before extraction ever sees it).

**Why not adopted:** It uses local ML models (a layout model + TableFormer —
not an LLM, not cloud, but genuine trained CV models), and adopting it would
mean either (a) running a Python sidecar process alongside this Node app, or
(b) porting the whole app to Python. Given the "no models, from-scratch"
framing this project was rebuilt around, this needs an explicit decision
from the project owner before being adopted, not a default choice by an
agent.

**Recommended path if this is revisited:** a local HTTP sidecar
(`docling-serve`), with `pdfIngest.js`'s return shape widened from
`{ text, source }` to include structured regions/tables, behind an
`INGEST=docling` flag so it can be A/B tested against the current heuristic
path before becoming the default. Do not silently replace the current
ingestion path with this — measure first.

**Open question to resolve before building this:** is "no models" in this
project a hard line (no ML weights of any kind, ever) or specifically
"no cloud, no LLM" (in which case local CV models like Docling's layout
model are in scope)? This has not been answered yet.

## Legacy (Node): OCR preprocessing: median filter + Otsu, not deskew

*Findings were for tesseract. They're a useful prior (upscaling small text
matters; binarizing without denoising can produce confident garbage; naive
deskew can make things worse) but must be re-measured for whichever OCR
engine the Python backend uses — deep-learning OCR models are usually
trained on grayscale/colour images and may not benefit from binarization.*

**Decision:** `imagePreprocess.js` does conditional upscaling, grayscale
conversion, a 3x3 median filter, and Otsu binarization before every OCR call.
It deliberately does NOT attempt deskew (rotation correction).

**Why upscale + median + Otsu:** These are the standard, well-evidenced
classical preprocessing steps for OCR, and testing during development showed
concrete, measurable results:
- Upscaling alone took a genuinely tiny font (7px) from OCR returning nothing
  to reading nearly everything correctly. This is the single highest-leverage
  step for low-resolution input.
- Otsu binarization on its own, tested against synthetic salt-and-pepper
  noise, produced confident-looking but WRONG garbage text — worse than
  tesseract's own honest empty result on the unprocessed image. Adding a
  median filter before thresholding fixed this specific failure mode (it
  suppresses per-pixel speckle while preserving text edges, unlike a blur).
- On a moderate, more realistic degradation (lighting gradient + mild grain),
  tesseract's own internal handling was already good enough that preprocessing
  made no measurable difference either way — it's not a universal win, mainly
  a rescue for low-resolution/low-detail input.
- On extremely heavy, unrealistic synthetic noise (independent per-pixel
  static), neither the raw nor the preprocessed path produced usable text.
  This kind of noise doesn't model real scan degradation faithfully (real
  scans have spatially correlated artifacts — blur, shadow, compression —
  not independent-per-pixel randomness), so this result shouldn't be read as
  "preprocessing doesn't help real bad scans," but it's honestly reported
  here rather than glossed over.

**Why not deskew:** A skew-angle estimate that's wrong doesn't just fail to
help — it actively rotates already-readable text further off-axis, making
output worse than doing nothing. Implementing this well (reliably, across
real documents) is a meaningfully larger effort than the three steps above,
and shipping an untested/lightly-tested version risked violating this
project's stated preference for verified claims over assumed ones. It's
recorded in `README.md`'s "Gaps and limitations" as a known, deliberately
deferred gap rather than silently missing.

## Legacy (Node): Rasterization uses `pdf-parse`'s own `getScreenshot`, not a second library

**Decision:** `pdfIngest.js` uses the same `PDFParse` instance for both
embedded-text extraction (`getText()`) and page rasterization for OCR
(`getScreenshot()`), rather than a dedicated PDF-to-image library.

**Why:** An earlier version used `pdf-to-img` for rasterization. This broke:
calling `getText()` (via `pdf-parse`, which bundles its own pdfjs) and then
rendering the same PDF via a *second*, independently-bundled pdfjs
(`pdf-to-img`'s) in the same process corrupted pdfjs's internal global state,
and the second library's render call threw. Verified by reproducing the
failure with both libraries and confirming it disappeared when both text
extraction and rasterization went through one `pdf-parse` instance. This also
removed a dependency (`pdf-to-img`).

## Batching is union-find over configurable batch-key fields, not hardcoded relationships

*Still the plan: to be ported to the Python backend in P2 (fields marked
`isBatchKey` in schema v2).*

**Decision:** `segregateIntoBatches` treats any two documents that share a
non-null value in any field marked `isBatchKey: true` as belonging to the
same batch (a union-find/disjoint-set over shared field values), rather than
encoding a specific relationship like "Invoices anchor batches, POs join via
a reference field."

**Why:** The earlier, hardcoded version only worked for one specific
document-type relationship (Invoice + PO in a trade/logistics context). Once
the schema became configurable (any client can define their own document
types), the batching logic couldn't hardcode which type plays which role —
union-find over shared identifiers generalizes to any set of document types
and relationships the schema defines, without the batching code needing to
know what those types mean.

## Schema-driven, not hardcoded, document types and fields

*Still in force; schema v2 (above) changed the field format, and tenants can
now carry their own schema instead of using `SCHEMA_PATH` per deployment.*

**Decision:** `config/schema.json` is the single source of truth for
document types, extractable fields, which fields are batch keys, and web UI
branding. No module hardcodes a document type name or field name — they're
all read via `schema.js`'s getters.

**Why:** The project's stated purpose is a white-label tool: one deployment
might process invoices and purchase orders, another bills and transaction
records and receipts. Hardcoding either set into the classification/
extraction/batching code would mean a code change per client. A JSON config
file means onboarding a new client, or adding a document type an existing
client starts sending, is a config edit, not a code change.
