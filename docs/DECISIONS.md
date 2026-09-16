# Decisions

A record of non-obvious choices and the reasoning behind them, including
approaches that were considered and deliberately rejected. The point of this
file is to stop a future session (human or Claude) from re-litigating a
question that was already answered, or re-trying something that was already
tried and found wanting.

## No cloud, no LLM, no trained ML model (current state)

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

## Docling — considered, not adopted (yet)

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

## OCR preprocessing: median filter + Otsu, not deskew

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

## Rasterization uses `pdf-parse`'s own `getScreenshot`, not a second library

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
