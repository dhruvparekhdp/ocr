# CLAUDE.md

This file is read automatically at the start of every Claude Code session in
this repository. It exists so a session with no memory of earlier
conversations can pick up full context from the codebase alone.

## Primary rule

**Every decision, piece of context, and rationale that matters for working on
this project belongs in the codebase, not only in a chat transcript.**
Chat history is not durable — it is not visible to the next session, the next
contributor, or the next person who clones this repo. When you make an
architectural decision, reject an approach, discover a real bug, or learn
something non-obvious about how a piece of this system behaves, write it
down in the relevant file:

- **Code-level rationale** (why this regex, why this library, why this order
  of operations) → a comment in the file itself, next to the code it explains.
- **Cross-cutting design decisions** (why a whole approach was chosen or
  rejected) → `docs/DECISIONS.md`.
- **How the system fits together today** → `docs/ARCHITECTURE.md`.
- **How the project got here / what changed and why** → `docs/HISTORY.md`.
- **User-facing behavior, setup, roadmap, and known limitations** → `README.md`.

Do not let a significant decision exist only as something said in
conversation. If you are about to explain a "why" to the user that isn't
already written down somewhere in the repo, that is a signal to also write
it into one of the files above before moving on.

## Orientation

**Product goal:** a white-label AI document analyser for finance documents
(PDFs, scans, photos, Excel/CSV) that the owner can sell to clients or run as
a service. Global documents, English first.

**Current code:** a Python backend in `backend/` (FastAPI, SQLAlchemy,
multi-tenant). The previous Node.js prototype is in `legacy/` for reference
only — do not extend it. Read, in order:

1. `README.md` — roadmap (phases P0–P5), setup, API, eval workflow.
2. `docs/ARCHITECTURE.md` — how the backend fits together today.
3. `docs/DECISIONS.md` — why it looks this way, including superseded
   decisions and rejected approaches.
4. `docs/HISTORY.md` — the project pivoted many times; this explains why, so
   old approaches aren't reintroduced by accident.

## Working conventions for this repo

- **Two modes, both first-class (since 2026-09-16).** An **offline mode**
  (local OCR + rule-based extraction, no network — the earlier project's
  approach, being ported from `legacy/`) and an **LLM mode** (Groq for now).
  The owner's own model is trained from online model API outputs
  (distillation) because there's no local GPU; once good enough it runs
  offline. Keep every LLM call behind a provider interface. See
  `docs/DECISIONS.md` → "Dual mode".
- **Never delete old context directly.** Mark it superseded/revised, keep the
  text, and list conflicts in `docs/DECISIONS.md` → "Open conflicts to plan"
  for the owner to decide.
- **Commercial licences only.** This is sold commercially. Every dependency,
  model weight, and dataset must permit commercial use (MIT/Apache/BSD etc.).
  No AGPL (e.g. PyMuPDF), no non-commercial model licences, no
  non-commercial datasets. Check before adding anything.
- **Multi-tenant everywhere.** Every row, file, and query is scoped to a
  tenant. A tenant must never be able to read or infer another tenant's data.
  Add a cross-tenant test for any new endpoint.
