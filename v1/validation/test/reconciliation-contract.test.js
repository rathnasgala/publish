import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  compileContractSchema,
  reconciliationAjvOptions,
  reconciliationFormatNames,
  validateReconciliationEnvelope
} from '../src/reconciliation-contract.js';

const fixtures = JSON.parse(await readFile(
  new URL('../contracts/fixtures/reconciliation-envelope.json', import.meta.url),
  'utf8'
));
const languageFixtures = JSON.parse(await readFile(
  new URL('../contracts/fixtures/language-tags.json', import.meta.url),
  'utf8'
));

test('pins the Ajv behavior that is part of the wire contract', () => {
  assert.deepEqual(reconciliationAjvOptions, {
    allErrors: true,
    allowUnionTypes: false,
    strict: true,
    unicodeRegExp: true
  });
  assert.deepEqual(reconciliationFormatNames, []);
  assert.throws(
    () => compileContractSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      unknowmKeyword: true
    }),
    /unknown keyword/
  );
});

test('matches every shared reconciliation conformance fixture', () => {
  for (const fixture of fixtures) {
    const result = validateReconciliationEnvelope(fixture.payload);
    assert.equal(result.valid, fixture.valid, fixture.name);
    assert.deepEqual(result.errorIds, fixture.expectedErrorIds, fixture.name);
  }
});

test('requires the exact hosting-branch commit in every reconciliation envelope', () => {
  const payload = structuredClone(fixtures.find((fixture) => fixture.valid).payload);
  delete payload.deploymentCommitSha;
  const result = validateReconciliationEnvelope(payload);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errorIds, ['RECONCILIATION_SCHEMA_REQUIRED']);
});

test('accepts V2 Prism delivery and keeps V1 free of Prism fields', () => {
  const v2 = structuredClone(fixtures.find((fixture) => fixture.valid).payload);
  v2.schemaVersion = 2;
  v2.prism = {
    mode: 'MANUAL',
    configurationLinkPolicy: 'NOFOLLOW',
    articleModes: {},
    articleConfigurationLinkPolicies: {}
  };
  v2.articles[0].variants[0].prismSourceHash = 'b'.repeat(64);
  v2.articles[0].variants[0].prismHashContract = 'GALA_PRISM_HASH_V1';
  v2.articles[0].variants[0].prismProtectionContract = {};
  v2.articles[0].variants[0].prismReferencedMediaDigests = {};
  v2.articles[0].variants[0].configurations = [{
    id: '01K00000000000000000000010',
    revisionId: '01K00000000000000000000011',
    approvalId: '01K00000000000000000000012',
    approvalTokenVersion: 1,
    approvalTokenVerifiedWith: 'CURRENT',
    hashContract: 'GALA_PRISM_HASH_V1',
    state: 'PUBLISHED',
    sourceRevisionHash: 'b'.repeat(64),
    contentHash: 'c'.repeat(64),
    depth: 'BRIEF',
    intent: 'ORIENTATION',
    modality: 'TEXT',
    configurationLinkPolicy: 'NOFOLLOW',
    pageUrl: 'https://example.com/en/post/prism/01K00000000000000000000010/'
  }];
  assert.deepEqual(validateReconciliationEnvelope(v2), { valid: true, errorIds: [] });

  const v2WithProtection = structuredClone(v2);
  v2WithProtection.articles[0].variants[0].prismProtectionContract = {
    schemaVersion: 1,
    caveats: ['Do not omit this qualification.'],
    names: ['Gala Prism'],
    attributions: ['According to the author']
  };
  assert.deepEqual(validateReconciliationEnvelope(v2WithProtection), {
    valid: true,
    errorIds: []
  });

  for (const invalidProtection of [
    { caveats: ['Missing schema version'] },
    { schemaVersion: 2 },
    { schemaVersion: 1, unknown: [] },
    { schemaVersion: 1, caveats: ['duplicate', 'duplicate'] },
    { schemaVersion: 1, names: [''] }
  ]) {
    const invalid = structuredClone(v2);
    invalid.articles[0].variants[0].prismProtectionContract = invalidProtection;
    assert.equal(validateReconciliationEnvelope(invalid).valid, false);
  }

  const v2WithoutSourceFacts = structuredClone(v2);
  delete v2WithoutSourceFacts.articles[0].variants[0].prismSourceHash;
  assert.deepEqual(validateReconciliationEnvelope(v2WithoutSourceFacts).errorIds, [
    'RECONCILIATION_SCHEMA_REQUIRED'
  ]);

  const v1WithPrism = structuredClone(v2);
  v1WithPrism.schemaVersion = 1;
  assert.equal(validateReconciliationEnvelope(v1WithPrism).valid, false);

  const v2WithoutSettings = structuredClone(v2);
  delete v2WithoutSettings.prism;
  assert.deepEqual(validateReconciliationEnvelope(v2WithoutSettings).errorIds, [
    'RECONCILIATION_SCHEMA_REQUIRED'
  ]);
});

test('matches every shared language-tag conformance fixture', async () => {
  const { canonicalizeLanguageTag } = await import('../src/index.js');
  for (const fixture of languageFixtures) {
    if (fixture.valid) {
      assert.equal(canonicalizeLanguageTag(fixture.input), fixture.canonical, fixture.input);
    } else {
      assert.throws(
        () => canonicalizeLanguageTag(fixture.input),
        /language must be a valid BCP-47 tag/,
        fixture.input
      );
    }
  }
});
