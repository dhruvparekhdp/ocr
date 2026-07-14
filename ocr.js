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
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createWorker } from 'tesseract.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * Runs OCR on a single raster image buffer (PNG/JPEG).
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<string>} Recognized text.
 */
export const ocrImage = async (imageBuffer) => {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageBuffer);
  return data.text;
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
