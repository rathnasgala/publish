import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const actionRoot = path.resolve(import.meta.dirname, '..');
const siteId = '01K00000000000000000000010';
const commitSha = 'a'.repeat(40);
const secret = '0123456789abcdef0123456789abcdef';
const execFileAsync = promisify(execFile);

test('committed bundle contains the validator and executes the public contract', async () => {
  const bundle = await readFile(path.join(actionRoot, 'dist', 'index.js'), 'utf8');
  assert.match(bundle, /reconciliation-envelope/);
  assert.match(bundle, /0\.0\.2/);

  const inputs = {
    operation: 'build',
    mode: 'build-only',
    'site-id': siteId,
    'site-secret': secret,
    'api-base-url': 'https://api.example.com',
    'output-directory': '_site',
    timezone: 'UTC',
    'config-path': 'site.config.yml',
    'floor-guard-percent': '20',
    'floor-guard-pages': '25',
    'floor-guard-override-commit-sha': '',
    'deployed-commit-sha': '',
    'recorded-state-sha': '',
    'run-id': '42',
    'run-attempt': '1'
  };
  const isolated = await mkdtemp(path.join(tmpdir(), 'gala-isolated-bundle-'));
  await copyFile(path.join(actionRoot, 'dist', 'index.js'), path.join(isolated, 'index.js'));
  await writeFile(path.join(isolated, 'package.json'), '{"type":"module"}\n');
  const module = await import(`${path.join(isolated, 'index.js')}?test=${Date.now()}`);
  const outputs = new Map();
  const secrets = [];
  const result = await module.runEntrypoint({
    getInput: (name) => inputs[name] ?? '',
    setOutput: (name, value) => outputs.set(name, value),
    setSecret: (value) => secrets.push(value),
    env: { GITHUB_SHA: commitSha },
    adapters: {},
    run: async () => ({
      outcome: 'PARTIAL',
      publishedCount: 0,
      republishedCount: 0,
      delistedCount: 0,
      skippedCount: 1,
      daysSinceLastCommit: 3,
      keepaliveCommitted: false,
      floorGuardOverridden: false,
      floorGuardOverrideReason: null,
      floorGuardLostPages: 0
    })
  });
  assert.equal(result.outcome, 'PARTIAL');
  assert.equal(outputs.get('skipped-count'), 1);
  assert.equal(outputs.get('validator-version'), '0.0.2');
  assert.deepEqual(secrets, [secret]);
  assert.equal(JSON.stringify([...outputs]).includes(secret), false);
});

test('importing the bundle in GitHub Actions has no automatic entrypoint side effects', async () => {
  const isolated = await mkdtemp(path.join(tmpdir(), 'gala-imported-bundle-'));
  await copyFile(path.join(actionRoot, 'dist', 'index.js'), path.join(isolated, 'index.js'));
  await writeFile(path.join(isolated, 'package.json'), '{"type":"module"}\n');
  const previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true';
  try {
    const module = await import(`${path.join(isolated, 'index.js')}?import-only=${Date.now()}`);
    assert.equal(typeof module.runEntrypoint, 'function');
  } finally {
    if (previous == null) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  }
});

test('executing the bundle directly retains the automatic action entrypoint', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [path.join(actionRoot, 'dist', 'index.js')], {
      env: { ...process.env, GITHUB_ACTIONS: 'true' }
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(`${error.stdout}\n${error.stderr}`, /Input required and not supplied: operation/);
      return true;
    }
  );
});
