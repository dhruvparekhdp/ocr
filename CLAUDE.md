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
- **User-facing behavior, setup, and known limitations** → `README.md`.

Do not let a significant decision exist only as something said in
conversation. If you are about to explain a "why" to the user that isn't
already written down somewhere in the repo, that is a signal to also write
it into one of the files above before moving on.

## Orientation

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

## Working conventions for this repo

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
