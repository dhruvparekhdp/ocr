import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Blob } from 'node:buffer';

import PDFDocument from 'pdfkit';
import { createCanvas, loadImage } from '@napi-rs/canvas';

import { createApp } from '../service.js';
import { generateFixtures, loadManifest } from '../fixtures/generate.js';
import { getFields } from '../schema.js';
import { terminateOcr, ocrWasUsed } from '../ocr.js';
import { encodeRgbTiff } from './helpers/rgbTiff.js';

const TOKEN = 'fixture-service-token';

/** @type {import('http').Server} */
let server;
let baseUrl = '';
let fixtureDir = '';
/** @type {Awaited<ReturnType<typeof loadManifest>>} */
let manifest;

const pdfBuffer = (pages) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    pages.forEach((lines, index) => {
      if (index > 0) doc.addPage();
      for (const line of lines) doc.text(line);
    });
    doc.end();
  });

/**
 * @param {string} url
 * @param {Buffer} bytes
 * @param {string} filename
 * @param {string} mime
 * @param {{ token?: string, docType?: string }} [options]
 */
const postFile = async (url, bytes, filename, mime, options = {}) => {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), filename);
  if (options.docType) form.append('doc_type', options.docType);
  const headers = {};
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  return fetch(url, { method: 'POST', headers, body: form });
};

const extractorByName = () => new Map(getFields().map((field) => [field.name, field.extractor]));

