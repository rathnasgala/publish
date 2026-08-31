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
  readBuildSettings,
  readEngagementSnapshot,
  sendBuildFailure,
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
    themePackage: { name: '@rathnasgala/theme', version: '0.0.1' },
    statistics: { publicViewCounts: false },
    contact: { enabled: false, websiteEnabled: false, phoneEnabled: false },
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
      rawFrontmatter: { title: 'Raw title', publishAfterDate: '2026-08-10', unknown: true },
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
    daysSinceLastCommit: 3,
    deploymentCommitSha: 'd'.repeat(40)
  });
}

test('signs the exact deployed Pages commit into reconciliation', () => {
  assert.equal(envelope().deploymentCommitSha, 'd'.repeat(40));
});

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
    frontmatter: { title: 'Raw title', publishAfterDate: '2026-08-10', unknown: true }
  });
});

test('emits the complete V2 Prism reconciliation projection', () => {
  const configurationId = '01K00000000000000000000011';
  const revisionId = '01K00000000000000000000012';
  const approvalId = '01K00000000000000000000013';
  const build = manifest({
    prismSourceHash: 'b'.repeat(64),
    prismHashContract: 'GALA_PRISM_HASH_V1',
    prismProtectionContract: { schemaVersion: 1, names: ['42'] },
    prismReferencedMediaDigests: { 'image.png': 'c'.repeat(64) },
  });
  build.schemaVersion = 2;
  build.prism = {
    schemaVersion: 1, mode: 'MANUAL', configurationLinkPolicy: 'NOFOLLOW',
    articleModes: {}, articleConfigurationLinkPolicies: {},
  };
  build.configurations = [{
    configurationId, revisionId, approvalId, articleId: ARTICLE, language: 'en',
    approvalTokenVersion: 1, approvalTokenVerifiedWith: 'CURRENT',
    hashContract: 'GALA_PRISM_HASH_V1', state: 'PUBLISHED',
    sourceRevisionHash: 'b'.repeat(64), configurationContentHash: 'd'.repeat(64),
    depth: 'BRIEF', intent: 'ORIENTATION', modality: 'TEXT',
    configurationLinkPolicy: 'NOFOLLOW',
    pageUrl: `https://example.com/en/post/prism/${configurationId}/`,
  }];

  const result = envelope(build);

  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(result.prism, {
    mode: 'MANUAL', configurationLinkPolicy: 'NOFOLLOW',
    articleModes: {}, articleConfigurationLinkPolicies: {},
  });
  assert.deepEqual(result.articles[0].variants[0].configurations[0], {
    id: configurationId, revisionId, approvalId, approvalTokenVersion: 1,
    approvalTokenVerifiedWith: 'CURRENT', hashContract: 'GALA_PRISM_HASH_V1',
    state: 'PUBLISHED', sourceRevisionHash: 'b'.repeat(64), contentHash: 'd'.repeat(64),
    depth: 'BRIEF', intent: 'ORIENTATION', modality: 'TEXT',
    configurationLinkPolicy: 'NOFOLLOW',
    pageUrl: `https://example.com/en/post/prism/${configurationId}/`,
  });
});

test('carries the validator-resolved public view-count setting in every full snapshot', () => {
  assert.deepEqual(envelope().statistics, { publicViewCounts: false });
  const legacy = manifest();
  delete legacy.statistics;
  assert.deepEqual(envelope(legacy).statistics, { publicViewCounts: false });
  const enabled = manifest();
  enabled.statistics = { publicViewCounts: true };
  assert.deepEqual(envelope(enabled).statistics, { publicViewCounts: true });
});

test('carries normalized contact settings in every full snapshot', () => {
  assert.deepEqual(envelope().contact, {
    enabled: false,
    websiteEnabled: false,
    phoneEnabled: false
  });
  const legacy = manifest();
  delete legacy.contact;
  assert.deepEqual(envelope(legacy).contact, {
    enabled: false,
    websiteEnabled: false,
    phoneEnabled: false
  });
  const enabled = manifest();
  enabled.contact = {
    enabled: true,
    websiteEnabled: true,
    phoneEnabled: false
  };
  assert.deepEqual(envelope(enabled).contact, enabled.contact);
});

