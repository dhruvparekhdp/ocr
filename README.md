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

## Requirements

- Node.js >= 18
- Dependency: [`pdf-parse`](https://www.npmjs.com/package/pdf-parse) **v2.x**

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

- **Classification** is keyword-scored per type (weighted, case-insensitive
  regex): unambiguous phrases like "Air Waybill" or "Tax Invoice" outweigh
  generic ones like "Consignee" or "PO No" that appear on several document
  types. Highest score wins; no hits → `Unknown`.
- **Invoice number**: labels `Invoice Number`, `Invoice No.`, `Inv No`,
  `Inv #`, `Invoice#` followed by an alphanumeric ID (must contain a digit).
- **PO number**: labels `Purchase Order`, `PO No`, `PO #`, `P.O. Number`,
  `PO Ref` followed by an alphanumeric ID (must contain a digit).
- Identifiers are normalised to uppercase so `inv-2024/001` and
  `INV-2024/001` batch together.

## Architecture

| Piece | Responsibility |
| --- | --- |
| `extractTextFromPdf(filePath)` | Reads one PDF and extracts raw text via pdf-parse. |
| `analyzeText(rawText)` | Returns `{ documentType, invoiceNumber, poNumber }`. |
| `processDirectory(dirPath)` | Parses all PDFs with bounded concurrency (8); per-file failures are collected, never fatal. |
| `segregateIntoBatches(analyzedDocs)` | Builds `{ batches, unbatched }` per the anchoring rules above. |
| `scripts/generate-samples.js` | Dev-only sample PDF generator (pdfkit) for the smoke test. |

All analysis functions are exported, so they can be unit-tested or reused
without touching the filesystem.
