# Document Classifier — White-Label

A Node.js document-processing tool that reads text-based PDFs from a folder,
classifies each one against a **configurable** set of document types,
extracts a **configurable** set of fields, and segregates related documents
into batches. "White-label" means one corporate client's deployment can be
tuned to invoices + purchase orders, another's to bills + transaction
records + receipts, and another's to something else entirely — all with
the same code, by editing one file: `config/schema.json`. See
"White-label configuration" below.

## How batching works

Batching is driven by whichever fields are marked `"isBatchKey": true` in
`config/schema.json` (by default: `documentNumber` and `referenceNumber`) —
not by any hardcoded document-type relationship:

- Two documents land in the same batch if they **share a non-null value in
  any batch-key field** — e.g. an Invoice and the Purchase Order it
  references share a `referenceNumber`; an Invoice and its related transport
  document could share a `documentNumber`. This is computed as a union-find
  over shared field values (`segregateIntoBatches` in `index.js`), so it
  works for whatever document types and relationships a client's schema
  defines, without the batching code needing to know what those types mean.
- **Orphans** (documents that don't share a batch-key value with anything
  else) land in a dedicated `unbatched` section, grouped by whichever
  batch-key field they do carry a value for (`documentNumber:<value>`,
  `referenceNumber:<value>`, or `UNIDENTIFIED` if none).

## White-label configuration

Everything client-specific lives in **`config/schema.json`** (loaded once
per process by `schema.js`; override the path with `SCHEMA_PATH`). Onboard
a new corporate client, or add a document type an existing client starts
sending, by editing this one file — no code changes:

```jsonc
{
  "productName": "Acme Docs",        // shown in the web UI's title/header
  "primaryColor": "#4f8cff",         // accent color (any CSS color)
  "logoUrl": null,                   // optional logo image URL

  "documentTypes": [
    {
      "name": "Invoice",
      "description": "...",          // tells the LLM what this type means
      "keywords": ["Tax Invoice", "Invoice To", "..."], // regex-fallback classification hints
      "keywordWeight": 5             // regex-fallback: how strongly these keywords indicate this type
    }
    // ...more types. Always include an "Unknown" type as a catch-all.
  ],

  "fields": [
    {
      "name": "documentNumber",      // becomes a key in every document's "fields" object
      "description": "...",          // tells the LLM what to look for
      "labels": ["Invoice No", "Receipt No", "..."], // regex-fallback: label text to search for
      "appliesTo": ["Invoice", "Receipt"],            // which document types this field is extracted for
      "isBatchKey": true              // whether documents sharing this value should be batched together
    }
    // ...more fields
  ]
}
```

**This takes effect differently depending on which classifier backend is
active** (see below):

- **Claude (`CLASSIFIER=llm`, the default with credentials configured)**
  adapts to a schema change on the very next request — the system prompt
  and structured-output JSON schema are built dynamically from
  `config/schema.json` every time (`llmClassifier.js`). No retraining, no
  redeploy beyond editing the file.
- **The regex fallback (`CLASSIFIER=regex`)** also reads the schema
  dynamically (`index.js`) — classification keywords and field-label
  patterns are built from the config, not hardcoded — but being regex, it's
  inherently weaker at generalizing across varied real-world phrasing than
  Claude is. See "Why not keyword regex alone" below.
- **Local fine-tuned models (`CLASSIFIER=local`)** do **not** adapt
  automatically — a trained model's document types and field/tag set are
  baked in at training time. Changing `config/schema.json` requires
  retraining before a local model's output matches the new schema. This is
  an inherent tradeoff of neural nets versus a general-purpose LLM, not a
  bug — see "Training your own local model" below.

The web UI reads branding and the field/type list from `GET /api/config`
on load, so it reflects whatever schema is active without any HTML changes.

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

Everything under `local-llm/` trains a model on your own labeled documents
and serves it locally — no data or inference ever leaves your machine, and
no Anthropic API calls are made once training data is prepared. There are
two options, both producing a server with the exact same `POST /classify`
contract (`{ documentType, fields }`), so either one is a drop-in swap via
`CLASSIFIER=local` — the Node app, `localClassifier.js`, and the web UI
don't know or care which one is running underneath.

