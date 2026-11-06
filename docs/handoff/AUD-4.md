# Handoff AUD-4 — OCR baseline audit

## Summary

Read-only baseline of the document classifier (the repo the ticket calls `ocr`). The only product change is `docs/audit/ocr-baseline.md`. No pipeline code, schema, dependency, or config was edited.

The repo is a Node ESM package, `document-classifier` 2.0.0. It accepts PDFs, uses embedded text or offline English Tesseract, classifies Invoice / Purchase Order / Transaction Record / Receipt / Unknown by keyword score, and extracts a fixed set of header fields with heuristics. Confidence scores and page/region positions are not in any public output. Tesseract and `pdf-parse` compute some of that data and the pipeline drops it. No customer documents are committed. `npm test` exits 0 and does not assert field values; the scanned sample's receipt number was OCR'd as `RCP1-7788` instead of `RCPT-7788`.

## Files changed

| Path | Change |
| --- | --- |
| `docs/audit/ocr-baseline.md` | New. Full baseline: inputs, preprocessing, OCR, classification, per-type fields, confidence, positions, entry points, test results, customer-document check, recommended Jarvis API. |
| `docs/handoff/AUD-4.md` | This handoff. |

## Commands run and results

Working directory `/workspace`. Times below are Asia/Calcutta (IST, UTC+5:30).

| When (IST) | Command | Result |
| --- | --- | --- |
| 6 Nov 2026, ~5:56 PM | `npm install` | Exit 0. Installed 162 packages from the existing lockfile. npm reported 4 existing advisories (1 moderate, 2 high, 1 critical). No `npm audit fix`. |
| 6 Nov 2026, 5:57 PM | `npm test` | Exit 0. Generator wrote 6 text PDFs + 1 scanned PDF. Pipeline `generatedAt` `2026-11-06T12:27:25.576Z` (5:57 PM IST). Summary: total 7, analyzed 7, ocrUsed 1, failed 0, batches 1, unbatchedGroups 5, errors empty. Scanned receipt number misread `RCPT-7788` → `RCP1-7788`; company, date, and amount on that file matched. See the audit for the rest of the observed fields. |
| 6 Nov 2026, 5:58 PM | `npm run lint` | Exit 1. `Missing script: "lint"`. No ESLint config in the repo. |
| 6 Nov 2026, 5:58 PM | `npm run typecheck` | Exit 1. `Missing script: "typecheck"`. No `tsconfig`. |
| 6 Nov 2026, 5:58 PM | `node --check` on `analyze.js`, `extractors.js`, `imagePreprocess.js`, `index.js`, `ocr.js`, `pdfIngest.js`, `schema.js`, `server.js`, `scripts/generate-samples.js` | Exit 0. Syntax only. |

`git ls-files` plus a filename search found no committed PDF, image, Office, or CSV document. `sample_pdfs/`, `batches.json`, and `node_modules/` are gitignored and were not committed.

The web UI was not opened in a browser. `GET /api/config` and `POST /api/classify` were read from `server.js` and `public/index.html`. The smoke test runs the same classify/extract/batch functions the server calls (`processDirectory` vs `processBuffers`).

## Assumptions

- This workspace is the ticket's `ocr` repo. The package is named `document-classifier` and OCR is one stage, not a standalone service. The audit describes that layout.
- Branch name is `jarvis/AUD-4`, as the ticket asked, rather than the `cursor/…-0e8d` template.
- "Only write `docs/audit/ocr-baseline.md`" plus this required handoff. `README.md`, `docs/HISTORY.md`, and `docs/DECISIONS.md` were not updated. No new tests: the change is documentation, and the ticket forbids extra product files. The existing smoke test was run, not extended.
- Lint and typecheck were attempted and are absent. `node --check` is a syntax substitute, not a typecheck. No ESLint or TypeScript dependency was added.
- The recommended Jarvis API in the audit is a design note for a later ticket. It was not implemented.
- "Customer document" means committed paperwork. Fixture strings inside `scripts/generate-samples.js` are not customer files. Gitignored samples created by `npm test` are not committed.
- Dependency advisories were not triaged. Upgrading them would violate the sprint rule against dependency upgrades and is outside a read-only audit.

## Known gaps

- Public output has no per-field or page confidence, no page index, and no bounding box. Details and the discarded engine fields are in the audit.
- `source: "text"` also covers "OCR ran and found nothing."
- Mixed PDFs are classified from the text layer only.
- PDF and English print only. No deskew, no line items, dates not normalized, currency not split out, purchase orders have no amount field.
- Batched documents omit `fields` in the current report. The recommended API puts fields on `documents[]` for that reason.
- `npm test` cannot fail on a wrong field. The `RCP1-7788` misread is invisible to CI as it exists today.
- `server.js` has no authentication and does not bind loopback.
- `npm install` still reports 4 dependency advisories. Unchanged by this ticket.

## Security impact

No runtime behavior change. No secrets were written or printed. No `.env` was read. The test output contains only synthetic sample fields from `scripts/generate-samples.js`.

The audit document describes the unauthenticated upload server and recommends a loopback, read-only Jarvis tool that omits raw text unless asked. It does not change that server. Existing dependency advisories were left in place.

## Rollback

The branch only adds markdown under `docs/audit/` and `docs/handoff/`. To drop the audit, delete `jarvis/AUD-4` or revert the commits on that branch (audit is `333080e`). `main` was not modified. No migration, service, or config rollback is required.
