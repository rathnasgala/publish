import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { markdownBodyHash } from '../src/content-hash.js';
import { createReconciliationEnvelope } from '../src/envelope.js';
import { ActionOperation, BuildMode, runAction } from '../src/orchestrator.js';
import { runLocalFixture } from '../src/local.js';
import {
  ReconciliationTransportError,
  sendReconciliation,
  signReconciliationBody
} from '../src/transport.js';

const SITE = '01K00000000000000000000010';
const ARTICLE = '01K00000000000000000000000';
const SHA = 'a'.repeat(40);
const SECRET = '0123456789abcdef0123456789abcdef';

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    evaluationDate: '2026-08-11',
    redirects: [],
    posts: [{
      source: 'content/posts/post/index.en.md',
      id: ARTICLE,
      slug: 'post',
      language: 'en',
      publicationState: 'published',
      body: 'Body\r\n',
      contentBody: 'Body\r\n',
      canonicalUrl: 'https://example.com/en/post/',
      rawFrontmatter: { title: 'Raw title', unknown: true },
      frontmatter: {
        title: 'Title',
        description: 'Description',
        tags: ['java'],
        coverImage: null
      },
      ...overrides
    }]
  };
}

function envelope(build = manifest(), emittedAt = '2026-08-11T20:00:00.000Z') {
  return createReconciliationEnvelope({
    manifest: build,
    commitSha: SHA,
    runId: 42,
    runAttempt: 1,
    emittedAt,
    runStatus: 'SUCCESS',
    daysSinceLastCommit: 3
  });
}

test('hashes exact parsed body bytes after stripping one leading BOM', () => {
  assert.equal(markdownBodyHash('\uFEFFBody\r\n'), markdownBodyHash('Body\r\n'));
  assert.notEqual(markdownBodyHash('Body\r\n'), markdownBodyHash('Body\n'));
  assert.notEqual(markdownBodyHash(' Body\r\n'), markdownBodyHash('Body\r\n'));
});

test('matches the shared Java wire-signature vector', async () => {
  const fixture = JSON.parse(await readFile(path.join(
    import.meta.dirname,
    '../../v1/validation/test/fixtures/reconciliation-signature.json'
  ), 'utf8'));
  assert.equal(
    signReconciliationBody(
      fixture.siteId,
      Buffer.from(fixture.bodyBase64, 'base64'),
      Buffer.from(fixture.secretBase64, 'base64').toString('utf8')
    ),
    `sha256=${fixture.signatureHex}`
  );
});

test('groups variants while metadata remains independent from the body hash', () => {
  const original = envelope();
  const renamed = envelope(manifest({
    frontmatter: {
      title: 'Renamed',
      description: 'Changed',
      tags: ['platform'],
      coverImage: 'cover.png'
    }
  }));
  assert.equal(
    original.articles[0].variants[0].contentHash,
    renamed.articles[0].variants[0].contentHash
  );
  assert.deepEqual(renamed.articles[0].variants[0], {
    language: 'en',
    state: 'PUBLISHED',
    contentHash: markdownBodyHash('Body\r\n'),
    title: 'Renamed',
    description: 'Changed',
    tags: ['platform'],
    coverImage: 'cover.png',
    canonicalUrl: 'https://example.com/en/post/',
    frontmatter: { title: 'Raw title', unknown: true }
  });
});

test('refuses non-emitted content even if it appears in a supplied manifest', () => {
  assert.throws(() => envelope(manifest({ publicationState: 'not-emitted' })), /not emitted/);
});

test('re-stamps, reserializes, and re-signs each retry over transmitted gzip bytes', async () => {
  const instants = [
    '2026-08-11T20:00:00.000Z',
    '2026-08-11T20:00:01.000Z'
  ];
  const requests = [];
  const result = await sendReconciliation({
    apiBaseUrl: 'https://api.example.com',
    siteId: SITE,
    siteSecret: SECRET,
    gzipThreshold: 0,
    envelopeForAttempt: (attempt) => envelope(manifest(), instants[attempt - 1]),
    fetchImpl: async (url, request) => {
      requests.push({ url: url.toString(), request });
      return requests.length === 1
        ? { ok: false, status: 503, json: async () => ({ code: 'UNAVAILABLE' }) }
        : { ok: true, status: 200, json: async () => ({ noOp: false }) };
    }
  });
  assert.deepEqual(result, { noOp: false });
  assert.equal(requests.length, 2);
  for (let index = 0; index < requests.length; index += 1) {
    const { request } = requests[index];
    const expected = `sha256=${createHmac('sha256', SECRET)
      .update(SITE).update(Buffer.from([0x0a])).update(request.body).digest('hex')}`;
    assert.equal(request.headers['Gala-Signature'], expected);
    assert.equal(JSON.parse(gunzipSync(request.body)).emittedAt, instants[index]);
  }
  assert.notEqual(
    requests[0].request.headers['Gala-Signature'],
    requests[1].request.headers['Gala-Signature']
  );
});