test('carries the exact validated theme identity in every signed snapshot', () => {
  assert.deepEqual(envelope().themePackage, {
    name: '@rathnasgala/theme',
    version: '0.0.1'
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
    },
    wait: async () => {}
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

test('reconciliation exhausts bounded retries instead of returning a green partial result', async () => {
  let requests = 0;
  const waits = [];
  await assert.rejects(() => sendReconciliation({
    apiBaseUrl: 'https://api.example.com',
    siteId: SITE,
    siteSecret: SECRET,
    envelopeForAttempt: () => envelope(),
    maxAttempts: 4,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: async () => {
      requests += 1;
      return { ok: false, status: 503, json: async () => ({ code: 'UNAVAILABLE' }) };
    }
  }), /HTTP 503/);
  assert.equal(requests, 4);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
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

test('signs the exact bounded build-failure body for the dedicated route', async () => {
  let request;
  const report = {
    emittedAt: '2026-08-11T20:00:00.000Z',
    runId: 42,
    runAttempt: 1,
    commitSha: SHA,
    validatorVersion: '0.0.4',
    errors: [{ source: 'action', code: 'BUILD_FAILED', message: 'validation failed' }]
  };
  await sendBuildFailure({
    apiBaseUrl: 'https://api.example.com',
    siteId: SITE,
    siteSecret: SECRET,
    report,
    fetchImpl: async (url, options) => {
      request = { url: url.toString(), ...options };
      return { ok: true, status: 202 };
    }
  });
  assert.equal(request.url, `https://api.example.com/v1/sites/${SITE}/build-reports`);
  assert.deepEqual(JSON.parse(request.body), report);
  assert.equal(request.headers['Gala-Signature'], signReconciliationBody(SITE, request.body, SECRET));
});

test('retries signed workflow failure reports across transient API errors', async () => {
  let requests = 0;
  const waits = [];
  await sendBuildFailure({
    apiBaseUrl: 'https://api.example.com',
    siteId: SITE,
    siteSecret: SECRET,
    report: {
      emittedAt: '2026-08-11T20:00:00.000Z',
      runId: 42,
      runAttempt: 1,
      commitSha: SHA,
      validatorVersion: '0.0.4',
      errors: [{ source: 'workflow', code: 'DEPLOYMENT_FAILED', message: 'push failed' }]
    },
    maxAttempts: 3,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: async () => {
      requests += 1;
      return requests < 3
        ? { ok: false, status: 503, json: async () => ({ code: 'UNAVAILABLE' }) }
        : { ok: true, status: 202 };
    }
  });
  assert.equal(requests, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test('reads the signed engagement snapshot without placing credentials in the body', async () => {
  let request;
  const result = await readEngagementSnapshot({
    apiBaseUrl: 'https://api.example.com',
    siteId: SITE,
    siteSecret: SECRET,
    runId: 42,
    runAttempt: 1,
    emittedAt: '2026-08-11T20:00:00.000Z',
    fetchImpl: async (url, options) => {
      request = { url: url.toString(), ...options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 1,
          refreshedAt: '2026-08-11T20:00:00.123456789Z',
          articles: {
            [ARTICLE]: { reactions: 1, comments: 2, views: 3, activeReadingSeconds: 45 }
          }
        })
      };
    }
  });
  assert.equal(request.url, `https://api.example.com/v1/sites/${SITE}/engagement-snapshot/read`);
  assert.equal(request.body.includes(SECRET), false);
  assert.equal(result.articles[ARTICLE].views, 3);
  assert.equal(result.articles[ARTICLE].activeReadingSeconds, 45);
  assert.equal(request.headers['Gala-Signature'], signReconciliationBody(SITE, request.body, SECRET));
});

test('accepts a legacy engagement snapshot during a rolling deployment', async () => {
  const result = await readEngagementSnapshot({
    apiBaseUrl: 'https://api.example.com',
    siteId: SITE,
    siteSecret: SECRET,
    runId: 42,
    runAttempt: 1,
    emittedAt: '2026-08-11T20:00:00.000Z',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        schemaVersion: 1,
        refreshedAt: '2026-08-11T20:00:00Z',
        articles: { [ARTICLE]: { reactions: 1, comments: 2, views: 3 } }
      })
    })
  });
  assert.equal(result.articles[ARTICLE].views, 3);
});

test('rejects invalid active reading time in an engagement snapshot', async () => {
  await assert.rejects(readEngagementSnapshot({
    apiBaseUrl: 'https://api.example.com',
    siteId: SITE,
    siteSecret: SECRET,
    runId: 42,
    runAttempt: 1,
    emittedAt: '2026-08-11T20:00:00.000Z',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        schemaVersion: 1,
        refreshedAt: '2026-08-11T20:00:00Z',
        articles: {
          [ARTICLE]: { reactions: 1, comments: 2, views: 3, activeReadingSeconds: -1 }
        }
      })
    })
  }), /Engagement snapshot response is invalid/);
});

