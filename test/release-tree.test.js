import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
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
    const distributedAction = await readFile(path.join(destination, 'action.yml'), 'utf8');
    assert.match(distributedAction, /^# GENERATED DISTRIBUTION COPY/);
    assert.equal(distributedAction.replace(/^.*\n/, ''), await readFile(path.join(workspace, 'action/action.yml'), 'utf8'));
    assert.deepEqual(
      await readFile(path.join(destination, 'dist/index.js')),
      await readFile(path.join(workspace, 'action/dist/index.js'))
    );
    await readFile(path.join(destination, '.github/workflows/publish.yml'));
    await readFile(path.join(destination, '.github/workflows/release-validator.yml'));
    await readFile(path.join(destination, 'v1/validation/package.json'));
    await readFile(path.join(destination, 'action/package.json'));
    assert.match(await readFile(path.join(destination, 'README.md'), 'utf8'), /Do not edit/);
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
    assert.equal((await readdir(path.join(destination, 'action'))).includes('.git'), false);
    const second = await run([destination]);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /must be empty/);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});

test('refuses a destination symlink before staging any generated files', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'gala-release-link-'));
  const destination = path.join(parent, 'destination');
  try {
    await symlink(workspace, destination);
    const result = await run([destination]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /must not be a symbolic link/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('staging the same source twice produces byte-identical resolvable trees', async () => {
  const first = await mkdtemp(path.join(tmpdir(), 'gala-release-tree-a-'));
  const second = await mkdtemp(path.join(tmpdir(), 'gala-release-tree-b-'));
  try {
    assert.equal((await run([first])).code, 0);
    assert.equal((await run([second])).code, 0);
    const compared = await new Promise((resolve, reject) => {
      const child = spawn('diff', ['-ru', first, second]);
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stderr }));
    });
    assert.equal(compared.code, 0, compared.stderr);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
