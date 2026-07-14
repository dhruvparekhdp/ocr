/**
 * ============================================================================
 * PDF Batch Classifier
 * ============================================================================
 * Reads all text-based PDFs from a target directory, classifies each one as
 * PO | Invoice | AWB_BL | Shipping Bill, extracts the key identifiers
 * (Invoice Number / PO Number), and segregates related documents into
 * batches anchored on the Invoice.
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

// pdf-parse v2 (actively maintained, modern pdf.js). The v1.x line bundles
// 2017-era pdf.js builds that corrupt shared state on modern Node — parses
// after the first one fail with "bad XRef entry" — so v2 is required here.
import { PDFParse } from 'pdf-parse';

import { DOC_TYPES } from './docTypes.js';

// Imported lazily-invoked, not eagerly: constructing the Anthropic client
// requires credentials, and this module must still work (via the regex
// fallback) when none are configured. See resolveAnalyzer() below.
import { classifyWithLLM } from './llmClassifier.js';

export { DOC_TYPES };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum number of PDFs parsed concurrently. */
const CONCURRENCY_LIMIT = 8;

/**
 * LLM concurrency is deliberately lower than PDF-parsing concurrency — it's
 * bounded by API rate limits and cost, not local CPU/IO.
 */
const LLM_CONCURRENCY_LIMIT = 5;

/**
 * Classification keyword table.
 *
 * Every keyword is a case-insensitive regex fragment with a weight. A document
 * is scored per type by summing the weights of every keyword that appears in
 * its text; the highest-scoring type wins. Weights let unambiguous phrases
 * ("Air Waybill", "Shipping Bill No") dominate generic ones ("Consignee",
 * "PO No") that often appear on several document types at once.
 *
 * Real-world Indian export/customs paperwork (commercial invoices, packing
 * lists, shipping-bill EDI printouts) routinely carries shipment fields
 * ("Consignee", "Port of Loading") and glossary blurbs ("P.O. - Purchase
 * Order") on *every* document type, not just the one they nominally belong
 * to — so those generic fields are weighted low (weak supporting evidence
 * only) while the phrases that actually name the document type ("Commercial
 * Invoice", "Shipping Bill") are weighted high enough to win outright.
 */
