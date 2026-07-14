/**
 * ============================================================================
 * PDF Batch Classifier — Web Upload Server
 * ============================================================================
 * Serves a single-page bulk uploader (public/index.html) and a POST endpoint
 * that runs the existing classification/batching pipeline (index.js) over
 * the uploaded PDFs entirely in memory — nothing is written to disk.
 *
 * Usage:
 *   node server.js [port]   (default port 3000, or $PORT)
 * ============================================================================
 */

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { processBuffers, segregateIntoBatches } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_FILES = 200;
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB per file

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const isPdf =
      file.mimetype === 'application/pdf' ||
      path.extname(file.originalname).toLowerCase() === '.pdf';
    cb(isPdf ? null : new Error(`Rejected non-PDF file: ${file.originalname}`), isPdf);
  },
});

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/classify', upload.array('documents', MAX_FILES), async (req, res) => {
  const uploadedFiles = req.files ?? [];

  if (uploadedFiles.length === 0) {
    return res.status(400).json({ error: 'No PDF files were uploaded.' });
  }

  const started = Date.now();
  const files = uploadedFiles.map((f) => ({ fileName: f.originalname, buffer: f.buffer }));

  try {
    const { analyzedDocs, errors } = await processBuffers(files);
    const { batches, unbatched } = segregateIntoBatches(analyzedDocs);

    res.json({
      generatedAt: new Date().toISOString(),
      summary: {
        totalPdfs: analyzedDocs.length + errors.length,
        analyzed: analyzedDocs.length,
        failed: errors.length,
        batches: Object.keys(batches).length,
        unbatchedGroups: Object.keys(unbatched).length,
        durationMs: Date.now() - started,
      },
      batches,
      unbatched,
      errors,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Multer errors (too many files, file too large, non-PDF) land here.
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Unexpected server error.' });
});

const port = Number(process.argv[2] ?? process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`📄 PDF Batch Classifier running at http://localhost:${port}`);
});
