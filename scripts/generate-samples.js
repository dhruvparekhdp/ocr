/**
 * Generates a set of sample text-based PDFs into ./sample_pdfs so the
 * classifier can be exercised end-to-end without real customer documents.
 *
 * Covers:
 *  - two complete batches (PO + Invoice + AWB/BL + Shipping Bill)
 *  - an orphan AWB whose invoice doesn't exist
 *  - an orphan PO with no matching invoice
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
  // ---- Batch 1: INV-2024-001 / PO-7788 -----------------------------------
  ['po_7788.pdf', [
    'PURCHASE ORDER',
    'PO No: PO-7788',
    'Order Date: 2024-05-01',
    'Supplier: Acme Exports Pvt Ltd',
  ]],
  ['invoice_001.pdf', [
    'COMMERCIAL INVOICE',
    'Invoice No.: INV-2024-001',
    'PO Ref: PO-7788',
    'Bill To: Global Traders Inc',
    'Total Due: USD 12,500.00',
  ]],
  ['awb_001.pdf', [
    'AIR WAYBILL',
    "Shipper's Copy",
    'AWB No: 176-44556677',
    'Invoice No: INV-2024-001',
    'Consignee: Global Traders Inc',
    'Port of Loading: BOM',
  ]],
  ['sb_001.pdf', [
    'SHIPPING BILL FOR EXPORT GOODS',
    'Customs Copy',
    'SB No: 5544332',
    'Invoice Number: INV-2024-001',
    'Port of Export: Nhava Sheva',
  ]],

  // ---- Batch 2: INV-2024-002 / PO-9911 -----------------------------------
  ['po_9911.pdf', [
    'Purchase Order',
    'P.O. Number: PO-9911',
    'Order Date: 2024-06-10',
  ]],
  ['invoice_002.pdf', [
    'TAX INVOICE',
    'Inv No: INV-2024-002',
    'Purchase Order Ref: PO-9911',
    'Invoice To: Ocean Freight LLC',
  ]],
  ['bl_002.pdf', [
    'BILL OF LADING (B/L)',
    'B/L No: MSCU887766',
    'Invoice#INV-2024-002',
    'Consignee: Ocean Freight LLC',
    'Port of Loading: Mundra',
  ]],

  // ---- Orphans -------------------------------------------------------------
  ['awb_orphan.pdf', [
    'Air Waybill',
    'AWB No: 098-11223344',
    'Invoice No: INV-2024-999', // no such invoice → unbatched under INV:
    'Consignee: Nowhere Corp',
  ]],
  ['po_orphan.pdf', [
    'PURCHASE ORDER',
    'PO #: PO-0000',           // no invoice references this PO → unbatched
    'Order Date: 2024-07-01',
  ]],
  ['random_note.pdf', [
    'Meeting notes',
    'Discussed quarterly logistics planning.',
  ]],
];

await Promise.all(samples.map(([name, lines]) => writePdf(name, lines)));
console.log(`Generated ${samples.length} sample PDFs in ${outDir}`);
