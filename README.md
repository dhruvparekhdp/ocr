# PDF Batch Classifier

A Node.js document-processing tool that reads text-based PDFs from a folder,
classifies each one as **PO**, **Invoice**, **AWB_BL** (Air Waybill / Bill of
Lading) or **Shipping Bill**, extracts the key identifiers (Invoice Number /
PO Number), and segregates related documents into batches.

## How batching works

- **Invoices anchor the batches.** An invoice carries both its own
  `invoiceNumber` and a `poNumber` reference, so each distinct invoice number
  opens a batch.
- **AWB/BL and Shipping Bill** documents join their batch through the
  `invoiceNumber` printed on them.
- **PO documents** have no invoice number — they join through the
  `poNumber` reference found on the batch's invoice.
- **Orphans** (documents whose counterpart is missing) land in a dedicated
  `unbatched` section, grouped by whichever identifier they do carry
  (`INV:<number>`, `PO:<number>`, or `UNIDENTIFIED`).

## Classification engine: three interchangeable backends

Documents are classified by one of three interchangeable analyzers, chosen
once per run via the `CLASSIFIER` env var (never mixed within a report):

| `CLASSIFIER=` | Backend | Requires |
| --- | --- | --- |
| `llm` (default when credentials present) | Claude, via structured outputs (`llmClassifier.js`) | `ANTHROPIC_API_KEY` / `ant auth login` |
| `local` | Your own fine-tuned model, served locally (`localClassifier.js` → `local-llm/serve.py`) | A running `local-llm/serve.py`; see below |
| `regex` (fallback when no credentials) | Keyword/regex matching (`analyzeText` in `index.js`) | Nothing — offline, free |

```bash
CLASSIFIER=llm   node index.js ./pdfs   # Claude — error out per-file if no credentials, rather than silently falling back
CLASSIFIER=local node index.js ./pdfs   # your fine-tuned model — see "Training your own local model" below
CLASSIFIER=regex node index.js ./pdfs   # keyword/regex — free, offline, fastest, least accurate
```

Leaving `CLASSIFIER` unset auto-picks `llm` if Anthropic credentials are
configured, else `regex` with a one-time warning. `local` is never chosen
automatically — there's no reliable way to detect a running local server
without an extra network probe, so it's opt-in only.

### Why not keyword regex alone

Four real export documents (Commercial Invoice, Bill of Lading, Shipping Bill,
Proforma Invoice) exposed exactly the failure modes regex can't generalise
past:
- Generic shipment fields ("Consignee", "Port of Loading") and glossary text
  ("P.O. - Purchase Order") appear on *every* document type in real customs
  paperwork, not just their nominal owner — regex weights need constant
  re-tuning as new templates arrive.
- A Proforma Invoice/Packing List can function as the PO-equivalent anchor
  document without ever containing the words "Purchase Order".
- Multi-column customs EDI printouts flatten into linear text where a label
  lands next to an unrelated column number (e.g. "2.INVOICE NO 3.INVOICE
  AMOUNT" reads as "INVOICE NO" → "3"), or a value lands nowhere near its
  label at all.

The regex path (kept as `analyzeText`) still handles all of this reasonably
well after tuning against those four documents (see `CLASSIFICATION_RULES`,
`INVOICE_NUMBER_PATTERNS`, `PO_NUMBER_PATTERNS` in `index.js`) — but every new
document family found in the wild would mean another round of pattern
surgery. The LLM path generalises to new templates without any code changes.

## Training your own local model

Everything under `local-llm/` fine-tunes a small open-weight model on your
own labeled documents and serves it locally — no data or inference ever
leaves your machine, and no Anthropic API calls are made once training data
is prepared. It's a LoRA fine-tune (a small adapter on top of a frozen base
model), not training from scratch — a full LLM needs vastly more data and
compute than a document-classification project can supply, while LoRA works
with a few hundred labeled examples and trains in a reasonable time on a
single consumer GPU (or slower on CPU/Apple Silicon).

The fine-tuned model is trained to produce the exact same output shape as
the Claude classifier — `{ documentType, invoiceNumber, poNumber }` — so once
it's served locally, it's a drop-in swap: `CLASSIFIER=local` instead of
`CLASSIFIER=llm`, with everything else in the pipeline (PDF extraction,
batching, the web UI) unchanged.

