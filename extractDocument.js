/**
 * Deterministic extract used by POST /v1/extract.
 * No LLM. Field values come from the existing schema heuristics. Confidence
 * is a fixed score for how the heuristic matched, lowered when the value is
 * located in OCR tokens whose own confidence is worse. `method` is the
 * schema extractor name (`labeledId`, `company`, `address`, `date`, `amount`).
 */

import { getDocumentTypeNames, getFieldsForType } from './schema.js';
import { scoreDocument } from './analyze.js';
import { runExtractor, splitLines } from './extractors.js';
import { ingestBuffer } from './pageIngest.js';

const round4 = (value) => Math.round(value * 10000) / 10000;

const LABELED = 0.9;
const FALLBACK = 0.55;

/**
 * @param {string} value
 * @param {string[]} lines
 * @param {string[]} labels
 */
const labeledLineHasValue = (value, lines, labels) => {
  const wanted = value.toUpperCase();
  return labels.some((label) => {
    const needle = label.toUpperCase();
    return lines.some((line) => {
      const upper = line.toUpperCase();
      return upper.includes(needle) && upper.includes(wanted);
    });
  });
};

/**
 * @param {object} field
 * @param {string|null} value
 * @param {string[]} lines
 */
const heuristicConfidence = (field, value, lines) => {
  if (value == null) return 0;
  if (field.extractor === 'company') {
    return /\b(?:pvt|ltd|llc|llp|inc|limited|gmbh)\b/i.test(value) ? 0.85 : 0.5;
  }
  if (field.extractor === 'address') return 0.7;
  const labels = field.labels || [];
  if (field.extractor === 'labeledId' || field.extractor === 'date' || field.extractor === 'amount') {
    return labeledLineHasValue(value, lines, labels) ? LABELED : FALLBACK;
  }
  return FALLBACK;
};

/**
 * @param {string} value
 * @param {Array<{ text: string, confidence: number, page: number, bbox: number[] }>} tokens
 */
const locateValue = (value, tokens) => {
  const normalize = (text) => text.replace(/[^A-Za-z0-9./-]+/g, '').toUpperCase();
  const target = normalize(value);
  if (!target) return null;
  let blob = '';
  /** @type {typeof tokens} */
  const owners = [];
  for (const token of tokens) {
    const normalized = normalize(token.text);
    for (let i = 0; i < normalized.length; i += 1) owners.push(token);
    blob += normalized;
  }
  const index = blob.indexOf(target);
  if (index < 0) return null;
  const used = owners.slice(index, index + target.length);
  const bbox = [
    Math.min(...used.map((token) => token.bbox[0])),
    Math.min(...used.map((token) => token.bbox[1])),
    Math.max(...used.map((token) => token.bbox[2])),
    Math.max(...used.map((token) => token.bbox[3])),
  ].map((coord) => Math.round(coord * 10) / 10);
  const confidence = used.reduce((sum, token) => sum + token.confidence, 0) / used.length;
  return { page: used[0].page, bbox, confidence };
};

/**
 * @param {Buffer} buffer
 * @param {{ maxPages: number, docTypeHint?: string }} options
 */
export const extractDocument = async (buffer, options) => {
  const ingested = await ingestBuffer(buffer, { maxPages: options.maxPages });
  const fullText = ingested.pages.map((page) => page.text).join('\n\n');
  const scored = scoreDocument(fullText);
  const warnings = [...ingested.warnings];

  let docType = scored.documentType;
  let docTypeConfidence = scored.confidence;
  const hint = (options.docTypeHint || '').trim();
  if (hint) {
    const canonical = getDocumentTypeNames().find((name) => name.toLowerCase() === hint.toLowerCase());
    if (!canonical || canonical === 'Unknown') {
      warnings.push('doc_type_hint_unknown');
    } else {
      docType = canonical;
      docTypeConfidence = 1;
      warnings.push('doc_type_hint_applied');
    }
  }

  // Extract the resolved type's fields with the same heuristics as the CLI.
  // A doc_type hint changes which fields apply; it does not change the matchers.
  const lines = splitLines(fullText);
  const doc = { text: fullText.replace(/\s+/g, ' '), lines };
  const fields = getFieldsForType(docType).map((field) =>
    buildField(field, runExtractor(field, doc), lines, ingested.tokens, warnings),
  );

  if (!fullText.trim()) warnings.push('empty_text');

  return {
    doc_type: docType,
    doc_type_confidence: round4(docTypeConfidence),
    pages: ingested.pages.map((page) => ({ page: page.page, text: page.text })),
    fields,
    warnings,
  };
};

/**
 * @param {object} field
 * @param {string|null} value
 * @param {string[]} lines
 * @param {Array<{ text: string, confidence: number, page: number, bbox: number[] }>} tokens
 * @param {string[]} warnings
 */
const buildField = (field, value, lines, tokens, warnings) => {
  const method = field.extractor || 'none';
  if (value == null) {
    warnings.push(`field_not_found:${field.name}`);
    return { name: field.name, value: null, confidence: 0, page: null, bbox: null, method };
  }
  const located = locateValue(value, tokens);
  const heuristic = heuristicConfidence(field, value, lines);
  const confidence = located ? Math.min(heuristic, located.confidence) : heuristic;
  if (!located) warnings.push(`bbox_not_found:${field.name}`);
  return {
    name: field.name,
    value,
    confidence: round4(confidence),
    page: located ? located.page : null,
    bbox: located ? located.bbox : null,
    method,
  };
};
