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