### 1. Extract text from your labeled PDFs

Reuses the app's own PDF extraction (pdf-parse) so training data matches
exactly what the model will see at inference time — labeling against a
different extraction path would train it on a distribution it never
actually encounters when served:

```bash
node scripts/extract-text.js ./my_labeled_pdfs ./local-llm/data/texts
```

Writes one `.txt` file per PDF (same basename) into the output directory.

### 2. Write your labels

One JSON object per line in a `labels.jsonl` file — `fileName` must match
the `.txt` basename from step 1 (no extension):

```jsonl
{"fileName": "invoice_047", "documentType": "Invoice", "invoiceNumber": "EXP/25-26/409", "poNumber": "PXP/25-26/4"}
{"fileName": "po_047", "documentType": "PO", "invoiceNumber": null, "poNumber": "PXP/25-26/4"}
```

See `local-llm/data/labels.template.jsonl` for a fuller worked example.
`documentType` must be one of `PO`, `Invoice`, `AWB_BL`, `Shipping Bill`,
`Unknown`. As a rough guide: a few hundred examples spread across all four
types will meaningfully outperform the regex fallback; below ~50-100 per
type, expect shaky results — more labeled data matters more than any
hyperparameter tuning at this stage.

### 3. Set up the Python environment

```bash
cd local-llm
python3 -m venv venv && source venv/bin/activate   # optional but recommended
pip install -r requirements.txt
```

Requires internet access on first run only, to download the base model from
Hugging Face (cached locally afterward — every step from here on is fully
offline).

### 4. Build the training dataset

```bash
python3 prepare_dataset.py \
  --texts-dir ./data/texts \
  --labels ./data/labels.jsonl \
  --out-dir ./data
```

Writes `data/train.jsonl` and `data/val.jsonl` (90/10 split by default,
`--val-split` to change it).

### 5. Fine-tune

```bash
python3 train.py \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --train-file ./data/train.jsonl \
  --val-file ./data/val.jsonl \
  --output-dir ./checkpoints/run1
```

Defaults to `Qwen/Qwen2.5-0.5B-Instruct` — small enough to fine-tune on CPU
(slowly) or any GPU. If you have more capable hardware, a larger instruct
model (e.g. `Qwen/Qwen2.5-1.5B-Instruct`, `Llama-3.2-3B-Instruct`) will
likely classify more accurately — pass it via `--base-model`. Key flags:
`--epochs`, `--lr`, `--lora-r`/`--lora-alpha` (LoRA rank/scale),
`--batch-size`/`--grad-accum` (raise `--batch-size` if you have GPU memory
to spare; the default of 1 + 8-way gradient accumulation is tuned for
low-memory setups). Runs on CUDA, Apple Silicon (MPS), or CPU automatically.
Gradient checkpointing is on by default (trades some speed for much lower
memory use — disable with `--no-gradient-checkpointing` only if you have
VRAM to spare). Precision auto-selects fp16 on GPUs without bf16 tensor-core
support (anything older than RTX 30-series) and bf16 on newer ones.

> **On a 4GB-VRAM GPU** (e.g. a laptop GTX card): stick with the
> `Qwen2.5-0.5B-Instruct` default — it fits comfortably with gradient
> checkpointing on, at the default batch size of 1. If accuracy isn't good
> enough once you have real training data and want to try a larger model
> (1.5B–3B), add `--load-in-4bit` (QLoRA) — it quantizes the frozen base
> model to 4-bit so a bigger model fits in the same VRAM budget, at some cost
> to training speed. Requires `pip install bitsandbytes` and an NVIDIA GPU
> (uncomment the line in `requirements.txt`).

### 6. Serve it locally

```bash
python3 serve.py --base-model Qwen/Qwen2.5-0.5B-Instruct --adapter ./checkpoints/run1 --port 8008
```

Exposes `POST /classify { "text": "..." }` → `{ documentType, invoiceNumber,
poNumber }`, plus `GET /health`. Runs entirely locally; no network calls.
Pass `--load-in-4bit` here too if you trained with it — serving needs to
load the base model the same way training did.

### 7. Point the Node app at it

