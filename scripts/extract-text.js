/**
 * Dumps raw text for every PDF in a directory, one .txt file per PDF, using
 * the exact same extraction path (pdf-parse v2) the live classifier uses.
 *
 * This exists so training data for the local model is prepared from
 * identical text to what the model will see at inference time — labeling
 * against a different extraction (e.g. a Python PDF library with different
 * layout/whitespace behavior) would train the model on a distribution it
 * never actually encounters when served.
 *
 * Usage:
 *   node scripts/extract-text.js <pdfDir> <outDir>
 *
 * Output: <outDir>/<same-basename>.txt for every <pdfDir>/*.pdf
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { extractTextFromPdf } from '../index.js';

const [pdfDir, outDir] = process.argv.slice(2);

if (!pdfDir || !outDir) {
  console.error('Usage: node scripts/extract-text.js <pdfDir> <outDir>');
  process.exitCode = 1;
  process.exit();
}

const main = async () => {
  await fs.mkdir(outDir, { recursive: true });

  const entries = await fs.readdir(pdfDir, { withFileTypes: true });
  const pdfFiles = entries
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.pdf')
    .map((e) => e.name)
    .sort();

  if (pdfFiles.length === 0) {
    console.warn(`⚠ No PDF files found in "${pdfDir}".`);
    return;
  }

  let ok = 0;
  let failed = 0;

  for (const fileName of pdfFiles) {
    const outPath = path.join(outDir, `${path.parse(fileName).name}.txt`);
    try {
      const text = await extractTextFromPdf(path.join(pdfDir, fileName));
      await fs.writeFile(outPath, text, 'utf8');
      ok++;
    } catch (error) {
      console.error(`✗ ${fileName}: ${error.message}`);
      failed++;
    }
  }

  console.log(`✅ Extracted ${ok} file(s) to ${outDir}${failed ? `, ${failed} failed` : ''}`);
};

main();
