import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { analyzeText } from '../analyze.js';
import { generateFixtures, loadManifest } from '../fixtures/generate.js';
import { preprocessForOcr } from '../imagePreprocess.js';
import { processDirectory, segregateIntoBatches } from '../index.js';
import { ocrImage, ocrWasUsed, terminateOcr } from '../ocr.js';
import { extractTextFromPdfFile } from '../pdfIngest.js';
import { getDocumentTypeNames } from '../schema.js';

after(async () => {
  if (ocrWasUsed()) await terminateOcr();
});

const REQUIRED_TYPES = ['Invoice', 'Purchase Order', 'Transaction Record', 'Receipt'];

test('synthetic invoices, receipts, purchase orders, and transaction lists match known fields', { timeout: 180000 }, async () => {
  const manifest = loadManifest();
  const covered = new Set(manifest.documents.map((doc) => doc.documentType));
  for (const documentType of REQUIRED_TYPES) {
    assert.ok(getDocumentTypeNames().includes(documentType), documentType);
    assert.ok(covered.has(documentType), documentType);
    assert.ok(manifest.documents.some((doc) => doc.documentType === documentType && doc.render === 'text'));
    assert.ok(manifest.documents.some((doc) => doc.documentType === documentType && doc.render === 'scan'));
  }

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-fixtures-'));
  try {
    await generateFixtures(outDir, manifest);

    for (const doc of manifest.documents) {
      const extracted = await extractTextFromPdfFile(path.join(outDir, doc.filename));
      assert.equal(extracted.source, doc.source, `${doc.id} source`);
      const analyzed = analyzeText(extracted.text);
      assert.equal(analyzed.documentType, doc.documentType, `${doc.id} type via pdf`);
      assert.deepEqual(analyzed.fields, doc.fields, `${doc.id} fields via pdf`);
      for (const snippet of doc.textIncludes ?? []) {
        assert.ok(
          extracted.text.includes(snippet),
          `${doc.id} text missing ${JSON.stringify(snippet)}\n${extracted.text}`,
        );
      }

      if (doc.render !== 'scan') continue;

      const png = await fs.readFile(path.join(outDir, doc.image));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${doc.id} png`);
      const ocrText = await ocrImage(await preprocessForOcr(png));
      const fromImage = analyzeText(ocrText);
      assert.equal(fromImage.documentType, doc.documentType, `${doc.id} type via image`);
      assert.deepEqual(fromImage.fields, doc.fields, `${doc.id} fields via image`);
      for (const snippet of doc.textIncludes ?? []) {
        assert.ok(ocrText.includes(snippet), `${doc.id} image text missing ${JSON.stringify(snippet)}\n${ocrText}`);
      }
    }

    const { analyzedDocs, errors } = await processDirectory(outDir);
    assert.deepEqual(errors, []);
    assert.equal(analyzedDocs.length, manifest.documents.length);

    const byName = new Map(analyzedDocs.map((doc) => [doc.fileName, doc]));
    for (const doc of manifest.documents) {
      const analyzed = byName.get(doc.filename);
      assert.ok(analyzed, doc.filename);
      assert.equal(analyzed.source, doc.source, `${doc.id} directory source`);
      assert.equal(analyzed.documentType, doc.documentType, `${doc.id} directory type`);
      assert.deepEqual(analyzed.fields, doc.fields, `${doc.id} directory fields`);
    }

    const { batches } = segregateIntoBatches(analyzedDocs);
    const actualBatches = Object.values(batches).map((batch) => ({
      documentNumber: batch.documentNumber ?? null,
      referenceNumber: batch.referenceNumber ?? null,
      files: batch.documents.map((doc) => doc.fileName).sort(),
    }));
    const expectedBatches = manifest.expectedBatches.map((batch) => ({
      documentNumber: batch.documentNumber,
      referenceNumber: batch.referenceNumber,
      files: [...batch.files].sort(),
    }));
    assert.deepEqual(
      actualBatches.sort((a, b) => a.referenceNumber.localeCompare(b.referenceNumber)),
      expectedBatches.sort((a, b) => a.referenceNumber.localeCompare(b.referenceNumber)),
    );
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
