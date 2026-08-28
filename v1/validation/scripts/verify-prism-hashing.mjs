import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
};
const seed = option('--seed', 1);
const count = option('--cases', 2000);
if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(count) || count < 1) {
  throw new TypeError('--seed and --cases must be positive safe integers');
}

let state = seed >>> 0;
const random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 0x100000000;
};
const pick = (values) => values[Math.floor(random() * values.length)];
const text = () => Array.from({ length: 1 + Math.floor(random() * 16) }, () =>
  pick(['a', 'Z', 'é', 'e\u0301', '中', '🙂', ' ', '\t'])).join('');

const rows = [];
for (let index = 0; index < count; index += 1) {
  if (index % 2 === 0) {
    const separator = pick(['\n', '\r\n', '\r']);
    const value = `${text()}${separator}${text()}${random() > 0.5 ? separator : ''}`;
    const bytes = Buffer.concat([random() > 0.8 ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(value)]);
    rows.push({ id: `m-${index}`, kind: 'markdown', inputBase64: bytes.toString('base64') });
  } else {
    const entries = [
      ['z', { nested: [text(), index, true, null] }],
      ['a', text()],
      ['n', Math.floor(random() * 100000) / 10]
    ];
    if (random() > 0.5) entries.reverse();
    rows.push({ id: `j-${index}`, kind: 'canonical-json', input: JSON.stringify(Object.fromEntries(entries)) });
  }
}
rows.push({ id: 'invalid-utf8', kind: 'markdown', inputBase64: Buffer.from([0xc3, 0x28]).toString('base64') });
rows.push({ id: 'normalized-key-collision', kind: 'canonical-json', input: '{"é":1,"e\\u0301":2}' });

const directory = await mkdtemp(path.join(tmpdir(), 'gala-prism-hashing-'));
const inputPath = path.join(directory, 'input.ndjson');
const expectedPath = path.join(directory, 'expected.ndjson');
try {
  await writeFile(inputPath, `${rows.map(JSON.stringify).join('\n')}\n`);
  const node = spawnSync(process.execPath, [new URL('./prism-hash-cli.mjs', import.meta.url).pathname, inputPath], { encoding: 'utf8' });
  if (node.status !== 0) throw new Error(`Node hash CLI failed:\n${node.stderr}`);
  await writeFile(expectedPath, node.stdout);

  const apiDirectory = path.resolve(new URL('../../../../api/api', import.meta.url).pathname);
  const gradle = spawnSync('./gradlew', [
    'test', '--rerun-tasks', '--tests', 'io.gala.api.prism.PrismCrossRuntimePropertyTest'
  ], {
    cwd: apiDirectory,
    encoding: 'utf8',
    env: { ...process.env, PRISM_CASE_INPUT: inputPath, PRISM_CASE_EXPECTED: expectedPath, PRISM_CASE_SEED: String(seed) }
  });
  if (gradle.status !== 0) {
    await writeFile(path.resolve(`prism-hashing-failure-seed-${seed}.txt`), `${seed}\n`);
    throw new Error(`Java cross-runtime verification failed for seed ${seed}:\n${gradle.stdout}\n${gradle.stderr}`);
  }
  const verified = (await readFile(expectedPath, 'utf8')).split('\n').filter(Boolean).length;
  process.stdout.write(`Verified ${verified} Prism hash cases across Node and Java (seed ${seed}).\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
