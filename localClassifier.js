/**
 * ============================================================================
 * Local (self-hosted) classifier client
 * ============================================================================
 * Calls a locally-served, fine-tuned model (see local-llm/serve.py) instead
 * of the Claude API. Same interface as classifyWithLLM() in llmClassifier.js
 * so resolveAnalyzer() in index.js can swap between "llm" (Claude),
 * "regex" (keyword fallback), and "local" (your fine-tuned model)
 * interchangeably.
 *
 * Requires a local server already running:
 *   python3 local-llm/serve.py --base-model <...> --adapter <checkpoint dir>
 * ============================================================================
 */

import { DOC_TYPES } from './docTypes.js';

const DEFAULT_LOCAL_LLM_URL = 'http://127.0.0.1:8008';

/**
 * Classifies a document's raw text via the local fine-tuned model server.
 * Throws on failure (server unreachable, non-2xx response, malformed body)
 * so callers handle it the same way as any other per-file failure — see
 * `resolveAnalyzer` in index.js.
 *
 * @param {string} rawText Full text content of one PDF.
 * @returns {Promise<{ documentType: string, invoiceNumber: string|null, poNumber: string|null }>}
 */
export const classifyWithLocalLLM = async (rawText) => {
  const baseUrl = process.env.LOCAL_LLM_URL || DEFAULT_LOCAL_LLM_URL;

  const response = await fetch(`${baseUrl}/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: rawText }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Local model server returned ${response.status}: ${body.slice(0, 200)}`);
  }

  const parsed = await response.json();

  const validTypes = new Set(Object.values(DOC_TYPES));
  if (!validTypes.has(parsed.documentType)) {
    throw new Error(`Local model returned an invalid documentType: ${JSON.stringify(parsed.documentType)}`);
  }

  return {
    documentType: parsed.documentType,
    invoiceNumber: parsed.invoiceNumber ?? null,
    poNumber: parsed.poNumber ?? null,
  };
};
