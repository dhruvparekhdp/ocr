/**
 * Generates sample PDFs into ./sample_pdfs so the classifier can be exercised
 * end-to-end without real customer documents. Matches config/schema.json's
 * default document types (Invoice, Purchase Order, Transaction Record,
 * Receipt, Unknown).
 *
 * Includes both kinds of PDF the pipeline must handle:
 *  - text-based PDFs (most samples) → embedded-text extraction path
 *  - one image-only / "scanned" PDF (receipt_scanned.pdf) → OCR path, so the
 *    OCR fallback is covered by `npm test`, not just the happy text path.
 *
 * Coverage:
 *  - a complete batch: Invoice + Purchase Order linked by referenceNumber
 *  - a standalone Transaction Record and a standalone (text) Receipt
 *  - a scanned Receipt exercising OCR
 *  - an orphan Invoice with no matching PO
 *  - a document with no recognisable keywords (Unknown)
 *
 * Usage: node scripts/generate-samples.js [outputDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { createCanvas } from '@napi-rs/canvas';

const outDir = path.resolve(process.argv[2] ?? './sample_pdfs');
fs.mkdirSync(outDir, { recursive: true });

/** A normal text PDF (has an embedded text layer). */
const writeTextPdf = (fileName, lines) =>
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

/**
 * An image-only PDF: the text is rasterized onto a canvas and embedded as an
 * image, so there is NO text layer — pdf-parse returns nothing and the
 * pipeline must OCR it. This is how a real scanned document behaves.
 */
const writeScannedPdf = (fileName, lines) =>
  new Promise((resolve, reject) => {
    const width = 640;
    const lineHeight = 46;
    const height = 60 + lines.length * lineHeight;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000000';
    ctx.font = '26px sans-serif';
    lines.forEach((line, i) => ctx.fillText(line, 24, 50 + i * lineHeight));
    const png = canvas.toBuffer('image/png');

    const doc = new PDFDocument({ size: [width, height] });
    const stream = fs.createWriteStream(path.join(outDir, fileName));
    doc.pipe(stream);
    doc.image(png, 0, 0, { width });
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

const textSamples = [
  // ---- Batch: Invoice + PO linked by referenceNumber PO-7788 -------------
  ['po_7788.pdf', [
    'Acme Exports Pvt Ltd',
    '12 Industrial Estate, Andheri East, Mumbai 400069',
    '',
    'PURCHASE ORDER',
    'PO No: PO-7788',
    'Order Date: 01/05/2024',
    'Vendor: Global Traders Inc',
  ]],
  ['invoice_001.pdf', [
    'Acme Exports Pvt Ltd',
    '12 Industrial Estate, Andheri East, Mumbai 400069',
    'GSTIN: 27ABCDE1234F1Z5',
    '',
    'TAX INVOICE',
    'Invoice No.: INV-2024-001',
    'Invoice Date: 10/05/2024',
    'PO Ref: PO-7788',
    'Bill To: Global Traders Inc',
    'Subtotal: 11,000.00',
    'Grand Total: 12,500.00',
  ]],

  // ---- Standalone documents (no shared reference fields) -----------------
  ['transaction_001.pdf', [
    'HDFC Bank Ltd',
    'ACCOUNT STATEMENT',
    'Transaction ID: TXN-88213',
    'Transaction Date: 15/06/2024',
    'Debit: 450.00',
  ]],
  ['receipt_001.pdf', [
    'Zenith Retail LLP',
    '4 Market Street, Pune 411001',
    '',
    'CASH RECEIPT',
    'Receipt No: RCPT-3341',
    'Date: 20/06/2024',
    'Payment Received',
    'Amount Paid: 990.00',
  ]],

  // ---- Orphan: Invoice with no matching PO -------------------------------
  ['invoice_orphan.pdf', [
    'Nowhere Trading Co',
    '9 Nowhere Lane, Nashik 422001',
    '',
    'COMMERCIAL INVOICE',
    'Invoice Number: INV-2024-999',
    'Invoice Date: 22/06/2024',
    'Grand Total: 3,300.00',
  ]],

  // ---- Unrecognisable document -------------------------------------------
  ['random_note.pdf', [
    'Meeting notes',
    'Discussed quarterly planning and staffing.',
  ]],
];

// A scanned/image receipt — exercises the OCR path.
const scannedSamples = [
  ['receipt_scanned.pdf', [
    'Sunrise Stores Pvt Ltd',
    'CASH RECEIPT',
    'Receipt No: RCPT-7788',
    'Date: 25/06/2024',
    'Amount Paid: 1,499.00',
  ]],
];

await Promise.all(textSamples.map(([name, lines]) => writeTextPdf(name, lines)));
await Promise.all(scannedSamples.map(([name, lines]) => writeScannedPdf(name, lines)));

console.log(
  `Generated ${textSamples.length} text PDFs + ${scannedSamples.length} scanned PDF (OCR) in ${outDir}`,
);