> ⚠️ **Known gap:** unlike `llmClassifier.js` and the regex fallback, the
> `local-llm/` pipelines do **not** yet read `config/schema.json` — their
> document types and fields (currently `invoiceNumber`/`poNumber`) are
> still defined directly in their own Python files (`local-llm/prompt.py`,
> `local-llm/scratch/labels.py`). If your client's schema differs from that
> default, either adapt those two files' constants to match your schema
> before training, or treat `CLASSIFIER=llm`/`regex` as the schema-aware
> paths for now and revisit local-model schema-awareness later. This is a
> real limitation to be upfront about, not a hidden one — the Claude path
> is the one built for varying document types across clients today.

| | `local-llm/` (LoRA fine-tune) | `local-llm/scratch/` (from scratch) |
| --- | --- | --- |
| Base | Fine-tunes a small pretrained model (`Qwen2.5-0.5B-Instruct` by default) | No pretrained weights at all — random init, your own tokenizer, your own architecture (`model.py`) |
| Dependencies | `transformers`, `peft`, `accelerate`, (optionally `bitsandbytes` for QLoRA) | Just `torch` + `tokenizers` — no Hugging Face Hub model downloads, ever |
| Labeled data needed | A few hundred examples can work, since the base model already understands language | Low thousands recommended — the model learns everything, including "what text looks like," from your data alone |
| How extraction works | The model generates the identifier as free text (JSON completion) | A BIO tagging head points at which tokens are the identifier; the exact substring is recovered via tokenizer offsets — easier to learn from scratch than free-text generation |
| Best for | Faster to get working accurately with less labeled data | No dependency on any third-party model/weights whatsoever |

Steps 1–2 below (extracting text, writing labels) are shared by both paths.
Steps 3+ diverge — pick one.

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

### Option A: LoRA fine-tune (Qwen)

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

### Option B: From scratch — no Qwen, no QLoRA, no Hugging Face Hub

Everything under `local-llm/scratch/` trains its own model from random
weights: your own BPE tokenizer, a small transformer encoder defined in
`model.py` (not downloaded from anywhere), with two heads on one shared
encoder — a classification head for `documentType`, and a **BIO
token-tagging head** for `invoiceNumber`/`poNumber`. Extraction is framed as
tagging (which tokens are part of the identifier), not free-text generation
— a from-scratch model has no pretrained ability to "copy text out of
context," so tagging is a far more learnable task for it. The exact
identifier substring is recovered afterward via the tokenizer's character
offsets. The only dependencies are `torch`, `tokenizers`, and `fastapi`/
`uvicorn` for serving — see `local-llm/scratch/requirements.txt`.

```bash
cd local-llm/scratch
pip install -r requirements.txt
```

