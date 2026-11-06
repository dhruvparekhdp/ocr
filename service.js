/**
 * OCR extract service.
 *
 *   GET  /v1/health
 *   POST /v1/extract    multipart field "file", optional field "doc_type"
 *
 * Binds to 127.0.0.1 unless OCR_SERVICE_HOST is set. Requires
 * Authorization: Bearer <OCR_SERVICE_TOKEN> on /v1/extract. Health is open
 * so a local probe does not need the token; it returns no document data.
 *
 * Uploads stay in memory. Bytes are written only when
 * OCR_SERVICE_DEBUG_STORE=1, under OCR_SERVICE_DEBUG_DIR (or a temp dir).
 * There is no LLM path.
 *
 *   node service.js
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import express from 'express';
import multer from 'multer';

import { extractDocument } from './extractDocument.js';
import { detectMedia } from './pageIngest.js';
import { ServiceError } from './serviceError.js';
import { terminateOcr } from './ocr.js';

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 20;

const EXTENSIONS = {
  pdf: ['.pdf'],
  png: ['.png'],
  jpeg: ['.jpg', '.jpeg'],
  tiff: ['.tif', '.tiff'],
};

/**
 * @param {object} [overrides]
 */
export const resolveServiceConfig = (overrides = {}) => {
  const debugRaw = overrides.debugStore ?? process.env.OCR_SERVICE_DEBUG_STORE;
  return {
    token: overrides.token ?? process.env.OCR_SERVICE_TOKEN ?? '',
    host: overrides.host ?? process.env.OCR_SERVICE_HOST ?? '127.0.0.1',
    port: Number(overrides.port ?? process.env.OCR_SERVICE_PORT ?? 8080),
    maxBytes: Number(overrides.maxBytes ?? process.env.OCR_SERVICE_MAX_BYTES ?? DEFAULT_MAX_BYTES),
    maxPages: Number(overrides.maxPages ?? process.env.OCR_SERVICE_MAX_PAGES ?? DEFAULT_MAX_PAGES),
    debugStore: debugRaw === true || debugRaw === '1',
    debugDir: overrides.debugDir ?? process.env.OCR_SERVICE_DEBUG_DIR ?? path.join(os.tmpdir(), 'ocr-service-debug'),
  };
};

/**
 * SHA-256 both sides so timingSafeEqual does not throw on different lengths
 * and the token itself is not branched on character by character.
 *
 * @param {string} provided
 * @param {string} expected
 */
const tokenMatches = (provided, expected) => {
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
};

const bearerToken = (header) => {
  if (!header || typeof header !== 'string') return '';
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : '';
};

/**
 * @param {object} [overrides]
 */
export const createApp = (overrides = {}) => {
  const config = resolveServiceConfig(overrides);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: config.maxBytes },
  });

  const app = express();
  app.disable('x-powered-by');

  app.get('/v1/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/v1/extract', upload.single('file'), async (req, res) => {
    try {
      if (!config.token) {
        throw new ServiceError('token_not_configured', 503, 'OCR_SERVICE_TOKEN is not set.');
      }
      if (!tokenMatches(bearerToken(req.headers.authorization), config.token)) {
        throw new ServiceError('unauthorized', 401, 'Bearer token is missing or wrong.');
      }
      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        throw new ServiceError('empty_upload', 400, 'Multipart field "file" is required.');
      }

      const media = detectMedia(file.buffer);
      const extension = path.extname(file.originalname || '').toLowerCase();
      if (!media || !EXTENSIONS[media].includes(extension)) {
        throw new ServiceError('unsupported_media_type', 415, 'Only PDF, PNG, JPEG, and TIFF are accepted.');
      }

      const warnings = [];
      if (config.debugStore) {
        fs.mkdirSync(config.debugDir, { recursive: true });
        const stored = path.join(config.debugDir, crypto.randomBytes(8).toString('hex'));
        fs.writeFileSync(stored, file.buffer, { mode: 0o600 });
        warnings.push('debug_store_enabled');
      }

      const extracted = await extractDocument(file.buffer, {
        maxPages: config.maxPages,
        docTypeHint: typeof req.body?.doc_type === 'string' ? req.body.doc_type : '',
      });
      extracted.warnings = [...warnings, ...extracted.warnings];
      res.json(extracted);
    } catch (error) {
      if (error instanceof ServiceError) {
        res.status(error.status).json({ error: error.code, message: error.publicMessage });
        return;
      }
      res.status(500).json({ error: 'extract_failed', message: 'Could not read the document.' });
    }
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'payload_too_large', message: 'File exceeds the size limit.' });
      return;
    }
    if (err instanceof multer.MulterError) {
      res.status(400).json({ error: 'invalid_upload', message: 'Upload was rejected.' });
      return;
    }
    res.status(500).json({ error: 'extract_failed', message: 'Could not read the document.' });
  });

  return app;
};

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const config = resolveServiceConfig();
  const server = createApp().listen(config.port, config.host, () => {
    console.log(`OCR service listening on http://${config.host}:${config.port}`);
  });
  const shutdown = async () => {
    server.close();
    await terminateOcr();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
