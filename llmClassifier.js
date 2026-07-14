/**
 * ============================================================================
 * LLM-based document classifier — schema-driven, white-label
 * ============================================================================
 * Builds the system prompt and the structured-output JSON schema dynamically
 * from config/schema.json (see schema.js) instead of hardcoding a fixed set
 * of document types and fields. This is what makes the tool "white-label":
 * a corporate client whose documents are invoices and bank transaction
 * records, and another whose documents are bills and receipts, both work
 * with the same code — only config/schema.json differs. Editing the schema
 * takes effect on the next request; no retraining, unlike the local
 * fine-tuned model backends (see README).
 *
 * Uses Claude's structured outputs (`output_config.format`) so the response
 * is guaranteed to match the schema — no ad-hoc JSON parsing of free-form
 * text.
 * ============================================================================
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDocumentTypes, getDocumentTypeNames, getAllFieldNames, getFields } from './schema.js';

const MODEL = 'claude-opus-4-8';

/** Documents longer than this are truncated (head + tail) before the API call. */
const MAX_CHARS = 12000;

/**
 * Builds the structured-output JSON schema from the configured document
 * types and fields. `fields` always includes every configured field name as
 * a key (not just the ones that apply to the detected type) — Claude is
 * told which fields are relevant per type in the prompt, and returns null
 * for the ones that aren't, which keeps the response shape uniform across
 * every document type (simpler for callers than a shape that varies).
 */
export const buildResponseSchema = () => {
  const fieldProperties = {};
  for (const fieldName of getAllFieldNames()) {
    fieldProperties[fieldName] = { type: ['string', 'null'] };
  }

  return {
    type: 'object',
    properties: {
      documentType: { type: 'string', enum: getDocumentTypeNames() },
      fields: {
        type: 'object',
        properties: fieldProperties,
        required: getAllFieldNames(),
        additionalProperties: false,
      },
    },
    required: ['documentType', 'fields'],
    additionalProperties: false,
  };
};

/**
 * Builds the system prompt from the configured document types and fields —
 * describing what each type means and which fields apply to it, so Claude
 * knows which fields to actually try to fill in for the type it detects.
 */
export const buildSystemPrompt = () => {
  const typeLines = getDocumentTypes()
    .map((t) => `- ${t.name}: ${t.description}${t.keywords?.length ? ` (typical phrases: ${t.keywords.join(', ')})` : ''}`)
    .join('\n');

  const fieldLines = getFields()
    .map((f) => {
      const appliesTo = f.appliesTo?.length ? f.appliesTo.join(', ') : 'any document type';
      const labels = f.labels?.length ? ` Look for labels like: ${f.labels.join(', ')}.` : '';
      return `- ${f.name}: ${f.description} Applies to: ${appliesTo}.${labels}`;
    })
    .join('\n');

  return `You classify business documents and extract structured fields from them.

Document types:
${typeLines}

Fields to extract (only fill in the ones that apply to the document type you detected; return null for every other field):
${fieldLines}

Rules:
- Real documents are messy: labels may be abbreviated, values may appear far from their label (e.g. multi-column forms), and a field may be mislabeled. Use judgment based on the whole document, not just the nearest label.
- Return field values exactly as printed (including case, slashes, dashes) — don't normalize or reformat them.
- If a field is genuinely absent or illegible, return null rather than guessing.
- Always return every field key listed above, using null for any that don't apply or aren't found.`;
};

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic();
  return client;
};

/**
 * Truncates very long documents to a head+tail window so token spend stays
 * bounded. Real business documents are dense near the top (headers, parties,
 * totals) and often repeat identifiers near the bottom (signatures, summary
 * tables), so head+tail loses far less signal than a plain head cut.
 *
 * @param {string} text
 * @returns {string}
 */
const truncateForPrompt = (text) => {
  if (text.length <= MAX_CHARS) return text;
  const headLen = Math.ceil(MAX_CHARS * 0.7);
  const tailLen = MAX_CHARS - headLen;
  return `${text.slice(0, headLen)}\n\n[... truncated ...]\n\n${text.slice(-tailLen)}`;
};

/**
 * Classifies a document's raw text via Claude and extracts its configured
 * fields. Throws on API failure — callers should catch and decide whether
 * to fall back (see `resolveAnalyzer` in index.js).
 *
 * @param {string} rawText Full text content of one PDF.
 * @returns {Promise<{ documentType: string, fields: Record<string, string|null> }>}
 */
export const classifyWithLLM = async (rawText) => {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt(),
    output_config: { format: { type: 'json_schema', schema: buildResponseSchema() } },
    messages: [{ role: 'user', content: truncateForPrompt(rawText) }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new Error(`LLM response had no text block (stop_reason: ${response.stop_reason})`);
  }

  const parsed = JSON.parse(textBlock.text);
  const fields = {};
  for (const fieldName of getAllFieldNames()) {
    fields[fieldName] = parsed.fields?.[fieldName] ?? null;
  }

  return { documentType: parsed.documentType, fields };
};
