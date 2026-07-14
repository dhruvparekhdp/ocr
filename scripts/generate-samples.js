/**
 * Generates a set of sample text-based PDFs into ./sample_pdfs so the
 * classifier can be exercised end-to-end without real customer documents.
 *
 * Matches config/schema.json's default white-label document types (Invoice,
 * Purchase Order, Transaction Record, Receipt, Unknown) — exactly the
 * "sometimes bills, sometimes transaction records" mix a corporate client
 * might hand this tool. Edit config/schema.json (and this generator, if you
 * want matching smoke-test fixtures) to model a different client's schema.
 *
 * Covers:
 *  - a complete batch: Invoice + Purchase Order linked by referenceNumber
 *  - a standalone Transaction Record (its own documentNumber, no links)
 *  - a standalone Receipt
 *  - an orphan Invoice with no matching PO
 *  - a document with no recognisable keywords (Unknown / unidentified)
 *
 * Usage: node scripts/generate-samples.js [outputDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const outDir = path.resolve(process.argv[2] ?? './sample_pdfs');
fs.mkdirSync(outDir, { recursive: true });

const writePdf = (fileName, lines) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(path.join(outDir, fileName));
    doc.pipe(stream);
    doc.fontSize(12);
    for (const line of lines) doc.text(line);
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

const samples = [
  // ---- Batch: Invoice + PO linked by referenceNumber PO-7788 -------------
  ['po_7788.pdf', [
    'PURCHASE ORDER',
    'PO No: PO-7788',
    'Order Date: 2024-05-01',
    'Supplier: Acme Exports Pvt Ltd',
  ]],
  ['invoice_001.pdf', [
    'TAX INVOICE',
    'Invoice No.: INV-2024-001',
    'PO Ref: PO-7788',
    'Bill To: Global Traders Inc',
    'Total Due: 12500.00',
  ]],

  // ---- Standalone documents (no shared reference fields) -----------------
  ['transaction_001.pdf', [
    'ACCOUNT STATEMENT',
    'Transaction ID: TXN-88213',
    'Transaction Date: 2024-06-15',
    'Debit: 450.00',
  ]],
  ['receipt_001.pdf', [
    'RECEIPT',
    'Receipt No: RCPT-3341',
    'Payment Received',
    'Amount Paid: 99.00',
  ]],

  // ---- Orphan: Invoice with no matching PO -------------------------------
  ['invoice_orphan.pdf', [
    'COMMERCIAL INVOICE',
    'Invoice Number: INV-2024-999',
    'Bill To: Nowhere Corp',
    'Amount Due: 300.00',
  ]],

  // ---- Unrecognisable document --------------------------------------------
  ['random_note.pdf', [
    'Meeting notes',
    'Discussed quarterly logistics planning.',
  ]],
];

await Promise.all(samples.map(([name, lines]) => writePdf(name, lines)));
console.log(`Generated ${samples.length} sample PDFs in ${outDir}`);
