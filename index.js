/**
 * ============================================================================
 * Document Classifier — self-contained, no cloud, no LLM
 * ============================================================================
 * Reads text-based OR scanned/image PDFs from a folder, turns each into text
 * (embedded text where present, offline OCR where not), classifies it against
 * the document types in config/schema.json, extracts the configured fields
 * with deterministic from-scratch heuristics (extractors.js), and segregates
 * related documents into batches by shared batch-key fields.
 *
 * Everything runs locally: nothing about a document, and no network call,
 * leaves the machine. There is no Claude, no LoRA, no trained model — just
 * PDF→text (or image→OCR→text) plus rule-based extraction.
 *
 * Usage:
 *   node index.js [pdfDirectory] [outputFile]
 *
 * Defaults:
 *   pdfDirectory : ./pdfs
 *   outputFile   : ./batches.json
 * ============================================================================
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { getBatchKeyFields } from './schema.js';
import { analyzeText } from './analyze.js';
import { extractTextFromBuffer, extractTextFromPdfFile } from './pdfIngest.js';
import { terminateOcr, ocrWasUsed } from './ocr.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * PDFs parsed concurrently. Kept moderate because a scanned PDF is
 * rasterized (memory-heavy) before OCR; the OCR step itself is serialized on
 * a single worker (see ocr.js), so a very high limit wouldn't speed OCR-heavy
 * runs anyway.
 */
const CONCURRENCY_LIMIT = 4;

// ---------------------------------------------------------------------------
// Re-exports (kept stable for the web server and any external callers)
// ---------------------------------------------------------------------------

export { analyzeText } from './analyze.js';
export { extractTextFromPdfFile } from './pdfIngest.js';

/**
 * Minimal promise pool — runs `worker` over `items` with bounded concurrency
 * so a large folder doesn't load every PDF into memory at once.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T) => Promise<R>} worker
 * @param {number} limit
 * @returns {Promise<R[]>} Results in input order.
 */
const mapWithConcurrency = async (items, worker, limit) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
};

/**
 * Analyses one document's text and shapes the per-document result, tagging
 * how the text was obtained (`text` vs `ocr`) so noisy OCR values are
 * distinguishable downstream.
 *
 * @param {string} fileName
 * @param {{ text: string, source: 'text' | 'ocr' }} extracted
 * @returns {object}
 */
const analyzeDocument = (fileName, extracted) => ({
  fileName,
  source: extracted.source,
  ...analyzeText(extracted.text),
});

/**
 * Reads every PDF in a directory, extracts its text (OCR fallback for scanned
 * PDFs) and analyses it. Files that fail are reported, never thrown — one bad
 * PDF must not sink the whole run.
 *
 * @param {string} dirPath Directory containing the PDFs.
 * @returns {Promise<{ analyzedDocs: Array<object>, errors: Array<object> }>}
 */
export const processDirectory = async (dirPath) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const pdfFiles = entries
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.pdf')
    .map((e) => e.name)
    .sort();

  if (pdfFiles.length === 0) {
    console.warn(`⚠ No PDF files found in "${dirPath}".`);
  }

  const outcomes = await mapWithConcurrency(
    pdfFiles,
    async (fileName) => {
      try {
        const extracted = await extractTextFromPdfFile(path.join(dirPath, fileName));
        return { ok: true, doc: analyzeDocument(fileName, extracted) };
      } catch (error) {
        return { ok: false, error: { fileName, reason: error.message } };
      }
    },
    CONCURRENCY_LIMIT,
  );

  return {
    analyzedDocs: outcomes.filter((o) => o.ok).map((o) => o.doc),
    errors: outcomes.filter((o) => !o.ok).map((o) => o.error),
  };
};

/**
 * Analyses PDFs already held in memory (e.g. from a multipart upload), same
 * ingestion + failure isolation as {@link processDirectory}.
 *
 * @param {Array<{ fileName: string, buffer: Buffer }>} files
 * @returns {Promise<{ analyzedDocs: Array<object>, errors: Array<object> }>}
 */
export const processBuffers = async (files) => {
  const outcomes = await mapWithConcurrency(
    files,
    async ({ fileName, buffer }) => {
      try {
        const extracted = await extractTextFromBuffer(buffer);
        return { ok: true, doc: analyzeDocument(fileName, extracted) };
      } catch (error) {
        return { ok: false, error: { fileName, reason: error.message } };
      }
    },
    CONCURRENCY_LIMIT,
  );

  return {
    analyzedDocs: outcomes.filter((o) => o.ok).map((o) => o.doc),
    errors: outcomes.filter((o) => !o.ok).map((o) => o.error),
  };
};

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

/** Simple union-find (disjoint set) with path compression. */
class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i) {
    if (this.parent[i] !== i) this.parent[i] = this.find(this.parent[i]);
    return this.parent[i];
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootA] = rootB;
  }
}