before(async () => {
  manifest = loadManifest();
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-service-fixtures-'));
  await generateFixtures(fixtureDir, manifest);
  server = createApp({ token: TOKEN, debugStore: false, debugDir: path.join(fixtureDir, 'unused-debug') }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
  if (ocrWasUsed()) await terminateOcr();
});

test('GET /v1/health does not require a token', async () => {
  const response = await fetch(`${baseUrl}/v1/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('extract rejects missing and wrong bearer tokens', async () => {
  const bytes = await fs.readFile(path.join(fixtureDir, 'invoice-text.pdf'));
  const missing = await postFile(`${baseUrl}/v1/extract`, bytes, 'invoice-text.pdf', 'application/pdf');
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error, 'unauthorized');

  const wrong = await postFile(`${baseUrl}/v1/extract`, bytes, 'invoice-text.pdf', 'application/pdf', { token: 'nope' });
  assert.equal(wrong.status, 401);
});

test('extract refuses to run when no token is configured', async () => {
  const app = createApp({ token: '' });
  const local = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => local.once('listening', resolve));
  try {
    const bytes = await fs.readFile(path.join(fixtureDir, 'invoice-text.pdf'));
    const response = await postFile(`http://127.0.0.1:${local.address().port}/v1/extract`, bytes, 'invoice-text.pdf', 'application/pdf', {
      token: 'anything',
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'token_not_configured');
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

test('rejects disallowed types, disguised extensions, and oversized uploads', async () => {
  const text = await postFile(`${baseUrl}/v1/extract`, Buffer.from('hello'), 'note.txt', 'text/plain', { token: TOKEN });
  assert.equal(text.status, 415);

  const gif = await postFile(`${baseUrl}/v1/extract`, Buffer.from('GIF89a'), 'anim.gif', 'image/gif', { token: TOKEN });
  assert.equal(gif.status, 415);

  const pdfBytes = await fs.readFile(path.join(fixtureDir, 'invoice-text.pdf'));
  const disguised = await postFile(`${baseUrl}/v1/extract`, pdfBytes, 'invoice.png', 'image/png', { token: TOKEN });
  assert.equal(disguised.status, 415);

  const limited = createApp({ token: TOKEN, maxBytes: 1024 });
  const local = limited.listen(0, '127.0.0.1');
  await new Promise((resolve) => local.once('listening', resolve));
  try {
    const fat = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2048, 0x20)]);
    const response = await postFile(`http://127.0.0.1:${local.address().port}/v1/extract`, fat, 'big.pdf', 'application/pdf', {
      token: TOKEN,
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'payload_too_large');
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

test('rejects PDFs over the page cap before treating them as a successful extract', async () => {
  const limited = createApp({ token: TOKEN, maxPages: 1 });
  const local = limited.listen(0, '127.0.0.1');
  await new Promise((resolve) => local.once('listening', resolve));
  try {
    const bytes = await pdfBuffer([
      ['TAX INVOICE', 'Invoice No: INV-1', 'Invoice Date: 01/01/2024', 'Grand Total: 10.00'],
      ['Second page of the same invoice with more than enough letters'],
    ]);
    const response = await postFile(`http://127.0.0.1:${local.address().port}/v1/extract`, bytes, 'two.pdf', 'application/pdf', {
      token: TOKEN,
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'too_many_pages');
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

test('does not write uploads unless debug store is explicitly on', async () => {
  const offDir = path.join(fixtureDir, 'debug-off');
  const onDir = path.join(fixtureDir, 'debug-on');
  await fs.mkdir(offDir);
  const off = createApp({ token: TOKEN, debugStore: false, debugDir: offDir });
  const offServer = off.listen(0, '127.0.0.1');
  await new Promise((resolve) => offServer.once('listening', resolve));
  const bytes = await fs.readFile(path.join(fixtureDir, 'receipt-text.pdf'));
  try {
    const quiet = await postFile(`http://127.0.0.1:${offServer.address().port}/v1/extract`, bytes, 'receipt-text.pdf', 'application/pdf', {
      token: TOKEN,
    });
    assert.equal(quiet.status, 200);
    assert.deepEqual(await fs.readdir(offDir), []);
    assert.equal((await quiet.json()).warnings.includes('debug_store_enabled'), false);
  } finally {
    await new Promise((resolve) => offServer.close(resolve));
  }

  const on = createApp({ token: TOKEN, debugStore: true, debugDir: onDir });
  const onServer = on.listen(0, '127.0.0.1');
  await new Promise((resolve) => onServer.once('listening', resolve));
  try {
    const stored = await postFile(`http://127.0.0.1:${onServer.address().port}/v1/extract`, bytes, 'receipt-text.pdf', 'application/pdf', {
      token: TOKEN,
    });
    assert.equal(stored.status, 200);
    const body = await stored.json();
    assert.ok(body.warnings.includes('debug_store_enabled'));
    const written = await fs.readdir(onDir);
    assert.equal(written.length, 1);
    const saved = await fs.readFile(path.join(onDir, written[0]));
    assert.deepEqual(saved, bytes);
  } finally {
    await new Promise((resolve) => onServer.close(resolve));
  }
});

test('fixture PDFs for every document type return known fields', { timeout: 180000 }, async () => {
  const methods = extractorByName();
  const seen = new Set();
  for (const doc of manifest.documents) {
    seen.add(doc.documentType);
    const bytes = await fs.readFile(path.join(fixtureDir, doc.filename));
    const response = await postFile(`${baseUrl}/v1/extract`, bytes, doc.filename, 'application/pdf', { token: TOKEN });
    assert.equal(response.status, 200, `${doc.id} status`);
    const body = await response.json();
    assert.equal(body.doc_type, doc.documentType, doc.id);
    assert.ok(body.doc_type_confidence > 0 && body.doc_type_confidence <= 1, doc.id);
    assert.ok(Array.isArray(body.pages) && body.pages.length >= 1, doc.id);
    assert.equal(body.pages[0].page, 1, doc.id);
    assert.equal(typeof body.pages[0].text, 'string', doc.id);
    assert.ok(body.fields.every((field) => field.method !== 'llm'), doc.id);

    for (const [name, expected] of Object.entries(doc.fields)) {
      const applies = (getFields().find((item) => item.name === name)?.appliesTo || []).includes(doc.documentType);
      const field = body.fields.find((item) => item.name === name);
      if (!applies) {
        assert.equal(field, undefined, `${doc.id} ${name} should not be extracted for this type`);
        continue;
      }
      assert.ok(field, `${doc.id} missing ${name}`);
      assert.equal(field.value, expected, `${doc.id} ${name}`);
      assert.equal(field.method, methods.get(name), `${doc.id} ${name} method`);
      if (expected == null) {
        assert.equal(field.confidence, 0, `${doc.id} ${name}`);
        assert.equal(field.page, null, `${doc.id} ${name}`);
        assert.equal(field.bbox, null, `${doc.id} ${name}`);
        assert.ok(body.warnings.includes(`field_not_found:${name}`), `${doc.id} ${name}`);
      } else {
        assert.ok(field.confidence > 0 && field.confidence <= 1, `${doc.id} ${name} confidence`);
        assert.equal(field.page, 1, `${doc.id} ${name} page`);
        assert.ok(Array.isArray(field.bbox) && field.bbox.length === 4, `${doc.id} ${name} bbox`);
        assert.ok(field.bbox.every((value) => Number.isFinite(value)), `${doc.id} ${name} bbox`);
        assert.ok(field.bbox[0] < field.bbox[2] && field.bbox[1] < field.bbox[3], `${doc.id} ${name} bbox order`);
      }
    }
    for (const snippet of doc.textIncludes ?? []) {
      assert.ok(body.pages.some((page) => page.text.includes(snippet)), `${doc.id} missing ${snippet}`);
    }
  }
  for (const documentType of ['Invoice', 'Purchase Order', 'Transaction Record', 'Receipt']) {
    assert.ok(seen.has(documentType), documentType);
  }
});

test('PNG, JPEG, and TIFF invoice scans extract the same known fields', { timeout: 120000 }, async () => {
  const scan = manifest.documents.find((doc) => doc.id === 'invoice-scan');
  const png = await fs.readFile(path.join(fixtureDir, scan.image));
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const jpeg = canvas.toBuffer('image/jpeg', 95);
  const rgba = ctx.getImageData(0, 0, image.width, image.height).data;
  const rgb = Buffer.alloc(image.width * image.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  const tiff = encodeRgbTiff(image.width, image.height, rgb);

  for (const [label, bytes, filename, mime] of [
    ['png', png, 'invoice-scan.png', 'image/png'],
    ['jpeg', jpeg, 'invoice-scan.jpg', 'image/jpeg'],
    ['tiff', tiff, 'invoice-scan.tiff', 'image/tiff'],
  ]) {
    const response = await postFile(`${baseUrl}/v1/extract`, bytes, filename, mime, { token: TOKEN });
    assert.equal(response.status, 200, label);
    const body = await response.json();
    assert.equal(body.doc_type, 'Invoice', label);
    for (const [name, expected] of Object.entries(scan.fields)) {
      const field = body.fields.find((item) => item.name === name);
      assert.equal(field.value, expected, `${label} ${name}`);
      if (expected != null) {
        assert.equal(field.page, 1, `${label} ${name}`);
        assert.ok(field.bbox[2] > field.bbox[0] && field.bbox[3] > field.bbox[1], `${label} ${name}`);
      }
    }
  }
});

test('a doc_type hint overrides classification and an unknown hint does not', async () => {
  const bytes = await fs.readFile(path.join(fixtureDir, 'invoice-text.pdf'));
  const hinted = await postFile(`${baseUrl}/v1/extract`, bytes, 'invoice-text.pdf', 'application/pdf', {
    token: TOKEN,
    docType: 'purchase order',
  });
  assert.equal(hinted.status, 200);
  const hintedBody = await hinted.json();
  assert.equal(hintedBody.doc_type, 'Purchase Order');
  assert.equal(hintedBody.doc_type_confidence, 1);
  assert.ok(hintedBody.warnings.includes('doc_type_hint_applied'));
  assert.equal(hintedBody.fields.find((field) => field.name === 'amount'), undefined);

  const unknown = await postFile(`${baseUrl}/v1/extract`, bytes, 'invoice-text.pdf', 'application/pdf', {
    token: TOKEN,
    docType: 'NotAType',
  });
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.doc_type, 'Invoice');
  assert.ok(unknownBody.warnings.includes('doc_type_hint_unknown'));
  assert.ok(unknownBody.doc_type_confidence < 1);
});
