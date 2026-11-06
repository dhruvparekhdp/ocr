/**
 * Text-layer PDFs for samples and tests. The wide page keeps a GST line
 * (HSN, taxable, CGST, SGST, IGST, line total) on one physical line. A
 * wrapped line splits the line total away from its HSN and the checker
 * then warns about a line it could not read.
 */

import PDFDocument from 'pdfkit';

/**
 * @param {string[]} lines
 * @param {{ wide?: boolean }} [options]
 * @returns {Promise<Buffer>}
 */
export const renderTextPdf = (lines, { wide = false } = {}) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument(wide ? { size: [1200, 1600], margin: 36 } : {});
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(wide ? 10 : 12);
    for (const line of lines) doc.text(line);
    doc.end();
  });
