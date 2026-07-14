/**
 * ============================================================================
 * LLM-based document classifier
 * ============================================================================
 * Replaces brittle keyword/regex matching with a single Claude call per
 * document. This generalises far better than hand-tuned patterns: real
 * customs/export paperwork varies wildly in template, wording, and layout
 * (see README — "Proforma Invoice" acting as a PO, mislabeled fields,
 * multi-column EDI printouts that scramble label→value proximity), and each
 * new document family used to mean writing new regexes. An LLM reads the
 * document the way a person would and just gets it right.
 *
 * Uses Claude's structured outputs (`output_config.format`) so the response
 * is guaranteed to match the schema below — no ad-hoc JSON parsing of
 * free-form text.
 * ============================================================================
 */

import Anthropic from '@anthropic-ai/sdk';
import { DOC_TYPES } from './docTypes.js';

const MODEL = 'claude-opus-4-8';

/** Documents longer than this are truncated (head + tail) before the API call. */
const MAX_CHARS = 12000;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    documentType: {
      type: 'string',
      enum: [DOC_TYPES.PO, DOC_TYPES.INVOICE, DOC_TYPES.AWB_BL, DOC_TYPES.SHIPPING_BILL, DOC_TYPES.UNKNOWN],
      description:
        'The document type. PO covers purchase orders and the documents that ' +
        'functionally anchor a purchase (e.g. a Proforma Invoice or Packing ' +
        'List that the actual invoice references as its order reference), ' +
        'even when not literally titled "Purchase Order".',
    },
    invoiceNumber: {
      type: ['string', 'null'],
      description:
        'The commercial/tax invoice number for this shipment, as printed on the ' +
        'document (whatever label it appears under: Invoice No, Inv #, or a bare ' +
        'reference number used consistently across the invoice/BL/shipping-bill ' +
        'set). Null for PO-type documents, which never carry an invoice number.',
    },
    poNumber: {
      type: ['string', 'null'],
      description:
        'The purchase-order / proforma-invoice / purchase-reference number for ' +
        'this shipment — the identifier a PO-type document is itself known by, ' +
        'or that an Invoice references back to its originating PO. Null when ' +
        'the document does not carry one (typically AWB_BL and Shipping Bill).',
    },
  },
  required: ['documentType', 'invoiceNumber', 'poNumber'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You classify trade/shipping documents and extract two identifiers.

Document types:
- PO: purchase orders, and documents that functionally serve as the purchase anchor even under a different name (e.g. a Proforma Invoice or Packing List that an Invoice's PO/reference field points back to).
- Invoice: commercial invoices, tax invoices, any billing document from seller to buyer.
- AWB_BL: air waybills and bills of lading (including sea waybills) — transport/carrier documents.
- Shipping Bill: customs export declarations (shipping bill / EDI printouts / "LET EXPORT COPY" style documents).
- Unknown: anything that doesn't fit, or has no recognisable business-document identity.

Identifier rules:
- invoiceNumber: the invoice/commercial-reference number that ties an Invoice, AWB_BL, and Shipping Bill together for one shipment. PO documents never have one — always null.
- poNumber: the purchase-order/proforma/reference number that ties a PO-type document to the Invoice that references it. AWB_BL and Shipping Bill documents typically don't carry one — null unless clearly present.
- Real documents are messy: labels may be abbreviated, values may appear far from their label (multi-column customs forms), and a document may use one field for a value that's semantically something else (e.g. a "Bill of Lading No." field mistakenly showing the invoice number). Use judgment based on the whole document, not just the nearest label.
- Normalise nothing — return identifiers exactly as printed (including case, slashes, dashes).
- If genuinely absent or illegible, return null rather than guessing.`;

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic();
  return client;
};

/**
 * Truncates very long documents to a head+tail window so token spend stays
 * bounded. Real invoices/BLs/shipping bills are dense near the top (headers,
 * parties, totals) and often repeat identifiers near the bottom (signatures,
 * summary tables), so head+tail loses far less signal than a plain head cut.
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
 * Classifies a document's raw text via Claude and extracts its key
 * identifiers. Throws on API failure — callers should catch and decide
 * whether to fall back (see `resolveAnalyzer` in index.js).
 *
 * @param {string} rawText Full text content of one PDF.
 * @returns {Promise<{ documentType: string, invoiceNumber: string|null, poNumber: string|null }>}
 */
export const classifyWithLLM = async (rawText) => {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    messages: [{ role: 'user', content: truncateForPrompt(rawText) }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new Error(`LLM response had no text block (stop_reason: ${response.stop_reason})`);
  }

  const parsed = JSON.parse(textBlock.text);
  return {
    documentType: parsed.documentType,
    invoiceNumber: parsed.invoiceNumber ?? null,
    poNumber: parsed.poNumber ?? null,
  };
};
