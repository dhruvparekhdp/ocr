/**
 * Seven-page image-only PDF. pdf-parse emits a "-- n of 7 --" banner per
 * page and no document text. Seven banners are 28 alphanumeric characters,
 * which is enough to look like a text PDF if those banners are counted.
 * Each page paints the same short word so OCR has something stable to read.
 */

import fs from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import PDFDocument from 'pdfkit';

const FONT_PATH = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf';
if (fs.existsSync(FONT_PATH)) GlobalFonts.registerFromPath(FONT_PATH, 'ScanFont');

export const SCAN_WORD = 'INVOICE';
export const SCAN_PAGES = 7;

/**
 * @returns {Promise<Buffer>}
 */
export const sevenPageScanPdf = () =>
  new Promise((resolve, reject) => {
    const width = 900;
    const height = 220;
    const font = fs.existsSync(FONT_PATH) ? '36px ScanFont' : '36px sans-serif';
    const images = [];
    for (let page = 1; page <= SCAN_PAGES; page += 1) {
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#000000';
      ctx.font = font;
      ctx.fillText(`${SCAN_WORD} ${page}`, 48, 120);
      images.push(canvas.toBuffer('image/png'));
    }

    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const image of images) {
      doc.addPage({ size: [width, height] });
      doc.image(image, 0, 0, { width });
    }
    doc.end();
  });
