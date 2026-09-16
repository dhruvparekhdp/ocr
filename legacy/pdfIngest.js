/**
 * ============================================================================
 * PDF ingestion — text extraction with automatic OCR fallback
 * ============================================================================
 * Turns a PDF into plain text using the cheapest method that works:
 *
 *   1. Text-based PDF  → pdf-parse pulls the embedded text directly (fast).
 *   2. Scanned / image PDF → pdf-parse yields (almost) nothing, so each page
 *      is rasterized (pdf-parse's own getScreenshot), preprocessed
 *      (imagePreprocess.js — upscale/denoise/binarize), and run through
 *      offline OCR (ocr.js / tesseract.js).
 *
 * Both text extraction and page rasterization go through the SAME pdf-parse
 * instance (one bundled pdfjs). An earlier design rendered pages with a
 * separate library (pdf-to-img) — but running two independent pdfjs builds
 * in one process corrupts pdfjs global state and the second one throws. Using
 * pdf-parse for both avoids that entirely (and drops two dependencies).
 *
 * The result records which path was taken (`source: 'text' | 'ocr'`) so the
 * caller/UI can surface it — OCR'd text is noisier, and knowing a value came
 * from OCR is useful context when a field looks off.
 * ============================================================================
 */

import { PDFParse } from 'pdf-parse';

import { preprocessForOcr } from './imagePreprocess.js';

import { ocrImage } from './ocr.js';

/**
 * If pdf-parse returns fewer than this many alphanumeric characters, the PDF
 * is treated as scanned/image-based and sent to OCR. Real text PDFs return
 * hundreds+; scanned PDFs return ~0 (just page markers). The floor is
 * deliberately low so a genuinely tiny (but real) text PDF isn't needlessly
 * OCR'd.
 */
const MIN_TEXT_CHARS = 25;

/** Higher scale → sharper render → better OCR accuracy, at more time/memory. 2 is a good balance. */
const OCR_RENDER_SCALE = 2;

const countAlnum = (text) => (text.match(/[A-Za-z0-9]/g) || []).length;

/**
 * Rasterizes every page and OCRs each, returning the concatenated text.
 *
 * @param {InstanceType<typeof PDFParse>} parser An already-loaded parser.
 * @returns {Promise<string>}
 */
const ocrAllPages = async (parser) => {
  const { pages } = await parser.getScreenshot({ scale: OCR_RENDER_SCALE });
  const pageTexts = [];
  for (const page of pages) {
    // page.data is a Uint8Array of PNG bytes; preprocess (upscale/denoise/
    // binarize — see imagePreprocess.js) before handing it to tesseract.
    const preprocessed = await preprocessForOcr(Buffer.from(page.data));
    const text = await ocrImage(preprocessed);
    pageTexts.push(text);
  }
  return pageTexts.join('\n\n');
};

/**
 * Extracts text from a PDF buffer, using OCR only when the embedded-text path
 * comes up empty.
 *
 * @param {Buffer} buffer Raw PDF bytes.
 * @returns {Promise<{ text: string, source: 'text' | 'ocr' }>}
 */
export const extractTextFromBuffer = async (buffer) => {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const { text } = await parser.getText();
    const embeddedText = text || '';

    if (countAlnum(embeddedText) >= MIN_TEXT_CHARS) {
      return { text: embeddedText, source: 'text' };
    }

    // Sparse or missing text layer → OCR (same parser instance, no pdfjs conflict).
    const ocrText = await ocrAllPages(parser);
    if (countAlnum(ocrText) > 0) {
      return { text: ocrText, source: 'ocr' };
    }

    // Neither path produced usable text, but nothing threw — return whatever
    // we have (possibly empty) as text so the document still appears in the
    // report (classified Unknown with no fields, rather than vanishing).
    return { text: embeddedText, source: 'text' };
  } finally {
    await parser.destroy();
  }
};

/**
 * Reads a PDF file from disk and extracts its text (with OCR fallback).
 * Exported so inspection/util scripts share the exact ingestion path the
 * classifier uses.
 *
 * @param {string} filePath
 * @returns {Promise<{ text: string, source: 'text' | 'ocr' }>}
 */
export const extractTextFromPdfFile = async (filePath) => {
  const { readFile } = await import('node:fs/promises');
  const buffer = await readFile(filePath);
  return extractTextFromBuffer(buffer);
};