- **Schema-driven stays schema-driven.** Document types, fields, and branding
  come from `config/schema.json` (or a tenant's own schema). Don't hardcode a
  document type or field name in pipeline code or UI.
- **Measure, don't assume.** Accuracy claims are checked against the labelled
  eval set (`docai-eval`) or a reproducible test, not asserted. Note briefly
  how a claim was verified when it isn't obvious from the code.
- **Hardware reality.** Dev machine is an Intel (x86_64) Mac with 8 GB RAM, no
  GPU, no Docker. Prefer CPU-friendly dependencies with x86_64 macOS wheels;
  heavy training happens on free cloud notebooks, not locally.
- **Be honest about limitations in writing.** Keep README's limitations
  current when you find a gap.

## Commands

```bash
cd backend
uv sync
uv run pytest
uv run ruff check . && uv run ruff format .
uv run alembic upgrade head
uv run uvicorn docai.main:app --reload
```

## Earlier context (Node era) — kept verbatim, not deleted

Project rule from the owner (2026-09-16): old context is never removed
directly. Where it conflicts with the current direction, the conflict is
listed in `docs/DECISIONS.md` → "Open conflicts to plan" and resolved with the
owner. Current status of the conventions below:

- *No cloud / no LLM / no model* → **revised, not dropped**: the product keeps
  an offline no-LLM mode **and** an LLM/cloud mode (see DECISIONS "Dual
  mode").
- *Schema-driven* → still in force (schema v2).
- *Verify claims* and *be honest about limitations* → still in force.

The text below is the CLAUDE.md written by the earlier session, unchanged:


This file is read automatically at the start of every Claude Code session in
this repository. It exists so a session with no memory of earlier
conversations can pick up full context from the codebase alone.

### Primary rule

**Every decision, piece of context, and rationale that matters for working on
this project belongs in the codebase, not only in a chat transcript.**
Chat history is not durable — it is not visible to the next session, the next
contributor, or the next person who clones this repo. When you make an
architectural decision, reject an approach, discover a real bug, or learn
something non-obvious about how a piece of this system behaves, write it
down in the relevant file:

- **Code-level rationale** (why this regex, why this library, why this order
  of operations) → a comment in the file itself, next to the code it explains.
- **Cross-cutting design decisions** (why a whole approach was chosen or
  rejected) → `docs/DECISIONS.md`.
- **How the system fits together today** → `docs/ARCHITECTURE.md`.
- **How the project got here / what changed and why** → `docs/HISTORY.md`.
- **User-facing behavior, setup, and known limitations** → `README.md`.

Do not let a significant decision exist only as something said in
conversation. If you are about to explain a "why" to the user that isn't
already written down somewhere in the repo, that is a signal to also write
it into one of the files above before moving on.

### Orientation

This is a self-contained document classifier: PDF → text (embedded, or
offline OCR for scans) → classify + extract fields (from-scratch heuristics,
no ML model, no LLM, no cloud call) → batch related documents. Read, in
order:

1. `README.md` — what it does, how to run it, what it extracts, and its
   honestly-documented limitations.
2. `docs/ARCHITECTURE.md` — the pipeline and every module's responsibility.
3. `docs/DECISIONS.md` — why the system looks the way it does, including
   approaches that were deliberately rejected.
4. `docs/HISTORY.md` — the project went through several complete pivots
   (keyword regex → LLM-based → locally fine-tuned models → fully
   self-contained heuristics). This explains why, so old approaches aren't
   accidentally reintroduced without knowing they were already tried.

### Working conventions for this repo

- **No cloud calls, no LLM, no trained ML model.** This was a deliberate,
  explicit instruction from the project owner (see `docs/HISTORY.md`). Do not
  reintroduce an API-based classifier (Claude, OpenAI, etc.) or a
  fine-tuned/pretrained model as the default path without being asked.
  `docs/DECISIONS.md` records what was tried before and removed.
- **Everything schema-driven stays schema-driven.** Document types, fields,
  extractors, and branding live in `config/schema.json` (loaded via
  `schema.js`). Don't hardcode a document type or field name into
  `analyze.js`, `extractors.js`, `index.js`, or the web UI — add it to the
  schema instead.
- **Verify claims before writing them down.** Every claim in this repo's docs
  (e.g. "offline OCR runs with zero network," "preprocessing improves
  accuracy on small text") was checked by actually running it, not assumed.
  Keep that standard — if you add a claim, verify it, and note briefly how it
  was verified if it's not obvious from the code.
- **Be honest about limitations in writing.** `README.md`'s "Gaps and
  limitations" section is deliberately candid. When you find a new limitation
  or a heuristic that doesn't generalize, add it there rather than letting it
  surface only as a support conversation later.
