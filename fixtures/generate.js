/**
 * Builds synthetic PDFs and PNGs from fixtures/manifest.json.
 * Text PDFs exercise the embedded-text path. Scan fixtures are drawn with
 * Liberation Sans (installed by scripts/setup.sh and CI) into a PNG, then
 * wrapped in an image-only PDF so the OCR path has to read them.
 * Nothing here is a customer document.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import PDFDocument from 'pdfkit';

const manifestPath = fileURLToPath(new URL('./manifest.json', import.meta.url));

/**
 * @typedef {object} FixtureDocument
 * @property {string} id
 * @property {string} filename
 * @property {'text'|'scan'} render
 * @property {string} documentType
 * @property {'text'|'ocr'} source
 * @property {string[]} lines
 * @property {string} [image]
 * @property {string[]} [textIncludes]
 * @property {Record<string, string|null>} fields
 */

/**
 * @typedef {object} ExpectedBatch
 * @property {string} documentNumber
 * @property {string} referenceNumber
 * @property {string[]} files
 */

/**
 * @typedef {object} FixtureManifest
 * @property {string} [description]
 * @property {FixtureDocument[]} documents
 * @property {ExpectedBatch[]} expectedBatches
 */

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
];

const SCAN_WIDTH = 1600;
const SCAN_FONT_PX = 64;
const SCAN_LINE_HEIGHT = 90;
const SCAN_PAD_TOP = 100;
const SCAN_PAD_BOTTOM = 80;
const SCAN_PAD_X = 60;

/** @returns {FixtureManifest} Parsed fixture manifest. */
export const loadManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

/**
 * @returns {string} Absolute path to the Liberation Sans file used for scans.
 */
export const resolveFixtureFont = () => {
  const found = FONT_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `Liberation Sans was not found. Run npm run setup (Debian/Ubuntu package fonts-liberation). Looked in ${FONT_CANDIDATES.join(', ')}`,
    );
  }
  return found;
};

let fontReady = false;
const ensureFont = () => {
  if (fontReady) return;
  const fontPath = resolveFixtureFont();
  const registered = GlobalFonts.registerFromPath(fontPath, 'FixtureSans');
  if (!registered) {
    throw new Error(`Could not register fixture font at ${fontPath}`);
  }
  fontReady = true;
};

/**
 * @param {string} filePath
 * @param {string[]} lines
 * @returns {Promise<void>}
 */
const writeTextPdf = (filePath, lines) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    doc.fontSize(12);
    for (const line of lines) doc.text(line);
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

/**
 * @param {string[]} lines
 * @returns {{ png: Buffer, width: number, height: number }}
 */
export const renderScanImage = (lines) => {
  ensureFont();
  const width = SCAN_WIDTH;
  const height = SCAN_PAD_TOP + lines.length * SCAN_LINE_HEIGHT + SCAN_PAD_BOTTOM;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.font = `${SCAN_FONT_PX}px FixtureSans`;
  lines.forEach((line, index) => {
    ctx.fillText(line, SCAN_PAD_X, SCAN_PAD_TOP + index * SCAN_LINE_HEIGHT);
  });
  return { png: canvas.toBuffer('image/png'), width, height };
};

/**
 * @param {string} filePath
 * @param {Buffer} png
 * @param {number} width
 * @param {number} height
 * @returns {Promise<void>}
 */
const writeImagePdf = (filePath, png, width, height) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [width, height], margin: 0 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    doc.image(png, 0, 0, { width, height });
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

/**
 * @param {FixtureManifest} manifest
 */
const assertManifest = (manifest) => {
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error('Fixture manifest has no documents');
  }
  const ids = new Set();
  const filenames = new Set();
  for (const doc of manifest.documents) {
    if (ids.has(doc.id)) throw new Error(`Duplicate fixture id ${doc.id}`);
    ids.add(doc.id);
    if (filenames.has(doc.filename)) throw new Error(`Duplicate fixture filename ${doc.filename}`);
    filenames.add(doc.filename);
    if (doc.render !== 'text' && doc.render !== 'scan') {
      throw new Error(`Fixture ${doc.id} has unknown render ${doc.render}`);
    }
    if (doc.render === 'scan' && !doc.image) throw new Error(`Fixture ${doc.id} is missing image`);
    if (!Array.isArray(doc.lines) || doc.lines.length === 0) {
      throw new Error(`Fixture ${doc.id} has no lines`);
    }
  }
};

/**
 * Writes every fixture into outDir. PDFs are always written. Scan fixtures
 * also write the PNG named by doc.image.
 *
 * @param {string} outDir
 * @param {FixtureManifest} [manifest]
 * @returns {Promise<{ outDir: string, count: number, images: string[] }>}
 */
export const generateFixtures = async (outDir, manifest = loadManifest()) => {
  assertManifest(manifest);
  fs.mkdirSync(outDir, { recursive: true });
  const images = [];

  for (const doc of manifest.documents) {
    const pdfPath = path.join(outDir, doc.filename);
    if (doc.render === 'text') {
      await writeTextPdf(pdfPath, doc.lines);
      continue;
    }
    const { png, width, height } = renderScanImage(doc.lines);
    const pngPath = path.join(outDir, doc.image);
    fs.writeFileSync(pngPath, png);
    images.push(pngPath);
    await writeImagePdf(pdfPath, png, width, height);
  }

  return { outDir, count: manifest.documents.length, images };
};
