#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runLocalFixture } from './local.js';

function valueFor(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const root = path.resolve(valueFor(args, '--root') ?? process.cwd());
const inputPath = valueFor(args, '--input');
if (inputPath == null) throw new TypeError('--input <json-file> is required');
const input = JSON.parse(await readFile(path.resolve(inputPath), 'utf8'));
const result = await runLocalFixture({ root, input });
process.stdout.write(`${JSON.stringify(result)}\n`);
