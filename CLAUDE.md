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

- **Models and cloud APIs are allowed (since 2026-09-16).** The earlier
  "no cloud, no LLM, no model" rule is superseded — see `docs/DECISIONS.md`.
  Groq is the LLM/VLM provider for now; the long-term target is the owner's
  own fine-tuned model running fully offline, after which the API path is
  removed. Keep every LLM call behind a provider interface so that swap is
  local.
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