test('rejects insecure API origins before transmitting the site secret signature', async () => {
  let called = false;
  await assert.rejects(() => sendReconciliation({
    apiBaseUrl: 'http://api.example.com',
    siteId: SITE,
    siteSecret: SECRET,
    envelopeForAttempt: () => envelope(),
    fetchImpl: async () => { called = true; }
  }), /must use HTTPS/);
  assert.equal(called, false);
});

function adapters(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      currentCommitSha: async () => { calls.push('head'); return SHA; },
      verifyRecordedState: async () => { calls.push('verify-recorded-state'); },
      validateAndBuild: async () => { calls.push('build'); return manifest(); },
      keepalive: async () => { calls.push('keepalive'); },
      commitMessage: async () => { calls.push('commit-message'); return ''; },
      previousPageCount: async () => { calls.push('previous-count'); return null; },
      currentPageCount: async () => { calls.push('current-count'); return 1; },
      stageDeployment: async () => { calls.push('stage-deployment'); },
      sendReconciliation: async () => { calls.push('reconcile'); return { noOp: false }; },
      report: async (summary) => { calls.push(`report:${summary.outcome}`); },
      warn: () => { calls.push('warn'); },
      now: () => new Date('2026-08-11T20:00:00Z'),
      ...overrides
    }
  };
}

function input(overrides = {}) {
  return {
    operation: ActionOperation.BUILD,
    mode: BuildMode.BUILD_ONLY,
    root: '/fixture',
    commitSha: SHA,
    siteId: SITE,
    siteSecret: SECRET,
    apiBaseUrl: 'https://api.example.com',
    runId: 42,
    runAttempt: 1,
    daysSinceLastCommit: 3,
    floorGuardPercent: 20,
    floorGuardPages: 25,
    floorGuardOverrideCommitSha: null,
    ...overrides
  };
}

test('build-only reports partial and cannot deploy, enforce a floor, or reconcile implicitly', async () => {
  const fixture = adapters();
  const result = await runAction(input(), fixture.value);
  assert.equal(result.outcome, 'PARTIAL');
  assert.deepEqual(fixture.calls, ['head', 'build', 'keepalive', 'report:PARTIAL']);
});

test('reports validation skips and keepalive observability without putting failures in the manifest', async () => {
  let reported;
  const skipped = [
    { source: 'content/posts/one/index.en.md', errors: ['title is required'] },
    { source: 'content/posts/two/index.fr.md', errors: ['slug is reserved'] }
  ];
  const fixture = adapters({
    validateAndBuild: async () => ({ manifest: manifest(), skipped, skippedCount: 2 }),
    keepalive: async () => ({ committed: true, daysSinceLastCommit: 51 }),
    report: async (value) => { reported = structuredClone(value); }
  });
  const result = await runAction(input(), fixture.value);
  assert.equal(result.outcome, 'PARTIAL');
  assert.equal(result.skippedCount, 2);
  assert.deepEqual(result.skipped, skipped);
  assert.deepEqual(reported.skipped, skipped);
  assert.equal(result.daysSinceLastCommit, 51);
  assert.equal(result.keepaliveCommitted, true);
});

test('owned deployment stages only after the floor passes and leaves deployment to the workflow', async () => {
  const fixture = adapters();
  const result = await runAction(input({ mode: BuildMode.BUILD_AND_DEPLOY }), fixture.value);
  assert.equal(result.outcome, 'PARTIAL');
  assert.deepEqual(fixture.calls, [
    'head', 'build', 'keepalive', 'commit-message', 'previous-count', 'current-count',
    'stage-deployment', 'report:PARTIAL'
  ]);
});

test('acknowledgement pins no-op, stale, and deferred reconciliation outcomes', async () => {
  const noOp = adapters({ sendReconciliation: async () => ({ noOp: true }) });
  assert.equal((await runAction(input({ operation: ActionOperation.ACKNOWLEDGE_DEPLOYMENT }), noOp.value)).outcome, 'NO_OP');

  const stale = adapters({
    sendReconciliation: async () => {
      throw new ReconciliationTransportError('stale', { status: 409, code: 'STALE_RUN' });
    }
  });
  assert.equal(
    (await runAction(input({ operation: ActionOperation.ACKNOWLEDGE_DEPLOYMENT }), stale.value)).outcome,
    'SKIPPED_STALE'
  );

  const deferred = adapters({
    sendReconciliation: async () => {
      throw new ReconciliationTransportError('unavailable', { status: 503 });
    }
  });
  const result = await runAction(input({ operation: ActionOperation.ACKNOWLEDGE_DEPLOYMENT }), deferred.value);
  assert.equal(result.outcome, 'PARTIAL');
  assert.ok(deferred.calls.includes('warn'));
});