```bash
CLASSIFIER=local node index.js ./pdfs
# or, if serve.py is on a different host/port:
CLASSIFIER=local LOCAL_LLM_URL=http://127.0.0.1:8008 node index.js ./pdfs
```

Same for the web UI: `CLASSIFIER=local npm run web`.

### Files

| File | Purpose |
| --- | --- |
| `local-llm/prompt.py` | Shared prompt/schema definition — used identically by dataset prep and serving, so training and inference never drift apart. |
| `local-llm/hardware.py` | Shared device/precision selection (fp16 vs bf16 vs CPU) — used identically by `train.py` and `serve.py` so they always agree on how the model was loaded. |
| `local-llm/prepare_dataset.py` | Merges extracted text + labels into training-ready JSONL, with train/val split. |
| `local-llm/train.py` | LoRA fine-tune via `transformers` + `peft`. Masks the loss to the JSON completion only (not the prompt), so training signal isn't diluted by the instruction text. |
| `local-llm/serve.py` | FastAPI server: loads base model + adapter, exposes `/classify`. Extracts the first `{...}` span from generation output rather than assuming the whole response is valid JSON, since generation can add stray whitespace. |
| `localClassifier.js` | Node-side HTTP client for `serve.py`, matching `llmClassifier.js`'s interface exactly. |

## Requirements

