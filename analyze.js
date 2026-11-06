/**
 * ============================================================================
 * Document analysis — classify + extract (from-scratch, no LLM)
 * ============================================================================
 * Given a document's plain text, decides which document type it is (keyword
 * scoring over the types in config/schema.json) and extracts the fields that
 * apply to that type (via extractors.js). This is the whole "understanding"
 * layer — deterministic, offline, inspectable, no model.
 * ============================================================================
 */

import { getDocumentTypes, getFields, getFieldsForType } from './schema.js';
import { runExtractor, splitLines } from './extractors.js';

const UNKNOWN_TYPE = 'Unknown';

/**
 * Builds one weighted keyword rule per configured document type. A document
 * is scored per type by summing that type's keywordWeight for each of its
 * keywords found in the text; the highest score wins. Memoized so the RegExp
 * objects are built once per process, not per document.
 */
let cachedRules = null;
const buildClassificationRules = () => {
  if (cachedRules) return cachedRules;
  cachedRules = getDocumentTypes()
    .filter((t) => t.name !== UNKNOWN_TYPE)
    .map((t) => ({
      type: t.name,
      weight: t.keywordWeight ?? 5,
      keywords: (t.keywords || []).map((phrase) => {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        return new RegExp(`\\b${escaped}\\b`, 'i');
      }),
    }));
  return cachedRules;
};

/**
 * Classifies collapsed text and reports how much of the winning type's
 * keyword weight actually matched. Confidence is that fraction in [0, 1].
 * Unknown (no hits) is 0. Ties keep the earlier schema type.
 *
 * @param {string} collapsedText
 * @returns {{ documentType: string, confidence: number }}
 */
const scoreCollapsed = (collapsedText) => {
  let best = UNKNOWN_TYPE;
  let bestScore = 0;
  let bestPossible = 0;
  for (const rule of buildClassificationRules()) {
    const hits = rule.keywords.reduce((sum, re) => (re.test(collapsedText) ? sum + 1 : sum), 0);
    const score = hits * rule.weight;
    const possible = rule.keywords.length * rule.weight;
    if (score > bestScore) {
      bestScore = score;
      best = rule.type;
      bestPossible = possible;
    }
  }
  return {
    documentType: best,
    confidence: bestPossible > 0 ? bestScore / bestPossible : 0,
  };
};

/**
 * Classifies raw text into one of the configured document types.
 *
 * @param {string} collapsedText Whitespace-collapsed single-line text.
 * @returns {string} A document type name (or "Unknown").
 */
const classify = (collapsedText) => scoreCollapsed(collapsedText).documentType;

/**
 * Same classifier as {@link analyzeText}, plus a deterministic confidence.
 * The service API uses this. The batch CLI still uses {@link analyzeText}.
 *
 * @param {string} rawText
 * @returns {{ documentType: string, confidence: number }}
 */
export const scoreDocument = (rawText) => scoreCollapsed(rawText.replace(/\s+/g, ' '));

/**
 * Classifies a document and extracts its applicable fields.
 *
 * @param {string} rawText Full text of one document (from pdfIngest).
 * @returns {{ documentType: string, fields: Record<string, string|null> }}
 */
export const analyzeText = (rawText) => {
  const collapsedText = rawText.replace(/\s+/g, ' ');
  const lines = splitLines(rawText);
  const doc = { text: collapsedText, lines };

  const documentType = classify(collapsedText);
  const applicable = new Set(getFieldsForType(documentType).map((f) => f.name));

  const fields = {};
  for (const field of getFields()) {
    fields[field.name] = applicable.has(field.name) ? runExtractor(field, doc) : null;
  }

  return { documentType, fields };
};