/**
 * Groups analysed documents into batches by clustering on shared field
 * values, using whichever fields are marked `isBatchKey: true` in
 * config/schema.json.
 *
 * Two documents belong to the same batch if they share a non-null value in
 * *any* batch-key field — e.g. an Invoice and the Purchase Order it
 * references share a `referenceNumber`. This is a union-find over shared
 * field values rather than a hardcoded relationship, so it generalises to
 * whatever document types and batch-key fields a client's schema defines.
 *
 * Documents that don't share a batch-key value with anything else land in
 * `unbatched`, grouped by whichever batch-key field they do have a value for
 * (or "UNIDENTIFIED" if none).
 *
 * @param {Array<{fileName: string, documentType: string, fields: Record<string, string|null>}>} analyzedDocs
 * @returns {{ batches: object, unbatched: object }}
 */
export const segregateIntoBatches = (analyzedDocs) => {
  const batchKeyFields = getBatchKeyFields();
  const uf = new UnionFind(analyzedDocs.length);

  for (const fieldName of batchKeyFields) {
    const docIndicesByValue = new Map();
    analyzedDocs.forEach((doc, i) => {
      const value = doc.fields?.[fieldName];
      if (!value) return;
      if (!docIndicesByValue.has(value)) docIndicesByValue.set(value, []);
      docIndicesByValue.get(value).push(i);
    });
    for (const indices of docIndicesByValue.values()) {
      for (let i = 1; i < indices.length; i++) uf.union(indices[0], indices[i]);
    }
  }

  const groups = new Map();
  analyzedDocs.forEach((doc, i) => {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });

  const batches = {};
  const unbatched = {};
  let batchCounter = 0;

  for (const indices of groups.values()) {
    const docsInGroup = indices.map((i) => analyzedDocs[i]);

    if (docsInGroup.length < 2) {
      const doc = docsInGroup[0];
      const firstKeyField = batchKeyFields.find((f) => doc.fields?.[f]);
      const key = firstKeyField ? `${firstKeyField}:${doc.fields[firstKeyField]}` : 'UNIDENTIFIED';
      if (!unbatched[key]) unbatched[key] = [];
      unbatched[key].push({ fileName: doc.fileName, documentType: doc.documentType, source: doc.source, fields: doc.fields });
      continue;
    }

    const keyFieldValues = {};
    for (const fieldName of batchKeyFields) {
      for (const doc of docsInGroup) {
        const value = doc.fields?.[fieldName];
        if (!value) continue;
        if (keyFieldValues[fieldName] && keyFieldValues[fieldName] !== value) {
          console.warn(
            `⚠ Conflicting ${fieldName} values in one batch: ${keyFieldValues[fieldName]} vs ${value} ` +
              `(keeping ${keyFieldValues[fieldName]}).`,
          );
        } else {
          keyFieldValues[fieldName] = value;
        }
      }
    }

    batchCounter += 1;
    const batchLabel = Object.values(keyFieldValues).find(Boolean) || `GROUP-${batchCounter}`;
    batches[`BATCH-${batchLabel}`] = {
      ...keyFieldValues,
      fileCount: docsInGroup.length,
      documents: docsInGroup.map((doc) => ({ fileName: doc.fileName, documentType: doc.documentType, source: doc.source })),
    };
  }

  return { batches, unbatched };
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const main = async () => {
  const pdfDir = path.resolve(process.argv[2] ?? './pdfs');
  const outputFile = path.resolve(process.argv[3] ?? './batches.json');

  console.log(`📂 Scanning: ${pdfDir}`);
  const started = Date.now();

  const { analyzedDocs, errors } = await processDirectory(pdfDir);
  const { batches, unbatched } = segregateIntoBatches(analyzedDocs);

  const report = {
    generatedAt: new Date().toISOString(),
    sourceDirectory: pdfDir,
    summary: {
      totalPdfs: analyzedDocs.length + errors.length,
      analyzed: analyzedDocs.length,
      ocrUsed: analyzedDocs.filter((d) => d.source === 'ocr').length,
      failed: errors.length,
      batches: Object.keys(batches).length,
      unbatchedGroups: Object.keys(unbatched).length,
    },
    batches,
    unbatched,
    errors,
  };

  await fs.writeFile(outputFile, JSON.stringify(report, null, 2), 'utf8');

  console.log(JSON.stringify(report, null, 2));
  console.log(
    `\n✅ Done in ${((Date.now() - started) / 1000).toFixed(2)}s — report written to ${outputFile}`,
  );
};

// Run only when invoked directly (allows importing the functions in tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((error) => {
      console.error(`❌ Fatal: ${error.message}`);
      process.exitCode = 1;
    })
    // Always tear down the OCR worker so the process can exit cleanly (it
    // keeps a worker thread alive once created).
    .finally(async () => {
      if (ocrWasUsed()) await terminateOcr();
    });
}