test('requires the in-commit reason and SHA together and reports an exercised override as partial', async () => {
  let transmittedOverride;
  const fixture = adapters({
    commitMessage: async () => 'Bulk retirement\n\nGala-Floor-Override: retire obsolete archive\n',
    previousPageCount: async () => 1_000,
    currentPageCount: async () => 800,
    stageDeployment: async (_input, _manifest, floorGuardOverride) => {
      transmittedOverride = floorGuardOverride;
    }
  });
  const result = await runAction(input({
    mode: BuildMode.BUILD_AND_DEPLOY,
    floorGuardOverrideCommitSha: SHA
  }), fixture.value);
  assert.equal(result.outcome, 'PARTIAL');
  assert.equal(result.floorGuardOverridden, true);
  assert.equal(result.floorGuardOverrideReason, 'retire obsolete archive');
  assert.equal(result.floorGuardLostPages, 200);
  assert.deepEqual(transmittedOverride, {
    previousPageCount: 1_000,
    currentPageCount: 800,
    lostPages: 200,
    reason: 'retire obsolete archive'
  });

  const missingConfirmation = adapters({
    commitMessage: async () => 'Gala-Floor-Override: retire obsolete archive'
  });
  await assert.rejects(() => runAction(input({
    mode: BuildMode.BUILD_AND_DEPLOY
  }), missingConfirmation.value), /requires both/);
});

test('acknowledgement refuses a moved checkout before validation or signing', async () => {
  const fixture = adapters({ currentCommitSha: async () => 'b'.repeat(40) });
  await assert.rejects(() => runAction(input({
    operation: ActionOperation.ACKNOWLEDGE_DEPLOYMENT
  }), fixture.value), /does not match expected commit/);
  assert.deepEqual(fixture.calls, ['report:FAILED']);
});

test('acknowledgement preserves a staged floor override as PARTIAL', async () => {
  const override = {
    previousPageCount: 100,
    currentPageCount: 50,
    lostPages: 50,
    reason: 'retire archive'
  };
  const fixture = adapters({
    validateAndBuild: async () => ({
      manifest: { schemaVersion: 1, posts: [] },
      skippedCount: 0,
      floorGuardOverride: override
    }),
    sendReconciliation: async () => ({
      publishedCount: 0, republishedCount: 0, delistedCount: 0
    })
  });
  const result = await runAction(input({
    operation: 'acknowledge-deployment',
    mode: 'build-only'
  }), fixture.value);

  assert.equal(result.outcome, 'PARTIAL');
  assert.equal(result.floorGuardOverridden, true);
  assert.equal(result.floorGuardOverrideReason, override.reason);
  assert.equal(result.floorGuardLostPages, 50);
  assert.ok(fixture.calls.includes('verify-recorded-state'));
});

test('acknowledgement signs the live deployed SHA rather than the reconstruction SHA', async () => {
  const deployedCommitSha = 'b'.repeat(40);
  let envelope;
  const fixture = adapters({
    sendReconciliation: async ({ envelopeForAttempt }) => {
      envelope = envelopeForAttempt();
      return { noOp: true };
    }
  });
  await runAction(input({
    operation: ActionOperation.ACKNOWLEDGE_DEPLOYMENT,
    mode: BuildMode.BUILD_ONLY,
    deployedCommitSha,
    recordedStateSha: SHA
  }), fixture.value);
  assert.equal(envelope.commitSha, deployedCommitSha);
});

test('runs locally against a fixture repository without GitHub context', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-action-'));
  await mkdir(path.join(root, 'content', 'posts', 'post'), { recursive: true });
  await mkdir(path.join(root, '.gala'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', '@11ty', 'eleventy'), { recursive: true });
  await writeFile(path.join(root, 'content', 'posts', 'post', 'index.en.md'), `---
id: ${ARTICLE}
title: Post
description: Fixture post
publishAfterDate: 2026-08-10
language: en
---

Body.
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
  })}\n`);
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: UTC
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /
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
  const result = await runLocalFixture({
    root,
    input: input({ configPath: 'site.config.yml', timezone: 'UTC', outputDirectory: '_site' }),
    adapters: { now: () => new Date('2026-08-11T20:00:00Z') }
  });
  assert.equal(result.outcome, 'PARTIAL');
  assert.match(
    await readFile(path.join(root, '.gala', 'build', 'validated-posts.json'), 'utf8'),
    new RegExp(ARTICLE)
  );
  assert.match(await readFile(path.join(root, '_site', 'index.html'), 'utf8'), /doctype/);
});