- Node.js >= 18
- Dependencies: [`pdf-parse`](https://www.npmjs.com/package/pdf-parse) **v2.x**, [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk)
- Only if using `CLASSIFIER=local`: Python 3.10+ with `local-llm/requirements.txt` installed (see "Training your own local model" above)

> **Why pdf-parse v2?** The legacy v1.x line bundles 2017-era pdf.js builds
> that leak global state on modern Node — after the first document, parses
> fail nondeterministically with `bad XRef entry`. v2 is a maintained rewrite
> on current pdf.js and parses reliably (verified in this repo's test run).

## Usage

```bash
npm install

# Classify PDFs (defaults: ./pdfs → ./batches.json)
node index.js [pdfDirectory] [outputFile]

# e.g.
node index.js ./my_documents ./report.json
```

### Bulk upload via web page

Start the server and open the bulk uploader in a browser:

```bash
npm run web              # http://localhost:3000 (or PORT=xxxx npm run web)
```

Drag-and-drop (or click to browse) up to 200 PDFs at once — nothing is
written to disk, files are classified and batched entirely in memory for
that request, and the page renders the same `batches` / `unbatched` /
`errors` breakdown described below. The upload also exposes a plain JSON
API:

```
POST /api/classify   (multipart/form-data, field name: "documents")
```

### End-to-end smoke test

Generates 10 sample PDFs (two complete batches + orphan cases) and runs the
classifier over them:

```bash
npm test
```

## Output shape

```jsonc
{
  "generatedAt": "…",
  "sourceDirectory": "…",
  "summary": { "totalPdfs": 10, "analyzed": 10, "failed": 0, "batches": 2, "unbatchedGroups": 3 },
  "batches": {
    "BATCH-INV-2024-001": {
      "invoiceNumber": "INV-2024-001",
      "poNumber": "PO-7788",
      "fileCount": 4,
      "documents": [
        { "fileName": "invoice_001.pdf", "documentType": "Invoice" },
        { "fileName": "awb_001.pdf", "documentType": "AWB_BL" },
        { "fileName": "po_7788.pdf", "documentType": "PO" },
        { "fileName": "sb_001.pdf", "documentType": "Shipping Bill" }
      ]
    }
  },
  "unbatched": {
    "INV:INV-2024-999": [ { "fileName": "awb_orphan.pdf", "documentType": "AWB_BL", "…": "…" } ],
    "PO:PO-0000":       [ { "fileName": "po_orphan.pdf", "documentType": "PO", "…": "…" } ],
    "UNIDENTIFIED":     [ { "fileName": "random_note.pdf", "documentType": "Unknown", "…": "…" } ]
  },
  "errors": [] // PDFs that failed to parse: { fileName, reason }
}
```

## Classification & extraction rules

**The LLM path** (`llmClassifier.js`, used whenever Anthropic credentials are
configured) sends each document's text to Claude with a system prompt
describing the four document types and the invoice/PO identifier semantics,
and a JSON schema (`output_config.format`) that constrains the response to
`{ documentType, invoiceNumber, poNumber }`. There are no keywords or regexes
to tune — see the prompt in `llmClassifier.js` for the exact rules Claude is
given.

**The regex fallback** (`analyzeText` in `index.js`, used without
credentials or with `CLASSIFIER=regex`) works as follows:

- **Classification** is keyword-scored per type (weighted, case-insensitive
  regex): unambiguous phrases like "Air Waybill" or "Tax Invoice" outweigh
  generic ones like "Consignee" or "PO No" that appear on several document
  types. Highest score wins; no hits → `Unknown`.
  - Real Indian export/customs paperwork puts shipment fields (`Consignee`,
    `Port of Loading`) and glossary blurbs (`P.O. - Purchase Order`) on
    *every* document type, not just the one they nominally belong to — those
    are weighted low (weak supporting evidence) so the phrases that actually
    name the document ("Commercial Invoice", "Shipping Bill") win outright.
  - `Proforma Invoice` / `Packing List` classify as `PO` — in many export
    workflows the proforma invoice is the anchor document a purchase order
    would otherwise be (referenced by the commercial invoice's own PO/
    reference field), even though it's not literally titled "Purchase Order".
- **Invoice number**: labels `Invoice Number`, `Invoice No.`, `Inv No`,
  `Inv #`, `Invoice#` followed by an alphanumeric ID (must contain a digit).
- **PO number**: labels `Purchase Order`, `PO No`, `PO #`, `P.O. Number`,
  `PO Ref`, `Reference (PXP)` followed by an alphanumeric ID.
- **Fiscal-reference fallback**: when no label match is found, both
  extractors fall back to the bare `PREFIX/YY-YY/NNN` reference format common
  in Indian export docs (e.g. `EXP/25-26/409` for an export invoice,
  `PXP/25-26/4` for a proforma/purchase reference) — needed because
  multi-column customs forms (shipping-bill EDI printouts) flatten into
  linear text where a value can land far from, or even before, its label.
- **Short-capture guard**: any candidate identifier under 4 characters is
  rejected and extraction keeps searching. Tabular forms often place a label
  right next to an unrelated column number (e.g. "2.INVOICE NO 3.INVOICE
  AMOUNT" reads as "INVOICE NO" → "3"), and this filters that out.
- Identifiers are normalised to uppercase so `inv-2024/001` and
  `INV-2024/001` batch together.

## Architecture

| Piece | Responsibility |
| --- | --- |
| `docTypes.js` | Shared `DOC_TYPES` constants used by every classifier and the batching logic. |
| `llmClassifier.js` | `classifyWithLLM(rawText)` — Claude classifier via structured outputs. |
| `localClassifier.js` | `classifyWithLocalLLM(rawText)` — HTTP client for your self-hosted fine-tuned model (`local-llm/serve.py`). |
| `analyzeText(rawText)` (in `index.js`) | Regex fallback classifier; returns `{ documentType, invoiceNumber, poNumber }`. |
| `resolveAnalyzer()` (in `index.js`) | Picks the analyzer once per run per the `CLASSIFIER` env var / credential presence described above. |
| `extractTextFromPdf(filePath)` | Reads one PDF and extracts raw text via pdf-parse. |
| `scripts/extract-text.js` | Dumps raw extracted text for a directory of PDFs — used to build local-model training data from the same extraction path the app uses at inference time. |
| `processDirectory(dirPath)` | Parses all PDFs in a directory with bounded concurrency (8 regex / 5 Claude / 2 local); per-file failures are collected, never fatal. |
| `processBuffers(files)` | Same as above but for in-memory `{ fileName, buffer }` pairs — used by the web upload endpoint. |
| `segregateIntoBatches(analyzedDocs)` | Builds `{ batches, unbatched }` per the anchoring rules above. |
| `server.js` | Express server: serves `public/index.html` and `POST /api/classify` (multipart upload, in-memory only). |
| `public/index.html` | Single-page bulk uploader — drag/drop, progress bar, and a rendered batches/orphans/errors view. |
| `scripts/generate-samples.js` | Dev-only sample PDF generator (pdfkit) for the smoke test. |
| `local-llm/` | Fine-tuning pipeline for your own local model — see "Training your own local model" above. |

All analysis functions are exported, so they can be unit-tested or reused
without touching the filesystem.
