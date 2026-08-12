import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = path.resolve(import.meta.dirname, '../..');
const script = path.join(workspace, 'action/scripts/stage-release-tree.js');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: workspace });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}

test('stages the runtime and reusable workflow at GitHub-resolvable root paths', async () => {
  const destination = await mkdtemp(path.join(tmpdir(), 'gala-release-tree-'));
  try {
    const result = await run([destination]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      await readFile(path.join(destination, 'action.yml')),
      await readFile(path.join(workspace, 'action/action.yml'))
    );
    assert.deepEqual(
      await readFile(path.join(destination, 'dist/index.js')),
      await readFile(path.join(workspace, 'action/dist/index.js'))
    );
    await readFile(path.join(destination, '.github/workflows/publish.yml'));
    await readFile(path.join(destination, '.github/workflows/release-validator.yml'));
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});

test('excludes dependency directories and refuses a non-empty destination', async () => {
  const destination = await mkdtemp(path.join(tmpdir(), 'gala-release-tree-'));
  try {
    const first = await run([destination]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal((await readdir(path.join(destination, 'v1/validation'))).includes('node_modules'), false);
    const second = await run([destination]);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /must be empty/);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});
