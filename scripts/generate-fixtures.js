/**
 * CLI for fixtures/generate.js. Default output is ./fixtures/out (gitignored).
 * Usage: node scripts/generate-fixtures.js [outputDir]
 */

import path from 'node:path';
import process from 'node:process';
import { generateFixtures } from '../fixtures/generate.js';

const outDir = path.resolve(process.argv[2] ?? './fixtures/out');
const result = await generateFixtures(outDir);
console.log(`Wrote ${result.count} synthetic fixtures to ${outDir}`);
