# AGENTS.md

Instructions for AI coding agents (Cursor, Claude Code, others) working in
this repository.

1. Read `CLAUDE.md` first — it holds the project's working rules and applies
   to every agent, not just Claude.
2. The task list is `docs/PLAN.md`. Pick the next unticked task in phase
   order, follow its "done when", and tick it when finished.
3. Record decisions in `docs/DECISIONS.md` and progress in `docs/HISTORY.md`.
   Never delete old context; mark it superseded.

Commands (from `backend/`): `uv sync`, `uv run pytest`,
`uv run ruff check . && uv run ruff format .`, `uv run alembic upgrade head`.