**1. Train your own tokenizer** (on the same extracted `.txt` files from
step 1 above — more text improves vocabulary coverage, even unlabeled text
from documents you haven't labeled yet helps here):

```bash
python3 train_tokenizer.py --texts-dir ../data/texts --vocab-size 8000 --output-dir ./tokenizer
```

**2. Build the training dataset** (uses the same `labels.jsonl` format as
Option A):

```bash
python3 prepare_dataset.py \
  --texts-dir ../data/texts \
  --labels ../data/labels.jsonl \
  --tokenizer ./tokenizer/tokenizer.json \
  --out-dir ./data
```

Watch the output for `invoiceNumber`/`poNumber` "not found verbatim"
warnings — since extraction is trained by locating the exact identifier
string inside the extracted text, a label that doesn't match the text
character-for-character (whitespace differences, transcription typos)
silently contributes no extraction signal for that example.

**3. Train:**

```bash
python3 train.py \
  --tokenizer ./tokenizer/tokenizer.json \
  --train-file ./data/train.jsonl \
  --val-file ./data/val.jsonl \
  --output-dir ./checkpoints/run1
```

Reports `doc_type_accuracy` and exact-match rate for each identifier every
epoch — these are the metrics that actually matter end-to-end, not just
loss. Default model size (~embed-dim 256, 4 layers) is small enough to train
at a reasonable pace even on CPU, since there's no pretraining phase — the
whole training cost is your labeled dataset. Key flags: `--epochs`, `--lr`,
`--embed-dim`/`--num-layers`/`--num-heads`/`--ff-dim` (model size),
`--tag-loss-weight` (balance between classification and extraction loss if
one is lagging the other).

**4. Serve and point the Node app at it** — identical to Option A from here:

```bash
python3 serve.py --model-dir ./checkpoints/run1 --port 8008
# then, from the project root:
CLASSIFIER=local node index.js ./pdfs
```

#### Files

| File | Purpose |
| --- | --- |
| `local-llm/scratch/labels.py` | Shared label scheme (`DOC_TYPES`, BIO `TAGS`) plus the span↔tag conversion used identically by dataset prep and serving. |
| `local-llm/scratch/model.py` | The from-scratch model: embedding + sinusoidal positional encoding + `nn.TransformerEncoder`, with masked mean-pooling for classification and per-token logits for tagging. |
| `local-llm/scratch/train_tokenizer.py` | Trains a byte-level BPE tokenizer on your own text corpus via the standalone `tokenizers` library. |
| `local-llm/scratch/prepare_dataset.py` | Converts labels into token ids + BIO tag ids by locating each identifier substring in the extracted text and tagging the tokens it overlaps. |
| `local-llm/scratch/train.py` | Multi-task training loop (classification + tagging loss), hand-rolled warmup/decay schedule — no `transformers` Trainer. |
| `local-llm/scratch/serve.py` | FastAPI server with the same `/classify` contract as Option A's `serve.py`. |

## Requirements

- Node.js >= 18
- Dependencies: [`pdf-parse`](https://www.npmjs.com/package/pdf-parse) **v2.x**, [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk)
- Only if using `CLASSIFIER=local`: Python 3.10+, with either `local-llm/requirements.txt` (LoRA/Qwen) or `local-llm/scratch/requirements.txt` (from scratch) installed — see "Training your own local model" above

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

# Use a different client's schema/branding (defaults to ./config/schema.json)
SCHEMA_PATH=./config/acme-corp.schema.json node index.js ./my_documents ./report.json
```

To onboard a new corporate client, copy `config/schema.json` to e.g.
`config/<client>.schema.json`, edit its document types/fields/branding, and
point `SCHEMA_PATH` at it — no code changes required (Claude and regex
paths; see the local-model gap noted above).

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

Per-document analysis always has the shape `{ fileName, documentType, fields }`,
where `fields` has one key per field configured in `config/schema.json`
(default schema shown below):

```jsonc
{
  "generatedAt": "…",
  "sourceDirectory": "…",
  "summary": { "totalPdfs": 6, "analyzed": 6, "failed": 0, "batches": 1, "unbatchedGroups": 4 },
  "batches": {
    "BATCH-INV-2024-001": {
      "documentNumber": "INV-2024-001",
      "referenceNumber": "PO-7788",
      "fileCount": 2,
      "documents": [
        { "fileName": "invoice_001.pdf", "documentType": "Invoice" },
        { "fileName": "po_7788.pdf", "documentType": "Purchase Order" }
      ]
    }
  },
  "unbatched": {
    "documentNumber:TXN-88213": [
      { "fileName": "transaction_001.pdf", "documentType": "Transaction Record",
        "fields": { "documentNumber": "TXN-88213", "referenceNumber": null, "date": "2024-06-15", "amount": null } }
    ],
    "UNIDENTIFIED": [
      { "fileName": "random_note.pdf", "documentType": "Unknown",
        "fields": { "documentNumber": null, "referenceNumber": null, "date": null, "amount": null } }
    ]
  },
  "errors": [] // PDFs that failed to parse: { fileName, reason }
}
```

## Classification & extraction rules

**The LLM path** (`llmClassifier.js`, used whenever Anthropic credentials
are configured) sends each document's text to Claude with a system prompt
built from `config/schema.json` — listing every configured document type
and every field with its description and which types it applies to — and a
JSON schema (`output_config.format`) that constrains the response to
`{ documentType, fields: { ...one key per configured field... } }`. There
are no keywords or regexes to tune; edit the schema, not the code.

**The regex fallback** (`analyzeText` in `index.js`, used without
credentials or with `CLASSIFIER=regex`) is also schema-driven, but
inherently weaker at generalizing — this is *why* the LLM path is the
default:

- **Classification** is keyword-scored per type (weighted, case-insensitive
  regex), using each type's `keywords` / `keywordWeight` from the schema.
  Highest score wins; no hits → whichever type is named `"Unknown"`.
  - Real-world documents put generic fields (shipment details, glossary
    blurbs, boilerplate) on *every* document type, not just the one they
    nominally belong to — this is why `keywordWeight` exists: give
    unambiguous phrases ("Tax Invoice") a high weight and generic
    supporting phrases a low one, so the true type wins outright. This
    needed real tuning against genuine documents (see git history for the
    original case study against real Indian export/customs paperwork) and
    will likely need retuning for a very different document domain.
- **Field extraction**: for each field, tries every configured `labels`
  phrase as a label-adjacent pattern (`"Invoice No: <value>"`), in order,
  before falling back to a generic `PREFIX/YY-YY/NNN` fiscal-reference
  format (common in Indian trade docs, e.g. `EXP/25-26/409`) with no label
  needed at all — useful on multi-column forms where a value lands far from
  its label.
- **Short-capture guard**: any candidate value under 4 characters is
  rejected and extraction keeps searching. Tabular forms often place a
  label right next to an unrelated column number (e.g. "2.INVOICE NO
  3.INVOICE AMOUNT" reads as "INVOICE NO" → "3"), and this filters that out.
- Extracted values are normalised to uppercase so `inv-2024/001` and
  `INV-2024/001` batch together as the same value.

## Architecture

| Piece | Responsibility |
| --- | --- |
| `config/schema.json` | The white-label config: branding, document types, fields, batch keys. Single source of truth — see "White-label configuration" above. |
| `schema.js` | Loads and memoizes `config/schema.json`; exports getters (`getDocumentTypeNames`, `getFieldsForType`, `getBatchKeyFields`, `getBranding`, etc.) used by every other piece below. |
| `llmClassifier.js` | `classifyWithLLM(rawText)` — Claude classifier; builds its system prompt and structured-output schema dynamically from `schema.js`. |
| `localClassifier.js` | `classifyWithLocalLLM(rawText)` — HTTP client for your self-hosted fine-tuned model (`local-llm/serve.py`). |
| `analyzeText(rawText)` (in `index.js`) | Regex fallback classifier, also schema-driven; returns `{ documentType, fields }`. |
| `resolveAnalyzer()` (in `index.js`) | Picks the analyzer once per run per the `CLASSIFIER` env var / credential presence described above. |
| `extractTextFromPdf(filePath)` | Reads one PDF and extracts raw text via pdf-parse. |
| `scripts/extract-text.js` | Dumps raw extracted text for a directory of PDFs — used to build local-model training data from the same extraction path the app uses at inference time. |
| `processDirectory(dirPath)` | Parses all PDFs in a directory with bounded concurrency (8 regex / 5 Claude / 2 local); per-file failures are collected, never fatal. |
| `processBuffers(files)` | Same as above but for in-memory `{ fileName, buffer }` pairs — used by the web upload endpoint. |
| `segregateIntoBatches(analyzedDocs)` | Union-find over configured batch-key fields — see "How batching works" above. |
| `server.js` | Express server: serves `public/index.html`, `GET /api/config` (branding + schema for the UI), and `POST /api/classify` (multipart upload, in-memory only). |
| `public/index.html` | Single-page bulk uploader — drag/drop, progress bar, dynamic field/type rendering, and branding fetched from `/api/config`. |
| `scripts/generate-samples.js` | Dev-only sample PDF generator (pdfkit) for the smoke test — matches the default `config/schema.json`. |
| `local-llm/` | Fine-tuning pipeline for your own local model — see "Training your own local model" above. **Targets its own fixed document types/fields independently of `config/schema.json`** — see the note there. |

All analysis functions are exported, so they can be unit-tested or reused
without touching the filesystem.
