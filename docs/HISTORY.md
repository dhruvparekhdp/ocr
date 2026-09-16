# History

A chronological account of how this project got to its current state. Read
this if something looks like it was built, then undone — it probably was,
deliberately, and this explains why, so it doesn't get reintroduced by
accident.

## 1. Keyword/regex classifier for a fixed logistics taxonomy

The project started as a PDF batch classifier for a specific document
domain: purchase orders, commercial invoices, air waybills / bills of
lading, and shipping bills — Indian export/customs paperwork. Classification
was weighted keyword scoring; extraction was label-adjacent regex for an
invoice number and a PO number. Batching was hardcoded: invoices anchor a
batch, AWB/BL and shipping-bill documents join via the invoice number, PO
documents join via a PO-reference field found on the invoice.

## 2. LLM classifier added as the default

A Claude-based classifier (`llmClassifier.js`) was added and made the
default when Anthropic credentials were present, with the regex path kept as
an offline/no-credentials fallback. Rationale at the time: real customs/trade
paperwork varies enough in template and wording that hand-tuned regex needed
constant new patterns per document family, while an LLM reading the document
the way a person would generalized better without per-format tuning.

## 3. Local fine-tuning pipelines added

Two local model pipelines were built under `local-llm/`, so a user could run
their own trained model instead of calling Claude:
- A LoRA/QLoRA fine-tune on top of a small pretrained model (Qwen2.5-0.5B),
  producing JSON completions.
- A fully from-scratch pipeline (`local-llm/scratch/`) with a custom BPE
  tokenizer and a small randomly-initialized transformer, trained with a
  classification head (document type) and a BIO token-tagging head
  (invoice/PO number extraction) — genuinely dependency-free of Qwen/QLoRA/
  Hugging Face Hub, using only `torch` + `tokenizers`.

Both were designed to be interchangeable with the Claude path via a
`CLASSIFIER` env var, with a `serve.py` exposing the same
`POST /classify` contract either way.

## 4. Pivot to a configurable, white-label document classifier

The project's actual purpose was clarified: a white-label OCR/document tool
for corporate clients, where the document mix varies by client — invoices
for one, bills and bank transaction records for another. This required
generalizing away from the fixed 4-type logistics taxonomy:

- `config/schema.json` introduced as the single source of truth for document
  types, extractable fields, batch-key fields, and branding.
- `llmClassifier.js` rewritten to build its system prompt and structured-
  output schema dynamically from the schema config, instead of a fixed
  prompt describing 4 hardcoded types and 2 hardcoded fields.
- The regex fallback and batching logic similarly generalized: keyword
  scoring built from the schema's per-type keyword lists; batching rewritten
  as a union-find over whichever fields are marked as batch keys, replacing
  the old hardcoded "invoice anchors, PO joins" relationship.
- The web UI rewritten to fetch branding and the field/type list from a new
  `GET /api/config` endpoint and render whatever fields come back, instead
  of hardcoding `invoiceNumber`/`poNumber` columns.

At this point the tool had three interchangeable backends (Claude, local
LoRA model, local from-scratch model, regex fallback) all reading from the
same schema.

## 5. Full removal of cloud/LLM/model paths

The project owner gave an explicit, different instruction: remove every
cloud-based and LLM-based path entirely, and build a genuinely
from-scratch/local-only pipeline — PDF to text, or (for scanned documents)
image to text via OCR, with basic field extraction (document type, company
name, address, date, amount, reference numbers) done by from-scratch logic,
not by any model.

This meant:
- Deleting `llmClassifier.js`, `localClassifier.js`, the entire `local-llm/`
  tree (both fine-tuning pipelines), `scripts/extract-text.js` (training-data
  prep), and the `@anthropic-ai/sdk` dependency.
- Adding `pdfIngest.js` (embedded-text extraction with an automatic OCR
  fallback for scanned PDFs) and `ocr.js` (tesseract.js wired to
  locally-vendored engine + language data, so OCR needs zero network access
  — verified by testing with no network reachable).
