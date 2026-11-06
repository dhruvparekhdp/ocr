import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('system tesseract is installed', () => {
  const result = spawnSync('tesseract', ['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(`${result.stdout}\n${result.stderr}`, /tesseract\s+\d/i);
});

test('poppler pdftotext is installed', () => {
  const result = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(`${result.stdout}\n${result.stderr}`, /pdftotext/i);
});

test('Liberation Sans is available for scan fixtures', () => {
  const candidates = [
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  ];
  assert.ok(
    candidates.some((candidate) => fs.existsSync(candidate)),
    `Install fonts-liberation. Looked in ${candidates.join(', ')}`,
  );
});
