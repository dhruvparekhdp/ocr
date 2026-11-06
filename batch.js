/**
 * Folder → JSONL batch.
 *
 *   node batch.js <folder> --out results.jsonl [--workers 4] [--no-resume]
 *
 * One JSON object per line. A successful line is skipped on the next run
 * when its sha256 is already in the file. Failures are kept and retried,
 * because they are not done. Workers extract text in parallel. Tesseract
 * itself stays serialized in ocr.js, so OCR-heavy folders do not start one
 * engine per worker.
 *
 * The JSONL file is the only document output. The summary (counts, failures,
 * low-confidence fields) is printed to stderr as JSON.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { analyzeText } from './analyze.js';
import { scoreDocumentFields } from './fieldConfidence.js';
import { extractTextFromBuffer } from './pdfIngest.js';
import { ocrWasUsed, terminateOcr } from './ocr.js';

/**
 * @template T, R
 * @param {T[]} items
 * @param {(item: T) => Promise<R>} worker
 * @param {number} limit
 * @returns {Promise<R[]>}
 */
export const mapWithConcurrency = async (items, worker, limit) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: runners }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
};

/**
 * @param {Buffer} buffer
 * @returns {string}
 */
export const contentHash = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Latest record per sha256. A truncated final line is ignored so a crash
 * mid-append does not poison the next resume.
 *
 * @param {string} outPath
 * @returns {Promise<Map<string, { status: string }>>}
 */
export const readCompleted = async (outPath) => {
  const done = new Map();
  let raw = '';
  try {
    raw = await fs.readFile(outPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return done;
    throw error;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record.sha256 === 'string' && record.status) {
        done.set(record.sha256, record);
      }
    } catch {
      // Incomplete line from a killed write. The next resume retries that file.
    }
  }
  return done;
};

const safeError = (error) => String(error?.message || error).split('\n')[0].slice(0, 300);

/**
 * @param {string[]} argv
 */
export const parseBatchArgs = (argv) => {
  let dir = '';
  let outPath = 'batch.jsonl';
  let workers = 4;
  let resume = true;
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--out') {
      outPath = args[i + 1];
      i += 1;
    } else if (arg === '--workers') {
      workers = Number(args[i + 1]);
      i += 1;
    } else if (arg === '--no-resume') {
      resume = false;
    } else if (!arg.startsWith('--') && !dir) {
      dir = arg;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  if (!dir) {
    throw new Error('Usage: node batch.js <folder> --out <file.jsonl> [--workers N] [--no-resume]');
  }
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error('--workers must be a positive integer');
  }
  if (!outPath) throw new Error('--out requires a path');
  return { dir, outPath, workers, resume };
};

/**
 * @param {{ dir: string, outPath: string, workers?: number, resume?: boolean }} options
 */
export const processFolder = async ({ dir, outPath, workers = 4, resume = true }) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf')
    .map((entry) => entry.name)
    .sort();

  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  if (!resume) await fs.writeFile(outPath, '');

  const prior = resume ? await readCompleted(outPath) : new Map();
  const seenThisRun = new Set();
  const pending = [];
  let skipped = 0;

  for (const name of names) {
    const filePath = path.join(dir, name);
    const buffer = await fs.readFile(filePath);
    const sha256 = contentHash(buffer);
    const previous = prior.get(sha256);
    if ((previous && previous.status === 'ok') || seenThisRun.has(sha256)) {
      skipped += 1;
      continue;
    }
    seenThisRun.add(sha256);
    pending.push({ file: name, buffer, sha256 });
  }

  let writeChain = Promise.resolve();
  const append = (record) => {
    writeChain = writeChain.then(() => fs.appendFile(outPath, `${JSON.stringify(record)}\n`));
    return writeChain;
  };

  const summary = {
    total: names.length,
    processed: 0,
    skipped,
    ok: 0,
    failed: 0,
    failures: [],
    lowConfidence: [],
  };

  await mapWithConcurrency(
    pending,
    async (item) => {
      try {
        const extracted = await extractTextFromBuffer(item.buffer);
        const analyzed = analyzeText(extracted.text);
        const scored = scoreDocumentFields({
          text: extracted.text,
          documentType: analyzed.documentType,
          fields: analyzed.fields,
          source: extracted.source,
        });
        const low = scored.filter((field) => field.low);
        const record = {
          file: item.file,
          sha256: item.sha256,
          status: 'ok',
          documentType: analyzed.documentType,
          source: extracted.source,
          fields: analyzed.fields,
          lowConfidence: low.map(({ name, value, confidence }) => ({ name, value, confidence })),
        };
        await append(record);
        summary.ok += 1;
        summary.processed += 1;
        for (const field of low) {
          summary.lowConfidence.push({
            file: item.file,
            sha256: item.sha256,
            name: field.name,
            value: field.value,
            confidence: field.confidence,
          });
        }
      } catch (error) {
        const message = safeError(error);
        await append({
          file: item.file,
          sha256: item.sha256,
          status: 'error',
          error: message,
        });
        summary.failed += 1;
        summary.processed += 1;
        summary.failures.push({ file: item.file, sha256: item.sha256, error: message });
      }
    },
    workers,
  );

  await writeChain;
  return summary;
};

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  try {
    const options = parseBatchArgs(process.argv);
    const summary = await processFolder(options);
    console.error(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(safeError(error));
    process.exitCode = 1;
  } finally {
    if (ocrWasUsed()) await terminateOcr();
  }
}
