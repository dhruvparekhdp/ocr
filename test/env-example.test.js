import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('.env.example lists variable names and no values', () => {
  const text = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const names = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    assert.match(trimmed, /^[A-Z][A-Z0-9_]*=$/, `value or bad name in .env.example: ${trimmed}`);
    names.push(trimmed.slice(0, -1));
  }
  assert.deepEqual(names.sort(), ['PORT', 'SCHEMA_PATH']);
});
