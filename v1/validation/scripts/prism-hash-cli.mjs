import { readFile } from 'node:fs/promises';
import {
  canonicalJson,
  markdownBodyHashV2,
  normalizedMarkdownBytes
} from '../src/prism-hashing.js';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('usage: prism-hash-cli.mjs <ndjson-file>');

const rows = (await readFile(inputPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
for (const row of rows) {
  try {
    if (row.kind === 'markdown') {
      const input = Buffer.from(row.inputBase64, 'base64');
      process.stdout.write(`${JSON.stringify({
        id: row.id,
        ok: true,
        normalizedBase64: normalizedMarkdownBytes(input).toString('base64'),
        digest: markdownBodyHashV2(input)
      })}\n`);
    } else if (row.kind === 'canonical-json') {
      process.stdout.write(`${JSON.stringify({ id: row.id, ok: true, canonical: canonicalJson(row.input) })}\n`);
    } else {
      throw new TypeError(`unknown case kind: ${row.kind}`);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: row.id, ok: false, errorClass: error.constructor.name })}\n`);
  }
}
