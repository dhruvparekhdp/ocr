/**
 * ============================================================================
 * Schema loader — the white-label configuration layer
 * ============================================================================
 * A single JSON file (config/schema.json by default, override with
 * SCHEMA_PATH) defines everything a corporate deployment needs to be
 * different from another: product branding, which document types exist, and
 * which fields to extract from each. Every backend (Claude, regex fallback,
 * batching) reads from this one place, so onboarding a new client — or
 * adding "Transaction Record" alongside "Invoice" — is a config file edit,
 * not a code change.
 *
 * The local fine-tuned model backends (local-llm/) also read this same file
 * (their Python side loads it independently) — but for them, a schema change
 * requires retraining, since document types/fields are baked into a trained
 * classification head and tag set. Only the Claude-based backend adapts to a
 * schema change instantly, with no retraining. See README.
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_SCHEMA_PATH = path.join(process.cwd(), 'config', 'schema.json');

let cachedSchema = null;

/**
 * Loads and validates the schema config. Memoized for the process lifetime —
 * restart the process to pick up an edited schema file (keeps every
 * consumer trivially consistent within one run, same rationale as
 * resolveAnalyzer's memoization in index.js).
 *
 * @returns {object} The parsed schema config.
 */
export const loadSchema = () => {
  if (cachedSchema) return cachedSchema;

  const schemaPath = process.env.SCHEMA_PATH || DEFAULT_SCHEMA_PATH;
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw);

  if (!Array.isArray(schema.documentTypes) || schema.documentTypes.length === 0) {
    throw new Error(`Schema at ${schemaPath} has no documentTypes`);
  }
  if (!Array.isArray(schema.fields)) {
    throw new Error(`Schema at ${schemaPath} has no fields array`);
  }

  cachedSchema = schema;
  return cachedSchema;
};

/** @returns {string[]} All configured document type names, in schema order. */
export const getDocumentTypeNames = () => loadSchema().documentTypes.map((t) => t.name);

/** @returns {object[]} The full documentTypes config array (name, description, keywords, keywordWeight). */
export const getDocumentTypes = () => loadSchema().documentTypes;

/** @returns {object[]} The full fields config array (name, description, labels, appliesTo, isBatchKey). */
export const getFields = () => loadSchema().fields;

/** @returns {string[]} All field names configured anywhere (the union across document types). */
export const getAllFieldNames = () => getFields().map((f) => f.name);

/**
 * @param {string} documentType
 * @returns {object[]} Field configs that apply to this document type (empty array if the type isn't found or has no fields).
 */
export const getFieldsForType = (documentType) =>
  getFields().filter((f) => !f.appliesTo || f.appliesTo.includes(documentType));

/** @returns {string[]} Field names marked isBatchKey: true, in schema order — see segregateIntoBatches in index.js. */
export const getBatchKeyFields = () => getFields().filter((f) => f.isBatchKey).map((f) => f.name);

/** @returns {{ productName: string, primaryColor: string, logoUrl: string|null }} Branding config for the web UI. */
export const getBranding = () => {
  const schema = loadSchema();
  return {
    productName: schema.productName || 'Document Classifier',
    primaryColor: schema.primaryColor || '#4f8cff',
    logoUrl: schema.logoUrl || null,
  };
};

/** Test-only: clears the memoized schema so a test can load a different SCHEMA_PATH. Not used in production code paths. */
export const _resetSchemaCache = () => {
  cachedSchema = null;
};
