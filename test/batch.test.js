import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import PDFDocument from 'pdfkit';

import { contentHash, mapWithConcurrency, parseBatchArgs, processFolder, readCompleted } from '../batch.js';
import { extractTextFromBuffer, MIN_TEXT_CHARS, substantiveAlnum } from '../pdfIngest.js';
import { SCAN_WORD, sevenPageScanPdf } from '../fixtures/sevenPageScan.js';
import { ocrWasUsed, terminateOcr } from '../ocr.js';

const textPdf = (pages) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    pages.forEach((lines, index) => {
      if (index > 0) doc.addPage();
      for (const line of lines) doc.text(line);
    });
    doc.end();
  });

const bannerText = (pages) => Array.from({ length: pages }, (_, i) => `-- ${i + 1} of ${pages} --`).join('\n\n');

after(async () => {
  if (ocrWasUsed()) await terminateOcr();
});

test('page banners are not counted toward the OCR text floor', () => {
  const banners = bannerText(7);
  const rawAlnum = (banners.match(/[A-Za-z0-9]/g) || []).length;
  assert.ok(rawAlnum >= MIN_TEXT_CHARS);
  assert.ok(substantiveAlnum(banners) < MIN_TEXT_CHARS);
  assert.ok(substantiveAlnum(`${banners}\nTAX INVOICE Invoice No INV-100`) >= MIN_TEXT_CHARS);
});

test('a 7-page scanned PDF still goes to OCR', { timeout: 180000 }, async () => {
  const buffer = await sevenPageScanPdf();
  const extracted = await extractTextFromBuffer(buffer);
  assert.equal(extracted.source, 'ocr');
  assert.match(extracted.text.toUpperCase(), new RegExp(SCAN_WORD));
  assert.equal(substantiveAlnum(bannerText(7)) < MIN_TEXT_CHARS, true);
});

test('a 7-page text PDF keeps its embedded text', async () => {
  const buffer = await textPdf([
    ['TAX INVOICE', 'Invoice No: INV-7', 'Grand Total: 10.00'],
    ['Page two notes about the shipment'],
    ['Page three notes about the shipment'],
    ['Page four notes about the shipment'],
    ['Page five notes about the shipment'],
    ['Page six notes about the shipment'],
    ['Page seven notes about the shipment'],
  ]);
  const extracted = await extractTextFromBuffer(buffer);
  assert.equal(extracted.source, 'text');
  assert.match(extracted.text, /INV-7/);
});

test('workers never exceed the requested limit', async () => {
  let current = 0;
  let max = 0;
  await mapWithConcurrency(
    [1, 2, 3, 4, 5],
    async () => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 20));
      current -= 1;
    },
    2,
  );
  assert.equal(max, 2);
});

test('parseBatchArgs reads the folder, output, workers, and resume flag', () => {
  assert.deepEqual(parseBatchArgs(['node', 'batch.js', 'pdfs', '--out', 'out.jsonl', '--workers', '3']), {
    dir: 'pdfs',
    outPath: 'out.jsonl',
    workers: 3,
    resume: true,
  });
  assert.equal(parseBatchArgs(['node', 'batch.js', 'pdfs', '--no-resume']).resume, false);
  assert.throws(() => parseBatchArgs(['node', 'batch.js', 'pdfs', '--workers', '0']), /positive integer/);
});

test('resume skips a finished content hash, retries a failure, and reports low confidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-batch-'));
  const outPath = path.join(dir, 'out', 'batch.jsonl');
  const invoice = await textPdf([['TAX INVOICE', 'Invoice No: INV-100', 'Please pay 12.50 soon']]);
  const other = await textPdf([['CASH RECEIPT', 'Receipt No: RCPT-1', 'Amount Paid: 10.00']]);
  await fs.writeFile(path.join(dir, 'invoice.pdf'), invoice);
  await fs.writeFile(path.join(dir, 'receipt.pdf'), other);
  await fs.writeFile(path.join(dir, 'broken.pdf'), Buffer.from('%PDF-1.7\nnot a real pdf'));

  const first = await processFolder({ dir, outPath, workers: 2, resume: true });
  assert.equal(first.total, 3);
  assert.equal(first.ok, 2);
  assert.equal(first.failed, 1);
  assert.equal(first.skipped, 0);
  assert.equal(first.failures.length, 1);
  assert.equal(first.failures[0].file, 'broken.pdf');
  assert.ok(first.lowConfidence.some((field) => field.file === 'invoice.pdf' && field.name === 'amount' && field.value === '12.50'));
  assert.equal(
    first.lowConfidence.some((field) => field.file === 'invoice.pdf' && field.name === 'documentNumber'),
    false,
  );

  const lines = (await fs.readFile(outPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
  const records = lines.map((line) => JSON.parse(line));
  assert.equal(records.filter((record) => record.status === 'ok').length, 2);
  assert.equal(records.filter((record) => record.status === 'error').length, 1);
  const invoiceRecord = records.find((record) => record.file === 'invoice.pdf');
  assert.equal(invoiceRecord.sha256, contentHash(invoice));
  assert.equal(invoiceRecord.documentType, 'Invoice');

  const second = await processFolder({ dir, outPath, workers: 2, resume: true });
  assert.equal(second.skipped, 2);
  assert.equal(second.ok, 0);
  assert.equal(second.failed, 1);
  const afterRetry = (await fs.readFile(outPath, 'utf8')).trim().split('\n');
  assert.equal(afterRetry.length, 4);
  const latest = await readCompleted(outPath);
  assert.equal(latest.get(contentHash(invoice)).status, 'ok');
  assert.equal(latest.get(contentHash(Buffer.from('%PDF-1.7\nnot a real pdf'))).status, 'error');

  const renamed = path.join(dir, 'invoice-copy.pdf');
  await fs.rename(path.join(dir, 'invoice.pdf'), renamed);
  const third = await processFolder({ dir, outPath, workers: 1, resume: true });
  assert.equal(third.skipped, 2);
  assert.equal(third.ok, 0);
  const finalLines = (await fs.readFile(outPath, 'utf8')).trim().split('\n');
  assert.equal(finalLines.length, 5);

  await fs.rm(dir, { recursive: true, force: true });
});
