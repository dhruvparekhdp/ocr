/**
 * ============================================================================
 * Offline OCR helper
 * ============================================================================
 * Wraps tesseract.js so image-based (scanned) PDFs can be turned into text
 * with NO network access at all: the WASM engine and the English language
 * data are both loaded from local files under node_modules (vendored via the
 * `tesseract.js-core` and `@tesseract.js-data/eng` packages). This matters
 * for a corporate tool handling financial documents — nothing about a
 * document, and no CDN dependency, ever leaves the machine.
 *
 * A single worker is created lazily and reused across every page of every
 * document (worker startup costs ~1-2s), then torn down with terminateOcr().
 * ============================================================================
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { createWorker } from 'tesseract.js';

const require = createRequire(import.meta.url);

/**
 * Resolves the directory holding eng.traineddata.gz. tesseract.js's `langPath`
 * wants a directory, not a file — the file inside must be named
 * `<lang>.traineddata.gz` (it is, in the vendored package).
 */
const resolveLangPath = () => {
  const pkgJson = require.resolve('@tesseract.js-data/eng/package.json');
  // The data lives in a versioned subdir next to package.json; "4.0.0" is the
  // standard LSTM model directory shipped by the package.
  return path.join(path.dirname(pkgJson), '4.0.0');
};

const resolveCorePath = () => path.dirname(require.resolve('tesseract.js-core/package.json'));

const resolveWorkerPath = () =>
  path.join(path.dirname(require.resolve('tesseract.js/package.json')), 'src', 'worker-script', 'node', 'index.js');

let workerPromise = null;

/**
 * Lazily creates (and memoizes) the shared OCR worker, wired entirely to
 * local files.
 *
 * @returns {Promise<import('tesseract.js').Worker>}
 */
const getWorker = () => {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      langPath: resolveLangPath(),
      corePath: resolveCorePath(),
      workerPath: resolveWorkerPath(),
      gzip: true,
      cacheMethod: 'none', // don't try to write/read a cache dir; the local file is authoritative
      // No `logger` — keep OCR quiet; progress isn't useful in a batch run.
    });
  }
  return workerPromise;
};

// A single tesseract worker processes one job at a time; if the document
// pipeline runs several PDFs concurrently, their OCR calls would otherwise
// hit the same worker at once and race. This promise chain serializes every
// recognize() call so they queue cleanly behind one another.
let recognizeChain = Promise.resolve();

/**
 * Runs OCR on a single raster image buffer (PNG/JPEG). Calls are serialized
 * across the process — safe to call concurrently, they simply queue.
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<string>} Recognized text.
 */
const recognize = (imageBuffer) => {
  const run = async () => {
    const worker = await getWorker();
    // blocks are off by default and are the only place word boxes live.
    const { data } = await worker.recognize(imageBuffer, {}, { text: true, blocks: true });
    return data;
  };
  // Attach to the chain, but don't let one failure poison later calls.
  const result = recognizeChain.then(run, run);
  recognizeChain = result.then(() => {}, () => {});
  return result;
};

/**
 * @param {import('tesseract.js').Page} data
 * @returns {Array<{ text: string, confidence: number, bbox: number[] }>}
 */
const wordsFromPage = (data) => {
  const words = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          const text = word.text?.trim();
          if (!text || !word.bbox) continue;
          words.push({
            text,
            confidence: Math.max(0, Math.min(1, (word.confidence || 0) / 100)),
            bbox: [word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1],
          });
        }
      }
    }
  }
  return words;
};

export const ocrImage = async (imageBuffer) => (await recognize(imageBuffer)).text || '';

/**
 * Same recognizer as {@link ocrImage}, keeping word boxes and confidences.
 * Boxes are in the pixel space of the buffer passed in (already preprocessed
 * when the caller ran preprocessForOcr).
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<{ text: string, confidence: number, words: Array<{ text: string, confidence: number, bbox: number[] }> }>}
 */
export const ocrImageDetailed = async (imageBuffer) => {
  const data = await recognize(imageBuffer);
  return {
    text: data.text || '',
    confidence: Math.max(0, Math.min(1, (data.confidence || 0) / 100)),
    words: wordsFromPage(data),
  };
};

/**
 * Tears down the shared worker. Call once at the end of a run so the process
 * can exit (tesseract.js keeps a worker thread alive otherwise).
 */
export const terminateOcr = async () => {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
};

/** True once a worker has been created — lets callers skip terminateOcr() when no OCR happened. */
export const ocrWasUsed = () => workerPromise !== null;
