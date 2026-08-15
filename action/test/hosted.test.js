import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHostedAdapters } from '../src/hosted.js';

const SHA = 'a'.repeat(40);
const RECORDED_SHA = 'b'.repeat(40);
const ASSIGNED_ID = '01K00000000000000000000000';
const ASSIGNED_PATH = 'content/posts/hello/index.en.md';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-hosted-'));
  await mkdir(path.join(root, 'content', 'posts', 'hello'), { recursive: true });
  await mkdir(path.join(root, '.gala'), { recursive: true });
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', '@11ty', 'eleventy'), { recursive: true });
  await writeFile(path.join(root, 'content', 'posts', 'hello', 'index.en.md'), `---
id: 01K00000000000000000000000
title: Hello
publishAfterDate: 2026-08-10
language: en
---

Hello.
`);
  await writeFile(path.join(root, '.gala', 'publication-state.yml'), 'schemaVersion: 1\nposts: []\n');
  await writeFile(path.join(root, '.gala', 'managed-files.json'), `${JSON.stringify({
    schemaVersion: 1,
    files: {},
    themePackage: {
      name: '@rathnasgala/theme',
      version: '0.0.1',
      availableDesignThemes: ['editorial'],
      securityAdvisories: []
    }
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'config', 'site.yml'), `schemaVersion: 1
site:
  timezone: America/Los_Angeles
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /
  canonicalPolicy: self
design:
  theme: editorial
framework:
  themePackage:
    name: "@rathnasgala/theme"
    version: "0.0.1"
`);
  await writeFile(path.join(root, 'node_modules', '@11ty', 'eleventy', 'cmd.cjs'), `
const { mkdirSync, writeFileSync } = require('node:fs');
const output = process.argv.find((value) => value.startsWith('--output=')).slice(9);
mkdirSync(output, { recursive: true });
writeFileSync(require('node:path').join(output, 'index.html'), '<!doctype html>');
`);
  return root;
}

function input(root, overrides = {}) {
  return {
    operation: 'build',
    mode: 'build-and-deploy',
    root,
    siteId: '01K00000000000000000000000',
    commitSha: SHA,
    configPath: 'config/site.yml',
    timezone: 'America/Los_Angeles',
    outputDirectory: '_site',
    keepaliveThresholdDays: 50,
    ...overrides
  };
}

test('hosted validation uses the selected config, emits only the manifest, and counts rendered pages', async () => {
  const root = await fixture();
  const adapters = createHostedAdapters({ now: () => new Date('2026-08-11T20:00:00Z') });
  const result = await adapters.validateAndBuild(input(root));

  assert.equal(result.skippedCount, 0);
  assert.equal(result.manifest.posts.length, 1);
  assert.equal(result.currentPageCount, 1);
  assert.match(await readFile(path.join(root, '_site', 'index.html'), 'utf8'), /doctype/);
});

test('engagement snapshot refresh writes one canonical file and is idempotent', async () => {
  const root = await fixture();
  const snapshot = {
    schemaVersion: 1,
    refreshedAt: '2026-08-11T20:00:00Z',
    articles: {
      '01K00000000000000000000000': { reactions: 2, comments: 1, views: 9 }
    }
  };
  const requests = [];
  const adapters = createHostedAdapters({
    now: () => new Date('2026-08-11T20:00:00Z'),
    fetchImpl: async (url, request) => {
      requests.push({ url: String(url), request });
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  const refreshInput = input(root, {
    apiBaseUrl: 'https://api.gala67.com',
    siteId: '01K00000000000000000000000',
    siteSecret: 's'.repeat(32),
    runId: '123',
    runAttempt: 1
  });

  const firstHash = await adapters.refreshEngagementSnapshot(refreshInput);
  const secondHash = await adapters.refreshEngagementSnapshot(refreshInput);

  assert.match(firstHash, /^[a-f0-9]{64}$/);
  assert.equal(secondHash, null);
  assert.equal(requests.length, 2);
  assert.equal(
    await readFile(path.join(root, '.engagement-snapshot.json'), 'utf8'),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
});

test('deployment stage is commit-bound and carries a floor override into acknowledgement', async () => {
  const root = await fixture();
  const adapters = createHostedAdapters({ now: () => new Date('2026-08-11T20:00:00Z') });
  const override = {
    previousPageCount: 100,
    currentPageCount: 50,
    lostPages: 50,
    reason: 'retire archive'
  };
  const assignedContentIds = [{
    source: 'content/posts/hello/index.en.md',
    id: '01K00000000000000000000000',
    fileHash: 'b'.repeat(64)
  }];
  const manifest = {
    schemaVersion: 1,
    evaluationDate: '2026-08-11',
    posts: [],
    assignedContentIds
  };
  await adapters.stageDeployment(input(root), manifest, override);
  assert.match(
    await readFile(path.join(root, '.gala', 'build', 'publication-state.yml'), 'utf8'),
    new RegExp(`deployedCommitSha: ${SHA}`)
  );
  const acknowledged = await adapters.validateAndBuild(input(root, {
    operation: 'acknowledge-deployment',
    mode: 'build-only'
  }));
  assert.deepEqual(acknowledged.floorGuardOverride, override);
  assert.deepEqual(acknowledged.assignedContentIds, assignedContentIds);

  await assert.rejects(
    () => adapters.validateAndBuild(input(root, {
      operation: 'acknowledge-deployment',
      mode: 'build-only',
      commitSha: 'b'.repeat(40)
    })),
    /Deployment stage belongs to/
  );
});

function recordedStateRunner({ changedBody = false, changedTitle = false, changedPaths, ancestryCode = 0 } = {}) {
  const deployed = `---\ntitle: Hello\npublishAfterDate: 2026-08-10\nlanguage: en\n---\n\nHello.\n`;
  const recorded = `---\nid: ${ASSIGNED_ID}\ntitle: ${changedTitle ? 'Changed' : 'Hello'}\npublishAfterDate: 2026-08-10\nlanguage: en\n---\n\nHello.${changedBody ? ' changed' : ''}\n`;
  return async (_command, args) => {
    if (args[0] === 'merge-base') return { code: ancestryCode, stdout: '' };
    if (args[0] === 'show' && args[1] === '-s') {
      return {
        code: 0,
        stdout: `chore(gala): record successful deployment\n\nGala-Deployed-SHA: ${SHA}\nGala-Assigned-ID: ${ASSIGNED_ID} ${ASSIGNED_PATH}`
      };
    }
    if (args[0] === 'diff') {
      return {
        code: 0,
        stdout: (changedPaths ?? ['.gala/publication-state.yml', ASSIGNED_PATH]).join('\n')
      };
    }
    if (args[0] === 'show' && args[1] === `${SHA}:${ASSIGNED_PATH}`) {
      return { code: 0, stdout: deployed };
    }
    if (args[0] === 'show' && args[1] === `${RECORDED_SHA}:${ASSIGNED_PATH}`) {
      return { code: 0, stdout: recorded };
    }
    throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
  };
}

test('recorded-state verification permits only the manifest-bound frontmatter ID addition', async () => {
  const adapters = createHostedAdapters({ runCommand: recordedStateRunner() });
  await adapters.verifyRecordedState(input('/fixture', {
    operation: 'acknowledge-deployment',
    mode: 'build-only',
    commitSha: RECORDED_SHA,
    recordedStateSha: RECORDED_SHA,
    deployedCommitSha: SHA
  }));
});

test('recorded-state verification hard-fails on body, unrelated-path, or ancestry changes', async () => {
  const acknowledgement = input('/fixture', {
    operation: 'acknowledge-deployment',
    mode: 'build-only',
    commitSha: RECORDED_SHA,
    recordedStateSha: RECORDED_SHA,
    deployedCommitSha: SHA
  });
  await assert.rejects(
    () => createHostedAdapters({ runCommand: recordedStateRunner({ changedBody: true }) })
      .verifyRecordedState(acknowledgement),
    /changed content other than the assigned ULID/
  );
  await assert.rejects(
    () => createHostedAdapters({ runCommand: recordedStateRunner({ changedTitle: true }) })
      .verifyRecordedState(acknowledgement),
    /changed content other than the assigned ULID/
  );
  await assert.rejects(
    () => createHostedAdapters({
      runCommand: recordedStateRunner({
        changedPaths: ['.gala/publication-state.yml', ASSIGNED_PATH, 'site.config.yml']
      })
    }).verifyRecordedState(acknowledgement),
    /may change only publication state/
  );
  await assert.rejects(
    () => createHostedAdapters({ runCommand: recordedStateRunner({ ancestryCode: 1 }) })
      .verifyRecordedState(acknowledgement),
    /not a descendant/
  );
});

test('keepalive advances the remote branch without moving the validated checkout', async () => {
  const calls = [];
  const keepaliveSha = 'b'.repeat(40);
  const adapters = createHostedAdapters({
    env: { GITHUB_REF_NAME: 'main' },
    now: () => new Date('2026-08-11T20:00:00Z'),
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === 'log') {
        return { stdout: String(Math.floor(new Date('2026-06-22T20:00:00Z').getTime() / 1000)) };
      }
      if (args[0] === 'commit-tree') return { stdout: keepaliveSha };
      return { stdout: '' };
    }
  });

  const result = await adapters.keepalive(input('/fixture'));

  assert.deepEqual(result, { committed: true, daysSinceLastCommit: 50 });
  assert.deepEqual(calls.map(({ args }) => args), [
    ['log', '-1', '--format=%ct'],
    ['check-ref-format', '--branch', 'main'],
    ['commit-tree', `${SHA}^{tree}`, '-p', SHA, '-m', 'chore: keep Gala publishing active'],
    ['push', 'origin', `${keepaliveSha}:main`]
  ]);
  assert.equal(calls.some(({ args }) => args.includes('commit')), false);
  assert.equal(calls.some(({ args }) => args.includes('checkout')), false);
  const commitTree = calls.find(({ args }) => args[0] === 'commit-tree');
  assert.equal(commitTree.options.env.GIT_AUTHOR_NAME, 'github-actions[bot]');
});

test('report lists every skipped source and validation reason in the job summary', async () => {
  const headings = [];
  const tables = [];
  let writes = 0;
  const summary = {
    addHeading(value, level) { headings.push([value, level]); return this; },
    addTable(value) { tables.push(value); return this; },
    addLink() { return this; },
    async write() { writes += 1; }
  };
  const adapters = createHostedAdapters({ summary });

  await adapters.report({
    outcome: 'PARTIAL',
    skippedCount: 2,
    skipped: [
      { source: 'content/posts/one/index.en.md', errors: ['title is required'] },
      { source: 'content/posts/two/index.fr.md', errors: ['slug is reserved', 'language is invalid'] }
    ],
    publishedCount: 0,
    republishedCount: 0,
    delistedCount: 0,
    daysSinceLastCommit: 3,
    keepaliveCommitted: false
  });

  assert.deepEqual(headings, [['Gala publishing', undefined], ['Skipped post variants', 2]]);
  assert.deepEqual(tables[1], [
    [{ data: 'File', header: true }, { data: 'Reason', header: true }],
    ['content/posts/one/index.en.md', 'title is required'],
    ['content/posts/two/index.fr.md', 'slug is reserved'],
    ['content/posts/two/index.fr.md', 'language is invalid']
  ]);
  assert.equal(writes, 1);
});

test('report renders a server-owned theme advisory without raw Markdown', async () => {
  const headings = [];
  const tables = [];
  const links = [];
  const summary = {
    addHeading(value, level) { headings.push([value, level]); return this; },
    addTable(value) { tables.push(value); return this; },
    addLink(label, url) { links.push([label, url]); return this; },
    async write() {}
  };
  const adapters = createHostedAdapters({ summary });

  await adapters.report({
    outcome: 'PARTIAL',
    skippedCount: 0,
    skipped: [],
    publishedCount: 0,
    republishedCount: 0,
    delistedCount: 0,
    daysSinceLastCommit: 0,
    keepaliveCommitted: false,
    themeAdvisory: {
      id: 'GALA-2026-001',
      severity: 'HIGH',
      installedVersion: '0.0.5',
      fixedVersion: '0.0.6',
      url: 'https://gala67.com/security/GALA-2026-001'
    }
  });

  assert.deepEqual(headings.at(-1), ['Theme security advisory', 2]);
  assert.deepEqual(tables.at(-1), [
    [{ data: 'Advisory', header: true }, 'GALA-2026-001'],
    ['Severity', 'HIGH'],
    ['Installed version', '0.0.5'],
    ['Fixed version', '0.0.6']
  ]);
  assert.deepEqual(links, [[
    'Advisory details', 'https://gala67.com/security/GALA-2026-001'
  ]]);
});
