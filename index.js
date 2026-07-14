/**
 * ============================================================================
 * White-Label Document Classifier
 * ============================================================================
 * Reads all text-based PDFs from a target directory, classifies each one
 * against the document types defined in config/schema.json, extracts the
 * fields configured for whichever type it detects, and segregates related
 * documents into batches by whichever fields are marked as batch keys.
 *
 * Nothing about document types or fields is hardcoded — a corporate client
 * whose documents are invoices and bank transaction records, and another
 * whose documents are bills and receipts, both run on this same code; only
 * config/schema.json differs. See schema.js and README.
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

import { getDocumentTypes, getFields, getFieldsForType, getBatchKeyFields } from './schema.js';

// Imported lazily-invoked, not eagerly: constructing the Anthropic client
// requires credentials, and this module must still work (via the regex
// fallback) when none are configured. See resolveAnalyzer() below.
import { classifyWithLLM } from './llmClassifier.js';
import { classifyWithLocalLLM } from './localClassifier.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum number of PDFs parsed concurrently. */
const CONCURRENCY_LIMIT = 8;

/**
 * Claude API concurrency is deliberately lower than PDF-parsing concurrency —
 * it's bounded by API rate limits and cost, not local CPU/IO.
 */
const LLM_CONCURRENCY_LIMIT = 5;

/**
 * A self-hosted model server has no per-request cost and typically serves
 * one request at a time efficiently (a single GPU/CPU running one small
 * model) — concurrency here bounds memory/queueing on that server, not API
 * quota. Keep it low; raise it if your server can genuinely batch requests.
 */
const LOCAL_LLM_CONCURRENCY_LIMIT = 2;

const UNKNOWN_TYPE = 'Unknown';

// ---------------------------------------------------------------------------
// Regex fallback: classification (built from config/schema.json)
// ---------------------------------------------------------------------------

/**
 * Builds one weighted keyword rule per configured document type, straight
 * from schema.json's `keywords` / `keywordWeight`. A document is scored per
 * type by summing the weights of every keyword that appears in its text;
 * the highest-scoring type wins. This is inherently weaker than the LLM
 * path — see README "Why not keyword regex alone" — but works fully
 * offline for whatever schema is configured, not just a hardcoded one.
 *
 * Memoized: schema.js's own loadSchema() is already memoized per process,
 * so this just avoids rebuilding the same RegExp objects on every document.
 */
