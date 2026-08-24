import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionOutcome, parseActionInputs, publicOutputs } from '../src/contract.js';

const SHA = 'a'.repeat(40);
const SITE = '01K00000000000000000000010';

function values(overrides = {}) {
  return {
    operation: 'build',
    mode: 'build-only',
    'site-id': SITE,
    'site-secret': '0123456789abcdef0123456789abcdef',
    'api-base-url': 'https://api.example.com',
    'output-directory': '_site',
    timezone: 'America/Los_Angeles',
    'config-path': '',
    'floor-guard-percent': '',
    'floor-guard-pages': '',
    'keepalive-threshold-days': '',
    'floor-guard-override-commit-sha': '',
    'deployed-commit-sha': '',
    'deployment-commit-sha': '',
    'recorded-state-sha': '',
    'failure-code': '',
    'failure-message': '',
    'run-id': '42',
    'run-attempt': '1',
    ...overrides
  };
}

function parse(overrides = {}, env = { GITHUB_SHA: SHA }) {
  const input = values(overrides);
  return parseActionInputs({ getInput: (name) => input[name] ?? '', env, root: '/fixture' });
}

test('accepts both build modes and applies the checkout-safe config default', () => {
  assert.equal(parse().mode, 'build-only');
  assert.equal(parse({ mode: 'build-and-deploy' }).mode, 'build-and-deploy');
  assert.equal(parse().configPath, 'site.config.yml');
  assert.equal(parse().timezone, 'America/Los_Angeles');
  assert.equal(parse().floorGuardPercent, 20);
  assert.equal(parse().floorGuardPages, 25);
  assert.equal(parse().keepaliveThresholdDays, 50);
});

test('accepts acknowledgement only in build-only with explicit deployed and recorded-state SHAs', () => {
  const acknowledged = parse({
    operation: 'acknowledge-deployment',
    mode: 'build-only',
    'deployed-commit-sha': 'b'.repeat(40),
    'deployment-commit-sha': 'd'.repeat(40),
    'recorded-state-sha': 'c'.repeat(40)
  });
  assert.equal(acknowledged.commitSha, 'c'.repeat(40));
  assert.equal(acknowledged.deployedCommitSha, 'b'.repeat(40));
  assert.equal(acknowledged.deploymentCommitSha, 'd'.repeat(40));
  assert.throws(() => parse({
    operation: 'acknowledge-deployment', mode: 'build-and-deploy',
    'deployed-commit-sha': 'b'.repeat(40),
    'recorded-state-sha': 'c'.repeat(40)
  }), /requires mode build-only/);
  assert.throws(() => parse({ operation: 'acknowledge-deployment' }), /deployment.*SHAs|required lowercase/);
  assert.throws(() => parse({
    operation: 'acknowledge-deployment',
    mode: 'build-only',
    'deployed-commit-sha': 'b'.repeat(40),
    'recorded-state-sha': 'c'.repeat(40)
  }), /deployment-commit-sha.*required/);
  assert.throws(() => parse({ 'deployed-commit-sha': 'b'.repeat(40) }), /accepted only/);
  assert.throws(() => parse({ 'deployment-commit-sha': 'not-a-sha' }), /deployment-commit-sha/);
});

test('accepts only a complete bounded workflow failure report', () => {
  const reported = parse({
    operation: 'report-failure',
    mode: 'build-only',
    'failure-code': 'DEPLOYMENT_FAILED',
    'failure-message': 'The gh-pages push failed.'
  });
  assert.equal(reported.commitSha, SHA);
  assert.equal(reported.failureCode, 'DEPLOYMENT_FAILED');
  assert.equal(reported.failureMessage, 'The gh-pages push failed.');
  assert.throws(() => parse({ operation: 'report-failure' }), /failure-code is required/);
  assert.throws(() => parse({
    operation: 'report-failure',
    'failure-code': 'not valid',
    'failure-message': 'failed'
  }), /failure-code/);
  assert.throws(() => parse({
    operation: 'build',
    'failure-code': 'DEPLOYMENT_FAILED',
    'failure-message': 'failed'
  }), /accepted only for report-failure/);
});

test('rejects invalid timezone, traversal, identifiers, and numeric inputs', () => {
  assert.throws(() => parse({ timezone: 'Mars/Olympus' }), /IANA/);
  assert.throws(() => parse({ 'config-path': '../site.yml' }), /within the checkout/);
  assert.throws(() => parse({ 'output-directory': '../site' }), /child path/);
  assert.throws(() => parse({ 'site-id': 'site' }), /canonical ULID/);
  assert.throws(() => parse({ 'floor-guard-percent': '-1' }), /integer/);
  assert.throws(() => parse({ 'run-attempt': '0' }), /at least 1/);
  assert.throws(() => parse({ 'keepalive-threshold-days': '60' }), /below 60/);
});

test('accepts floor override confirmation only for current build-and-deploy SHA', () => {
  assert.equal(parse({
    mode: 'build-and-deploy',
    'floor-guard-override-commit-sha': SHA
  }).floorGuardOverrideCommitSha, SHA);
  assert.throws(() => parse({ 'floor-guard-override-commit-sha': SHA }), /only for build-and-deploy/);
  assert.throws(() => parse({
    operation: 'acknowledge-deployment',
    mode: 'build-only',
    'deployed-commit-sha': SHA,
    'deployment-commit-sha': SHA,
    'recorded-state-sha': SHA,
    'floor-guard-override-commit-sha': SHA
  }), /only for build-and-deploy/);
  assert.throws(() => parse({
    mode: 'build-and-deploy',
    'floor-guard-override-commit-sha': 'b'.repeat(40)
  }), /must equal checkout HEAD/);
});

test('public outputs are exactly the pinned contract and never include the secret', () => {
  const outputs = publicOutputs({
    outcome: ActionOutcome.PARTIAL,
    publishedCount: 1,
    republishedCount: 2,
    delistedCount: 3,
    skippedCount: 4,
    daysSinceLastCommit: 5,
    keepaliveCommitted: true,
    floorGuardOverridden: true,
    floorGuardOverrideReason: 'retire archive',
    floorGuardLostPages: 200
  }, '0.0.1');
  assert.deepEqual(outputs, {
    outcome: 'PARTIAL',
    'published-count': 1,
    'republished-count': 2,
    'delisted-count': 3,
    'skipped-count': 4,
    'days-since-last-commit': 5,
    'keepalive-committed': true,
    'floor-guard-overridden': true,
    'floor-guard-override-reason': 'retire archive',
    'floor-guard-lost-pages': 200,
    'validator-version': '0.0.1'
  });
  assert.equal(JSON.stringify(outputs).includes('site-secret'), false);
});