test('reads authoritative signed build settings without placing credentials in the body', async () => {
  let request;
  const result = await readBuildSettings({
    apiBaseUrl: 'https://api.example.com',
    siteId: SITE,
    siteSecret: SECRET,
    runId: 42,
    runAttempt: 1,
    emittedAt: '2026-08-11T20:00:00.000Z',
    fetchImpl: async (url, options) => {
      request = { url: url.toString(), ...options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 1,
          generatedAt: '2026-08-11T20:00:00Z',
          paginationPolicy: { minimumPageSize: 12, maximumPageSize: 100, defaultPageSize: 24 }
        })
      };
    }
  });
  assert.equal(request.url, `https://api.example.com/v1/sites/${SITE}/build-settings/read`);
  assert.equal(request.body.includes(SECRET), false);
  assert.equal(result.paginationPolicy.defaultPageSize, 24);
  assert.equal(request.headers['Gala-Signature'], signReconciliationBody(SITE, request.body, SECRET));
});

test('accepts authoritative build settings timestamps at Java Instant precision', async () => {
  for (const generatedAt of [
    '2026-08-11T20:00:00.123456Z',
    '2026-08-11T20:00:00.123456789Z'
  ]) {
    const result = await readBuildSettings({
      apiBaseUrl: 'https://api.example.com',
      siteId: SITE,
      siteSecret: SECRET,
      runId: 42,
      runAttempt: 1,
      emittedAt: '2026-08-11T20:00:00.000Z',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 1,
          generatedAt,
          paginationPolicy: { minimumPageSize: 12, maximumPageSize: 100, defaultPageSize: 24 }
        })
      })
    });
    assert.equal(result.generatedAt, generatedAt);
  }
});

test('rejects build settings timestamps beyond Java Instant precision', async () => {
  await assert.rejects(readBuildSettings({
    apiBaseUrl: 'https://api.example.com',
    siteId: SITE,
    siteSecret: SECRET,
    runId: 42,
    runAttempt: 1,
    emittedAt: '2026-08-11T20:00:00.000Z',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        schemaVersion: 1,
        generatedAt: '2026-08-11T20:00:00.1234567890Z',
        paginationPolicy: { minimumPageSize: 12, maximumPageSize: 100, defaultPageSize: 24 }
      })
    })
  }), /Build settings response is invalid/);
});