- Adding `extractors.js` (from-scratch heuristics: labeled-ID regex,
  corporate-suffix-line company detection, address-cue-line scoring,
  labeled/fallback date detection, labeled/largest-money-figure amount
  detection) and `analyze.js` (keyword-scoring classification + dispatch to
  the applicable extractors).
- `config/schema.json` extended with `companyName` and `address` fields and
  an `extractor` name per field, so the schema-driven design introduced in
  step 4 carried forward into the new heuristic pipeline.
- The union-find batching logic from step 4 was kept as-is — it never
  depended on which backend produced the fields.

Two real bugs were found and fixed during this rewrite, both while verifying
claims before writing them into the README: an amount extractor that
false-positived on a document's postal code/PO-number digits when there was
no real total to find, and a labeled-ID regex that failed to match a
"Label.: value" separator style (double punctuation) that real documents use.

## 6. OCR preprocessing added

`imagePreprocess.js` was added: conditional upscaling, grayscale conversion,
median-filter denoising, and Otsu binarization before every OCR call. See
`DECISIONS.md` for the reasoning and the specific before/after testing that
justified each step (including a case where Otsu alone made things worse
without the median filter, and honest reporting of a stress test where
neither the raw nor the preprocessed path worked).

## 7. Context persistence into the codebase

This file, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, and `CLAUDE.md` were
added following an explicit instruction: keep project context, decisions,
and rationale in the codebase itself rather than only in conversation
history, so a future session (with no memory of these conversations) can
reconstruct the full picture from the repo alone.

## 8. Replan after a pause: sellable product, Groq, Python (2026-09-16)

After roughly two months paused, the owner restated the goal: an OCR
document analyser to **sell** (white-label or as a service), covering PDF,
scans, images (including images inside PDFs/Excel), Excel, and reasoning over
the data, using the latest stack. A Groq API key is available; there is no GPU
budget (dev machine: Intel Mac, 8 GB RAM).

Review of steps 1–7: the July work changed direction five times in two days
because two things were never pinned down — cloud vs local, and how to
measure "better". Kept: schema-driven white-label design, union-find
batching, text-vs-OCR routing, honest limitations. Dropped: keyword
classification and heuristic extractors (weakest fields per the old README).

Agreed with the owner: Groq allowed now; own fine-tuned model later, then go
fully offline; Python backend; global finance documents, English first;
deploy locally or on a free host. Roadmap P0–P5 is in `README.md`; decisions
are in `DECISIONS.md` dated 2026-09-16.

## 9. P0: Python backend foundation (2026-09-16)

`backend/` created (FastAPI, SQLAlchemy/Alembic, SQLite default): tenants
with API keys and per-tenant schemas, content-sniffed uploads with
per-tenant storage and dedupe, schema v2 with typed fields, and `docai-eval`
for labelling and scoring. The Node app moved to `legacy/`.

In parallel, another session committed step 6 (Node OCR preprocessing) and
step 7 (these docs) to `origin/main`; that was merged on top of P0, with the
Node changes relocated into `legacy/` and these docs updated to the new
direction rather than discarded.

## 10. P1 ingestion, and the owner's "keep both modes" instruction (2026-09-16)

P1 added `backend/src/docai/ingest/`: PDF (per-page text layer vs OCR, with
OCR of embedded images), images (EXIF rotation, multi-page TIFF), XLSX
(values, formulas, merged cells, hidden sheets, embedded images OCR'd) and
CSV, all into one positioned-lines document model, processed by a
database-polled worker. Library choices were constrained by the Intel Mac
(no recent PyTorch, onnxruntime or cryptography wheels) — see DECISIONS "P1
ingestion decisions".

During P1 the owner clarified: don't just shelve the old Node pipeline —
integrate it; keep **both** no-LLM/offline and LLM/cloud modes; train the
own model from online model APIs; and never delete old context directly.
Docs that had been rewritten wholesale earlier the same day (`CLAUDE.md`,
`docs/ARCHITECTURE.md`) had their original text restored verbatim, and the
integration conflicts were written up in DECISIONS "Open conflicts to plan".