const CLASSIFICATION_RULES = [
  {
    type: DOC_TYPES.PO,
    keywords: [
      { pattern: /\bpurchase\s+order\b/i, weight: 5 },
      { pattern: /\bproforma\s+invoice\b/i, weight: 6 }, // the PO-equivalent anchor doc in many export workflows
      { pattern: /\bpacking\s+list\b/i, weight: 4 },
      { pattern: /\bpo\s*(?:no|#)\b/i, weight: 2 },
      { pattern: /\bp\.o\./i, weight: 2 },
      { pattern: /\border\s+date\b/i, weight: 2 },
    ],
  },
  {
    type: DOC_TYPES.INVOICE,
    keywords: [
      { pattern: /\btax\s+invoice\b/i, weight: 10 },
      { pattern: /\bcommercial\s+invoice\b/i, weight: 10 },
      { pattern: /\binvoice\s+to\b/i, weight: 4 },
      { pattern: /\binv\s*(?:no|#)\b/i, weight: 3 },
      { pattern: /\bbill\s+to\b/i, weight: 2 },
      { pattern: /\btotal\s+due\b/i, weight: 2 },
    ],
  },
  {
    type: DOC_TYPES.AWB_BL,
    keywords: [
      { pattern: /\bair\s*waybill\b/i, weight: 5 },
      { pattern: /\bbill\s+of\s+lading\b/i, weight: 4 },
      { pattern: /\bawb\b/i, weight: 4 },
      { pattern: /\bb\/l\b/i, weight: 4 },
      { pattern: /\bshipper'?s\s+copy\b/i, weight: 3 },
      { pattern: /\bconsignee\b/i, weight: 1 },
      { pattern: /\bport\s+of\s+loading\b/i, weight: 1 },
    ],
  },
  {
    type: DOC_TYPES.SHIPPING_BILL,
    keywords: [
      { pattern: /\bshipping\s+bill\s*(?:no|#)?\b/i, weight: 5 },
      { pattern: /\bsb\s*(?:no|#)\b/i, weight: 4 },
      { pattern: /\bexport\s+goods\b/i, weight: 3 },
      { pattern: /\bcustoms\s+copy\b/i, weight: 3 },
      { pattern: /\blet\s+export\s+copy\b/i, weight: 3 },
      { pattern: /\bport\s+of\s+export\b/i, weight: 2 },
    ],
  },
];

/**
 * Identifier extraction patterns.
 *
 * Each regex captures the alphanumeric identifier that follows a known label.
 * The value part accepts letters, digits, '-', '/', '_' and must contain at
 * least one digit (guards against capturing stray words such as "Date" that
 * follow a bare "Purchase Order" heading — enforced by the `(?=...\d)`
 * lookahead). The separator between label and value allows whitespace and
 * punctuation in any order (`[\s:.\-#]*`) since real forms print labels like
 * "INV NO. : EXP/25-26/409" (space, then colon, then space) rather than the
 * tidy "label:value" shape a stricter separator would require.
 *
 * Label-adjacent patterns are tried first for precision; the last pattern in
 * each list is a label-free fallback recognising the `PREFIX/YY-YY/NNN`
 * fiscal-year reference format used broadly in Indian export/customs
 * paperwork (e.g. "EXP/25-26/409" for an export invoice, "PXP/25-26/4" for
 * a proforma invoice / purchase reference). It exists because multi-column
 * customs forms (shipping bills, EDI printouts) flatten into linear text
 * where a value can land far from — or even before — its label, so
 * label-adjacency matching alone misses it.
 */
const ID_VALUE = /((?=[A-Z0-9\/\-_]*\d)[A-Z0-9][A-Z0-9\/\-_]*)/.source;

/** Captured identifiers shorter than this are almost always a stray table/column number, not a real ID. */
const MIN_ID_LENGTH = 4;

const INVOICE_NUMBER_PATTERNS = [
  new RegExp(String.raw`\binvoice\s*(?:number|no\.?|#)\s*[\s:.\-#]*` + ID_VALUE, 'gi'),
  new RegExp(String.raw`\binv\.?\s*(?:no\.?|#)\s*[\s:.\-#]*` + ID_VALUE, 'gi'),
  new RegExp(String.raw`\binvoice#\s*` + ID_VALUE, 'gi'),
  // Fallback: bare "EXP/25-26/409"-style export reference, no label needed.
  /\b(EXP[A-Z]{0,3}\/\d{2,4}[-\/]\d{2,4}\/\d+)\b/gi,
];

const PO_NUMBER_PATTERNS = [
  new RegExp(String.raw`\bp\.?\s?o\.?\s*(?:number|no\.?|#|ref)\s*[\s:.\-#]*` + ID_VALUE, 'gi'),
  new RegExp(String.raw`\bpurchase\s+order\s*(?:number|no\.?|#|ref)?\s*[\s:.\-#]*` + ID_VALUE, 'gi'),
  new RegExp(String.raw`\breference\s*\(?\s*pxp\s*\)?\s*[\s:.\-#]*` + ID_VALUE, 'gi'),
  // Fallback: bare "PXP/25-26/4"-style proforma/purchase reference, no label needed.
  /\b((?:PXP|PI|PFI|PROF)[A-Z]{0,3}\/\d{2,4}[-\/]\d{2,4}\/\d+)\b/gi,
];

// ---------------------------------------------------------------------------
// Text analysis
// ---------------------------------------------------------------------------

/**
 * Normalises an extracted identifier so that "inv-2024/001" and
 * "INV-2024/001" batch together.
 *
 * @param {string|null} value Raw captured identifier.
 * @returns {string|null} Uppercased, trimmed identifier or null.
 */
const normalizeId = (value) =>
  value ? value.trim().toUpperCase().replace(/[.,;:]+$/, '') : null;

/**
 * Runs an ordered list of extraction patterns against the text and returns
 * the first captured identifier that's plausibly real.
 *
 * Tries every occurrence of a pattern (not just the first) before moving on
 * to the next pattern, and skips candidates shorter than {@link MIN_ID_LENGTH}.
 * This matters on multi-column customs forms, where a label's *nearest*
 * neighbour in the linearised text is often another column header's leading
 * number (e.g. "2.INVOICE NO 3.INVOICE AMOUNT" reads as "INVOICE NO" → "3"),
 * not the real value — so the first match for a pattern isn't always usable.
 *
 * @param {string} text     Raw PDF text.
 * @param {RegExp[]} patterns Ordered extraction patterns (each with the 'g' flag).
 * @returns {string|null}
 */
const extractIdentifier = (text, patterns) => {
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = normalizeId(match[1]);
      if (candidate && candidate.length >= MIN_ID_LENGTH) return candidate;
    }
  }
  return null;
};

/**
 * Classifies raw PDF text and extracts key identifiers.
 *
 * @param {string} rawText Full text content of one PDF.
 * @returns {{ documentType: string, invoiceNumber: string|null, poNumber: string|null }}
 */
export const analyzeText = (rawText) => {
  const text = rawText.replace(/\s+/g, ' '); // collapse layout whitespace

  // --- Classification: score every type, highest total wins -------------
  let documentType = DOC_TYPES.UNKNOWN;
  let bestScore = 0;

  for (const rule of CLASSIFICATION_RULES) {
    const score = rule.keywords.reduce(
      (sum, { pattern, weight }) => (pattern.test(text) ? sum + weight : sum),
      0,
    );
    if (score > bestScore) {
      bestScore = score;
      documentType = rule.type;
    }
  }

  // --- Identifier extraction --------------------------------------------
  const invoiceNumber =
    documentType === DOC_TYPES.PO
      ? null // POs never carry an invoice number
      : extractIdentifier(text, INVOICE_NUMBER_PATTERNS);

  // PO number is relevant on the PO itself and as a reference on the Invoice.
  const poNumber =
    documentType === DOC_TYPES.PO || documentType === DOC_TYPES.INVOICE
      ? extractIdentifier(text, PO_NUMBER_PATTERNS)
      : null;

  return { documentType, invoiceNumber, poNumber };
};

/**
 * Picks which analyzer backs a single classification run and how many can
 * run concurrently. Resolved once per run (not per-document) so a batch
 * never mixes LLM and regex classifications, which would make results
 * inconsistent within the same report.
 *
 * - `CLASSIFIER=llm`   forces the LLM path (errors per-document if the API
 *   call fails — e.g. missing/invalid credentials — same as any other
 *   per-file failure).
 * - `CLASSIFIER=regex` forces the keyword/regex path, regardless of
 *   whether Anthropic credentials are configured. Useful for a fast, free,
 *   fully offline run, or for comparing the two approaches.
 * - Unset (default): LLM if Anthropic credentials are present, else regex
 *   with a one-time warning. The regex path exists as a fallback, not the
 *   recommended default — see README for why keyword matching alone is
 *   unreliable on real-world document variety.
 *
 * Memoized for the process lifetime so the fallback warning prints once,
 * even though both the startup banner and the actual run call this.
 *
 * @returns {{ analyze: (rawText: string) => Promise<object>, concurrency: number, mode: 'llm'|'regex' }}
 */
let cachedAnalyzer = null;
const resolveAnalyzer = () => {
  if (cachedAnalyzer) return cachedAnalyzer;

  const forced = process.env.CLASSIFIER?.toLowerCase();
  if (forced === 'regex') {
    cachedAnalyzer = { analyze: async (rawText) => analyzeText(rawText), concurrency: CONCURRENCY_LIMIT, mode: 'regex' };
    return cachedAnalyzer;
  }
  if (forced === 'llm') {
    cachedAnalyzer = { analyze: classifyWithLLM, concurrency: LLM_CONCURRENCY_LIMIT, mode: 'llm' };
    return cachedAnalyzer;
  }

  const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!hasCredentials) {
    console.warn(
      '⚠ No Anthropic credentials found (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN unset) — ' +
        'falling back to regex-based classification. Set an API key (or run ' +
        '`ant auth login`) to use the LLM classifier, which generalises far better ' +
        'across real-world document variety. Set CLASSIFIER=regex to silence this warning.',
    );
    cachedAnalyzer = { analyze: async (rawText) => analyzeText(rawText), concurrency: CONCURRENCY_LIMIT, mode: 'regex' };
    return cachedAnalyzer;
  }
  cachedAnalyzer = { analyze: classifyWithLLM, concurrency: LLM_CONCURRENCY_LIMIT, mode: 'llm' };
  return cachedAnalyzer;
};

/**
 * Reports which classifier a run would use, without running anything —
 * used by the CLI/server startup banner so users know what they'll get
 * before any PDFs are processed.
 *
 * @returns {'llm'|'regex'}
 */
export const getAnalyzerMode = () => resolveAnalyzer().mode;

// ---------------------------------------------------------------------------
// PDF ingestion
// ---------------------------------------------------------------------------

/**
 * Extracts raw text from a PDF buffer.
 *
 * @param {Buffer} buffer Raw PDF bytes.
 * @returns {Promise<string>} The PDF's text content.
 */
const extractTextFromBuffer = async (buffer) => {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const { text } = await parser.getText();
    return text;
  } finally {
    await parser.destroy(); // always release pdf.js resources
  }
};

/**
 * Extracts raw text from a single PDF file on disk.
 *
 * @param {string} filePath Absolute path to the PDF.
 * @returns {Promise<string>} The PDF's text content.
 */
const extractTextFromPdf = async (filePath) => {
  const buffer = await fs.readFile(filePath);
  return extractTextFromBuffer(buffer);
};

/**
 * Minimal promise pool — runs `worker` over `items` with bounded concurrency
 * so 100+ PDFs don't all load into memory at once.
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
 * Reads every PDF in a directory, extracts its text and analyses it.
 * Files that fail to parse are reported, never thrown — one corrupt PDF
 * must not sink the whole run.
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

  const { analyze, concurrency } = resolveAnalyzer();

  const outcomes = await mapWithConcurrency(
    pdfFiles,
    async (fileName) => {
      const filePath = path.join(dirPath, fileName);
      try {
        const rawText = await extractTextFromPdf(filePath);
        return { ok: true, doc: { fileName, ...(await analyze(rawText)) } };
      } catch (error) {
        return { ok: false, error: { fileName, reason: error.message } };
      }
    },
    concurrency,
  );

  return {
    analyzedDocs: outcomes.filter((o) => o.ok).map((o) => o.doc),
    errors: outcomes.filter((o) => !o.ok).map((o) => o.error),
  };
};

/**
 * Analyses PDFs already held in memory (e.g. from a multipart upload),
 * without touching the filesystem. Same per-file failure isolation and
 * bounded concurrency as {@link processDirectory}.
 *
 * @param {Array<{ fileName: string, buffer: Buffer }>} files
 * @returns {Promise<{ analyzedDocs: Array<object>, errors: Array<object> }>}
 */
export const processBuffers = async (files) => {
  const { analyze, concurrency } = resolveAnalyzer();

  const outcomes = await mapWithConcurrency(
    files,
    async ({ fileName, buffer }) => {
      try {
        const rawText = await extractTextFromBuffer(buffer);
        return { ok: true, doc: { fileName, ...(await analyze(rawText)) } };
      } catch (error) {
        return { ok: false, error: { fileName, reason: error.message } };
      }
    },
    concurrency,
  );

  return {
    analyzedDocs: outcomes.filter((o) => o.ok).map((o) => o.doc),
    errors: outcomes.filter((o) => !o.ok).map((o) => o.error),
  };
};

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

/**
 * Groups analysed documents into batches.
 *
 * Strategy:
 *  1. Invoices anchor the batches — each distinct invoiceNumber opens a batch
 *     and (via the invoice's PO reference) registers a poNumber → batch link.
 *  2. AWB_BL and Shipping Bill docs join their batch through invoiceNumber.
 *  3. PO docs join through the poNumber recorded from the batch's invoice.
 *  4. Anything that cannot be linked lands in `unbatched`, grouped by
 *     whichever identifier it does have (or "UNIDENTIFIED" if it has none).
 *
 * @param {Array<{fileName: string, documentType: string, invoiceNumber: string|null, poNumber: string|null}>} analyzedDocs
 * @returns {{ batches: object, unbatched: object }}
 */
export const segregateIntoBatches = (analyzedDocs) => {
  /** @type {Map<string, object>} invoiceNumber -> batch */
  const batchesByInvoice = new Map();
  /** @type {Map<string, object>} poNumber -> batch (built from invoices) */
  const batchesByPo = new Map();

  const invoices = analyzedDocs.filter((d) => d.documentType === DOC_TYPES.INVOICE);
  const others = analyzedDocs.filter((d) => d.documentType !== DOC_TYPES.INVOICE);

  // --- Pass 1: anchor batches on invoices --------------------------------
  for (const doc of invoices) {
    if (!doc.invoiceNumber) continue; // invoice without a number → orphan later

    let batch = batchesByInvoice.get(doc.invoiceNumber);
    if (!batch) {
      batch = {
        batchId: `BATCH-${doc.invoiceNumber}`,
        invoiceNumber: doc.invoiceNumber,
        poNumber: doc.poNumber ?? null,
        files: [],
      };
      batchesByInvoice.set(doc.invoiceNumber, batch);
    }
    // Keep the first PO reference we see; warn on conflicting references.
    if (doc.poNumber) {
      if (batch.poNumber && batch.poNumber !== doc.poNumber) {
        console.warn(
          `⚠ Conflicting PO refs for invoice ${doc.invoiceNumber}: ` +
            `${batch.poNumber} vs ${doc.poNumber} (keeping ${batch.poNumber}).`,
        );
      } else {
        batch.poNumber = doc.poNumber;
        batchesByPo.set(doc.poNumber, batch);
      }
    }
    batch.files.push({ fileName: doc.fileName, documentType: doc.documentType });
  }

  // --- Pass 2: attach the remaining documents ----------------------------
  /** @type {Map<string, Array<object>>} orphan-group key -> file entries */
  const unbatchedGroups = new Map();

  const addOrphan = (doc) => {
    // Group orphans by whatever identifier is available.
    const key = doc.invoiceNumber
      ? `INV:${doc.invoiceNumber}`
      : doc.poNumber
        ? `PO:${doc.poNumber}`
        : 'UNIDENTIFIED';
    if (!unbatchedGroups.has(key)) unbatchedGroups.set(key, []);
    unbatchedGroups.get(key).push({
      fileName: doc.fileName,
      documentType: doc.documentType,
      invoiceNumber: doc.invoiceNumber,
      poNumber: doc.poNumber,
    });
  };

  // Invoices that never made it into a batch (missing invoice number).
  for (const doc of invoices) {
    if (!doc.invoiceNumber) addOrphan(doc);
  }

  for (const doc of others) {
    let batch = null;

    if (doc.documentType === DOC_TYPES.PO) {
      // POs link through the PO reference found on the batch's invoice.
      batch = doc.poNumber ? batchesByPo.get(doc.poNumber) : null;
    } else {
      // AWB_BL / Shipping Bill / Unknown link through the invoice number.
      batch = doc.invoiceNumber ? batchesByInvoice.get(doc.invoiceNumber) : null;
    }

    if (batch) {
      batch.files.push({ fileName: doc.fileName, documentType: doc.documentType });
    } else {
      addOrphan(doc);
    }
  }

  // --- Shape the final output --------------------------------------------
  const batches = {};
  for (const batch of batchesByInvoice.values()) {
    batches[batch.batchId] = {
      invoiceNumber: batch.invoiceNumber,
      poNumber: batch.poNumber,
      fileCount: batch.files.length,
      documents: batch.files,
    };
  }

  const unbatched = {};
  for (const [key, docs] of unbatchedGroups.entries()) {
    unbatched[key] = docs;
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
    `\n✅ Done in ${((Date.now() - started) / 1000).toFixed(2)}s — ` +
      `report written to ${outputFile}`,
  );
};

// Run only when invoked directly (allows importing the functions in tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`❌ Fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
