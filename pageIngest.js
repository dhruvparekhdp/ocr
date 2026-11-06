/**
 * Per-page ingest for the extract service.
 *
 * Text PDFs keep the embedded text from the same pdf-parse instance the rest
 * of the pipeline uses. Pages with almost no text are rasterized and OCR'd.
 * Word boxes are converted into one coordinate space:
 *   - PDFs: top-left origin, PDF points (viewport scale 1)
 *   - images: top-left origin, pixels of the file the caller sent
 *
 * pdf-parse's public TextResult has no character boxes. Positions are read
 * from the document that PDFParse already loaded (`parser.doc`) so this
 * stays on one pdfjs build. A second bundled pdfjs is what previously
 * corrupted global state (see docs/DECISIONS.md).
 */

import { PDFParse } from 'pdf-parse';
import { loadImage } from '@napi-rs/canvas';

import { MIN_TEXT_CHARS, OCR_RENDER_SCALE } from './pdfIngest.js';
import { ocrImageDetailed } from './ocr.js';
import { preprocessForOcr, UPSCALE_FACTOR, UPSCALE_WIDTH_THRESHOLD } from './imagePreprocess.js';
import { ServiceError } from './serviceError.js';

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * @param {Buffer} buffer
 * @returns {'pdf'|'png'|'jpeg'|'tiff'|null}
 */
export const detectMedia = (buffer) => {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 4) {
    const le = buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00;
    const be = buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a;
    if (le || be) return 'tiff';
  }
  return null;
};

const countAlnum = (text) => (text.match(/[A-Za-z0-9]/g) || []).length;

/**
 * @param {import('pdf-parse').PDFParse} parser
 * @param {number} pageNumber
 */
const textTokensForPage = async (parser, pageNumber) => {
  const page = await parser.doc.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
    const tokens = [];
    for (const item of textContent.items) {
      if (!item || !('str' in item) || !item.str || !item.str.trim()) continue;
      const tm = item.transform;
      const [x, y] = viewport.convertToViewportPoint(tm[4], tm[5]);
      const width = item.width || Math.abs(tm[0]) || 0;
      const height = item.height || Math.abs(tm[3]) || 0;
      tokens.push({
        text: item.str,
        confidence: 1,
        page: pageNumber,
        bbox: [round1(x), round1(y - height), round1(x + width), round1(y)],
      });
    }
    return tokens;
  } finally {
    page.cleanup();
  }
};

/**
 * @param {import('pdf-parse').PDFParse} parser
 * @param {number} pageNumber
 * @param {string[]} warnings
 */
const ocrPdfPage = async (parser, pageNumber, warnings) => {
  const shot = await parser.getScreenshot({
    partial: [pageNumber],
    scale: OCR_RENDER_SCALE,
    imageBuffer: true,
    imageDataUrl: false,
  });
  const image = shot.pages[0];
  if (!image?.data) {
    throw new ServiceError('extract_failed', 422, `Could not rasterize page ${pageNumber}.`);
  }
  const png = Buffer.from(image.data);
  const preprocessed = await preprocessForOcr(png);
  const preprocessScale = image.width < UPSCALE_WIDTH_THRESHOLD ? UPSCALE_FACTOR : 1;
  // Screenshot pixels are page-points × render scale. Preprocess may scale again.
  const divisor = preprocessScale * (image.scale || OCR_RENDER_SCALE);
  const detailed = await ocrImageDetailed(preprocessed);
  warnings.push(`ocr_page:${pageNumber}`);
  return {
    text: detailed.text || '',
    tokens: detailed.words.map((word) => ({
      text: word.text,
      confidence: word.confidence,
      page: pageNumber,
      bbox: word.bbox.map((value) => round1(value / divisor)),
    })),
  };
};

/**
 * @param {Buffer} buffer
 * @param {string[]} warnings
 */
const ingestImage = async (buffer, warnings) => {
  let pngForOcr = buffer;
  let divisor = 1;
  // canvas loadImage segfaults on some TIFFs instead of rejecting. Tesseract
  // reads TIFF bytes itself, so skip preprocess for that type. Boxes stay in
  // the file's pixel space because nothing rescaled them.
  if (detectMedia(buffer) === 'tiff') {
    warnings.push('preprocess_skipped');
  } else {
    const image = await loadImage(buffer);
    pngForOcr = await preprocessForOcr(buffer);
    divisor = image.width < UPSCALE_WIDTH_THRESHOLD ? UPSCALE_FACTOR : 1;
  }
  const detailed = await ocrImageDetailed(pngForOcr);
  return {
    pages: [{ page: 1, text: detailed.text || '' }],
    tokens: detailed.words.map((word) => ({
      text: word.text,
      confidence: word.confidence,
      page: 1,
      bbox: word.bbox.map((value) => round1(value / divisor)),
    })),
    warnings,
  };
};

/**
 * @param {Buffer} buffer
 * @param {{ maxPages: number }} limits
 * @returns {Promise<{ pages: Array<{ page: number, text: string }>, tokens: Array<{ text: string, confidence: number, page: number, bbox: number[] }>, warnings: string[] }>}
 */
export const ingestBuffer = async (buffer, limits) => {
  const kind = detectMedia(buffer);
  if (!kind) {
    throw new ServiceError('unsupported_media_type', 415, 'Only PDF, PNG, JPEG, and TIFF are accepted.');
  }
  const warnings = [];
  if (kind !== 'pdf') {
    return ingestImage(buffer, warnings);
  }

  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const info = await parser.getInfo();
    if (info.total > limits.maxPages) {
      throw new ServiceError('too_many_pages', 413, `Document has ${info.total} pages; the limit is ${limits.maxPages}.`);
    }
    const textResult = await parser.getText({ pageJoiner: '' });
    const pages = [];
    const tokens = [];
    for (const pageText of textResult.pages) {
      if (countAlnum(pageText.text || '') >= MIN_TEXT_CHARS) {
        pages.push({ page: pageText.num, text: pageText.text || '' });
        tokens.push(...(await textTokensForPage(parser, pageText.num)));
      } else {
        const ocr = await ocrPdfPage(parser, pageText.num, warnings);
        pages.push({ page: pageText.num, text: ocr.text });
        tokens.push(...ocr.tokens);
      }
    }
    return { pages, tokens, warnings };
  } finally {
    await parser.destroy();
  }
};