function adapters(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      currentCommitSha: async () => { calls.push('head'); return SHA; },
      refreshBuildSettings: async () => {},
      verifyRecordedState: async () => { calls.push('verify-recorded-state'); },
      validateAndBuild: async () => { calls.push('build'); return manifest(); },
      keepalive: async () => { calls.push('keepalive'); },
      commitMessage: async () => { calls.push('commit-message'); return ''; },
      previousPageCount: async () => { calls.push('previous-count'); return null; },
      currentPageCount: async () => { calls.push('current-count'); return 1; },
      stageDeployment: async () => { calls.push('stage-deployment'); },
      sendReconciliation: async () => { calls.push('reconcile'); return { noOp: false }; },
      sendBuildFailure: async () => { calls.push('build-failure'); },
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

test('snapshot refresh failure warns and never blocks the build', async () => {
  const fixture = adapters({
    refreshEngagementSnapshot: async () => { throw new Error('platform unavailable'); }
  });
  const result = await runAction(input(), fixture.value);
  assert.equal(result.outcome, 'PARTIAL');
  assert.equal(fixture.calls.includes('warn'), true);
  assert.equal(fixture.calls.includes('build'), true);
});

test('build settings refresh failure stops before validation', async () => {
  const fixture = adapters({
    refreshBuildSettings: async () => { throw new Error('platform unavailable'); }
  });
  await assert.rejects(() => runAction(input(), fixture.value), /platform unavailable/);
  assert.equal(fixture.calls.includes('build'), false);
  assert.equal(fixture.calls.includes('build-failure'), true);
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

test('acknowledgement pins no-op and stale outcomes but fails exhausted transport', async () => {
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

  const unavailable = adapters({
    sendReconciliation: async () => {
      throw new ReconciliationTransportError('unavailable', { status: 503 });
    }
  });
  await assert.rejects(
    runAction(input({ operation: ActionOperation.ACKNOWLEDGE_DEPLOYMENT }), unavailable.value),
    /unavailable/
  );
  assert.ok(unavailable.calls.includes('build-failure'));
  assert.ok(unavailable.calls.includes('report:FAILED'));
});

test('reports a workflow-owned deployment failure without rebuilding the publication', async () => {
  let failure;
  const fixture = adapters({
    sendBuildFailure: async ({ report }) => { failure = report; }
  });
  const result = await runAction(input({
    operation: ActionOperation.REPORT_FAILURE,
    failureCode: 'DEPLOYMENT_FAILED',
    failureMessage: 'The gh-pages push failed.'
  }), fixture.value);

  assert.equal(result.outcome, 'FAILED');
  assert.deepEqual(failure.errors, [{
    source: 'workflow', code: 'DEPLOYMENT_FAILED', message: 'The gh-pages push failed.'
  }]);
  assert.deepEqual(fixture.calls, ['report:FAILED']);
});

test('a broken reconciliation envelope fails the run instead of deferring it', async () => {
  // Every publication silently 404'd because the envelope contract broke, the resulting
  // TypeError was downgraded to a warning, and GitHub reported a successful publish. Only a
  // transport failure may be deferred; a contract break has to stop the run.
  const broken = adapters({
    sendReconciliation: async () => {
      throw new TypeError('Invalid reconciliation envelope: required property \'themePackage\' not found');
    }
  });

  await assert.rejects(
    runAction(input({ operation: ActionOperation.ACKNOWLEDGE_DEPLOYMENT }), broken.value),
    /required property 'themePackage' not found/
  );

  assert.ok(broken.calls.includes('report:FAILED'), 'the run must be reported as failed');
  assert.ok(broken.calls.includes('build-failure'), 'the API must be told the build failed');
  assert.ok(!broken.calls.includes('warn'), 'a contract break must not be downgraded to a warning');
});

test('acknowledgement maps the Java reconciliation count contract into action outputs', async () => {
  const fixture = adapters({
    sendReconciliation: async () => ({
      noOp: false, published: 4, republished: 3, delisted: 2
    })
  });
  const result = await runAction(input({
    operation: ActionOperation.ACKNOWLEDGE_DEPLOYMENT
  }), fixture.value);

  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.publishedCount, 4);
  assert.equal(result.republishedCount, 3);
  assert.equal(result.delistedCount, 2);
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
  assert.deepEqual(fixture.calls, ['build-failure', 'report:FAILED']);
});

test('reports a failed build independently and never masks the original error', async () => {
  let failure;
  const fixture = adapters({
    validateAndBuild: async () => { throw new Error('invalid content'); },
    sendBuildFailure: async (value) => { failure = value.report; }
  });

  await assert.rejects(() => runAction(input(), fixture.value), /invalid content/);
  assert.equal(failure.commitSha, SHA);
  assert.equal(failure.runId, 42);
  assert.equal(failure.runAttempt, 1);
  assert.deepEqual(failure.errors, [{
    source: 'action', code: 'BUILD_FAILED', message: 'invalid content'
  }]);
  assert.equal(fixture.calls.includes('reconcile'), false);
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
      published: 0, republished: 0, delisted: 0
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

test('acknowledgement refreshes authoritative build settings before rebuilding', async () => {
  const calls = [];
  const fixture = adapters({
    refreshBuildSettings: async () => { calls.push('settings'); },
    validateAndBuild: async () => {
      calls.push('build');
      return { manifest: { schemaVersion: 1, posts: [] }, skippedCount: 0 };
    }
  });

  await runAction(input({
    operation: 'acknowledge-deployment',
    mode: 'build-only'
  }), fixture.value);

  assert.deepEqual(calls, ['settings', 'build']);
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
    deploymentCommitSha: 'd'.repeat(40),
    recordedStateSha: SHA
  }), fixture.value);
  assert.equal(envelope.commitSha, deployedCommitSha);
});

test('runs locally against a fixture repository without GitHub context', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-action-'));
  await mkdir(path.join(root, 'content', 'posts', 'post'), { recursive: true });
  await mkdir(path.join(root, '.gala'), { recursive: true });
  await mkdir(path.join(root, 'lib'), { recursive: true });
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
  await writeFile(path.join(root, 'lib', 'prism-compiled-output.js'),
    'export async function verifyPrismCompiledOutput() {}\n');
  const result = await runLocalFixture({
    root,
    input: input({ configPath: 'site.config.yml', timezone: 'UTC', outputDirectory: '_site' }),
    adapters: {
      now: () => new Date('2026-08-11T20:00:00Z'),
      refreshBuildSettings: async () => {}
    }
  });
  assert.equal(result.outcome, 'PARTIAL');
  assert.match(
    await readFile(path.join(root, '.gala', 'build', 'validated-posts.json'), 'utf8'),
    new RegExp(ARTICLE)
  );
  assert.match(await readFile(path.join(root, '_site', 'index.html'), 'utf8'), /doctype/);
});
