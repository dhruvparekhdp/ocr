/**
 * Heuristic confidence for the batch report.
 *
 * This is not a model score. A value found on the same line as one of the
 * field's schema labels is 0.9. A fallback (the first date, or the largest
 * amount anywhere) is below the low-confidence line. OCR multiplies the
 * score by 0.8 because the text itself is noisier. The printed value is
 * never changed.
 */

import { getFieldsForType } from './schema.js';
import { splitLines } from './extractors.js';

/** Scores strictly below this are listed as low-confidence. */
export const LOW_CONFIDENCE_BELOW = 0.6;

const LABELED = 0.9;
const FALLBACK = 0.45;
const COMPANY_NAMED = 0.8;
const COMPANY_WEAK = 0.5;
const ADDRESS_OK = 0.65;

const COMPANY_SUFFIX =
  /\b(?:pvt\.?\s*ltd\.?|private\s+limited|ltd\.?|limited|llp|llc|inc\.?|incorporated|corp\.?|corporation|co\.?|company|gmbh|plc|enterprises?|traders?|industries|exports?|imports?)\b/i;

const ADDRESS_HINT =
  /\b(?:road|street|lane|avenue|nagar|marg|estate|plot|sector|district|pin|pincode|zip)\b|\d{5,6}/i;

const round2 = (value) => Math.round(value * 100) / 100;

const onLabeledLine = (lines, labels, value) => {
  const wanted = String(value).toUpperCase();
  return (labels || []).some((label) =>
    lines.some((line) => {
      const upper = line.toUpperCase();
      return upper.includes(String(label).toUpperCase()) && upper.includes(wanted);
    }),
  );
};

/**
 * @param {object} field
 * @param {string} value
 * @param {string[]} lines
 */
const scoreField = (field, value, lines) => {
  if (field.extractor === 'labeledId' || field.extractor === 'date' || field.extractor === 'amount') {
    return onLabeledLine(lines, field.labels, value) ? LABELED : FALLBACK;
  }
  if (field.extractor === 'company') {
    return COMPANY_SUFFIX.test(value) ? COMPANY_NAMED : COMPANY_WEAK;
  }
  if (field.extractor === 'address') {
    return ADDRESS_HINT.test(value) ? ADDRESS_OK : FALLBACK;
  }
  return onLabeledLine(lines, field.labels, value) ? LABELED : FALLBACK;
};

/**
 * @param {{ text: string, documentType: string, fields: Record<string, string|null>, source?: string }} doc
 * @returns {Array<{ name: string, value: string, confidence: number, low: boolean }>}
 */
export const scoreDocumentFields = (doc) => {
  const lines = splitLines(doc.text || '');
  const ocrFactor = doc.source === 'ocr' ? 0.8 : 1;
  const scored = [];
  for (const field of getFieldsForType(doc.documentType)) {
    const value = doc.fields?.[field.name];
    if (value == null || value === '') continue;
    const confidence = round2(scoreField(field, value, lines) * ocrFactor);
    scored.push({
      name: field.name,
      value,
      confidence,
      low: confidence < LOW_CONFIDENCE_BELOW,
    });
  }
  return scored;
};