let cachedClassificationRules = null;
const buildClassificationRules = () => {
  if (cachedClassificationRules) return cachedClassificationRules;

  cachedClassificationRules = getDocumentTypes()
    .filter((t) => t.name !== UNKNOWN_TYPE)
    .map((t) => ({
      type: t.name,
      weight: t.keywordWeight ?? 5,
      keywords: (t.keywords || []).map((phrase) => {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped.replace(/\s+/g, '\\s+')}\\b`, 'i');
      }),
    }));

  return cachedClassificationRules;
};

// ---------------------------------------------------------------------------
// Regex fallback: field extraction (built from config/schema.json)
// ---------------------------------------------------------------------------

/**
 * Captures the alphanumeric identifier that follows a known label. The value
 * part accepts letters, digits, '-', '/', '_' and must contain at least one
 * digit (guards against capturing stray words like "Date" that follow a
 * bare heading). The separator between label and value allows whitespace
 * and punctuation in any order (`[\s:.\-#]*`) since real forms print labels
 * like "INV NO. : EXP/25-26/409" (space, colon, space) rather than a tidy
 * "label:value" shape.
 */
const ID_VALUE = /((?=[A-Z0-9\/\-_]*\d)[A-Z0-9][A-Z0-9\/\-_]*)/.source;

/** Captured identifiers shorter than this are almost always a stray table/column number, not a real value. */
const MIN_ID_LENGTH = 4;

/**
 * Generic label-free fallback recognising the `PREFIX/YY-YY/NNN` fiscal-year
 * reference format common in Indian trade/export paperwork (e.g.
 * "EXP/25-26/409", "PXP/25-26/4"). Not tied to any specific field — applied
 * as a last resort for every field, since multi-column forms can flatten
 * into linear text where a value lands far from (or before) its label.
 */
const FISCAL_REFERENCE_FALLBACK = /\b([A-Z]{2,6}\/\d{2,4}[-\/]\d{2,4}\/\d+)\b/gi;

/**
 * Builds one ordered list of extraction patterns per configured field, from
 * its `labels` array in schema.json. Label-adjacent patterns are tried
 * first for precision; the fiscal-reference fallback is tried last for
 * every field.
 */
let cachedExtractionPatterns = null;
const buildExtractionPatterns = () => {
  if (cachedExtractionPatterns) return cachedExtractionPatterns;

  const patternsByField = new Map();
  for (const field of getFields()) {
    const labelPatterns = (field.labels || []).map((label) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      return new RegExp(String.raw`\b${escaped}\s*[\s:.\-#]*` + ID_VALUE, 'gi');
    });
    patternsByField.set(field.name, [...labelPatterns, FISCAL_REFERENCE_FALLBACK]);
  }

  cachedExtractionPatterns = patternsByField;
  return cachedExtractionPatterns;
};

/**
 * Normalises an extracted identifier so that "inv-2024/001" and
 * "INV-2024/001" batch together.
 *
 * @param {string|null} value Raw captured identifier.
 * @returns {string|null} Uppercased, trimmed identifier or null.
 */
const normalizeId = (value) => (value ? value.trim().toUpperCase().replace(/[.,;:]+$/, '') : null);

/**
 * Runs an ordered list of extraction patterns against the text and returns
 * the first captured value that's plausibly real.
 *
 * Tries every occurrence of a pattern (not just the first) before moving on
 * to the next pattern, and skips candidates shorter than {@link MIN_ID_LENGTH}.
 * This matters on multi-column forms, where a label's *nearest* neighbour in
 * the linearised text is often another column header's leading number
 * (e.g. "2.INVOICE NO 3.INVOICE AMOUNT" reads as "INVOICE NO" → "3"), not
 * the real value — so the first match for a pattern isn't always usable.
 *
 * @param {string} text Raw PDF text.
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

// ---------------------------------------------------------------------------
// Text analysis
// ---------------------------------------------------------------------------

/**
 * Classifies raw PDF text against the configured document types and
 * extracts whichever fields apply to the detected type. This is the regex
 * fallback — see README "Why not keyword regex alone" for why the LLM path
 * (llmClassifier.js) is the recommended default; this exists so the tool
 * still works fully offline/free without Anthropic credentials.
 *
 * @param {string} rawText Full text content of one PDF.
 * @returns {{ documentType: string, fields: Record<string, string|null> }}
 */
export const analyzeText = (rawText) => {
  const text = rawText.replace(/\s+/g, ' '); // collapse layout whitespace

  // --- Classification: score every type, highest total wins -------------
  let documentType = UNKNOWN_TYPE;
  let bestScore = 0;

  for (const rule of buildClassificationRules()) {
    const score = rule.keywords.reduce((sum, pattern) => (pattern.test(text) ? sum + rule.weight : sum), 0);
    if (score > bestScore) {
      bestScore = score;
      documentType = rule.type;
    }
  }

  // --- Field extraction: only for fields that apply to the detected type -
  const extractionPatterns = buildExtractionPatterns();
  const fields = {};
  for (const field of getFields()) {
    const applies = getFieldsForType(documentType).some((f) => f.name === field.name);
    fields[field.name] = applies ? extractIdentifier(text, extractionPatterns.get(field.name)) : null;
  }

  return { documentType, fields };
};

/**
 * Picks which analyzer backs a single classification run and how many can
 * run concurrently. Resolved once per run (not per-document) so a batch
 * never mixes analyzers, which would make results inconsistent within the
 * same report.
 *
 * - `CLASSIFIER=llm`   forces Claude (errors per-document if the API call
 *   fails — e.g. missing/invalid credentials — same as any other per-file
 *   failure).
 * - `CLASSIFIER=local` forces your self-hosted fine-tuned model — see
 *   local-llm/ for training it and serve.py for running it. Requires
 *   local-llm/serve.py already running; point at it via LOCAL_LLM_URL if
 *   it's not on the default http://127.0.0.1:8008.
 * - `CLASSIFIER=regex` forces the keyword/regex path, regardless of
 *   whether Anthropic credentials are configured. Useful for a fast, free,
 *   fully offline run, or for comparing approaches.
 * - Unset (default): Claude if Anthropic credentials are present, else
 *   regex with a one-time warning. `local` is never chosen automatically —
 *   there's no reliable way to detect a running local server without an
 *   extra network probe, so it's opt-in only.
 *
 * Memoized for the process lifetime so the fallback warning prints once,
 * even though both the startup banner and the actual run call this.
 *
 * @returns {{ analyze: (rawText: string) => Promise<object>, concurrency: number, mode: 'llm'|'local'|'regex' }}
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
  if (forced === 'local') {
    cachedAnalyzer = { analyze: classifyWithLocalLLM, concurrency: LOCAL_LLM_CONCURRENCY_LIMIT, mode: 'local' };
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
 * @returns {'llm'|'local'|'regex'}
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
 * Extracts raw text from a single PDF file on disk. Exported so training-data
 * preparation (scripts/extract-text.js) uses the exact same extraction path
 * as the live classifier — text fed to a locally-trained model must match
 * what that model will see at inference time.
 *
 * @param {string} filePath Absolute path to the PDF.
 * @returns {Promise<string>} The PDF's text content.
 */
export const extractTextFromPdf = async (filePath) => {
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
 * Strategy: two documents belong to the same batch if they share a non-null
 * value in *any* batch-key field — e.g. an Invoice and the Purchase Order it
 * references share a `referenceNumber`; that same Invoice and its Transport
 * document share a `documentNumber`. This is a union-find over shared field
 * values rather than a hardcoded "Invoice anchors, others join" rule, so it
 * generalises to whatever document types and batch-key fields a client's
 * schema defines — bills, transaction records, anything — without the
 * batching logic itself needing to know what those types mean.
 *
 * Documents that don't share a batch-key value with anything else land in
 * `unbatched`, grouped by whichever batch-key field they do have a value
 * for (or "UNIDENTIFIED" if none).
 *
 * @param {Array<{fileName: string, documentType: string, fields: Record<string, string|null>}>} analyzedDocs
 * @returns {{ batches: object, unbatched: object }}
 */
export const segregateIntoBatches = (analyzedDocs) => {
  const batchKeyFields = getBatchKeyFields();
  const uf = new UnionFind(analyzedDocs.length);

  // Union every pair of documents that share a non-null value in the same batch-key field.
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

  // Group document indices by their union-find root.
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
      // Singleton: no shared batch-key value with any other document.
      const doc = docsInGroup[0];
      const firstKeyField = batchKeyFields.find((f) => doc.fields?.[f]);
      const key = firstKeyField ? `${firstKeyField}:${doc.fields[firstKeyField]}` : 'UNIDENTIFIED';
      if (!unbatched[key]) unbatched[key] = [];
      unbatched[key].push({ fileName: doc.fileName, documentType: doc.documentType, fields: doc.fields });
      continue;
    }

    // Resolve one representative value per batch-key field across the group,
    // warning if documents disagree (keeps the first value seen, same
    // conflict-handling spirit as the original invoice/PO-specific logic).
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
      documents: docsInGroup.map((doc) => ({ fileName: doc.fileName, documentType: doc.documentType })),
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
