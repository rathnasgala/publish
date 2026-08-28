import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { analyzePrismLiteralRisk, PRISM_LITERAL_RISK_V1 } from '../src/prism-literal-risk.js';

const fixture = JSON.parse(await readFile(
  new URL('../contracts/prism-literal-risk-v1.json', import.meta.url), 'utf8'));

test('matches every GALA_PRISM_LITERAL_RISK_V1 contract fixture including spans', () => {
  assert.equal(fixture.contract, 'GALA_PRISM_LITERAL_RISK_V1');
  assert.equal(fixture.schemaVersion, PRISM_LITERAL_RISK_V1);
  for (const example of fixture.cases) {
    const report = analyzePrismLiteralRisk(example);
    const actual = report.findings.map(({ id, kind, severity, sourceSpan, configurationSpan }) => ({
      id, kind, severity,
      sourceText: sourceSpan == null ? null
        : example.canonicalBody.slice(sourceSpan.startOffset, sourceSpan.endOffset),
      configurationText: configurationSpan == null ? null
        : example.configurationBody.slice(configurationSpan.startOffset, configurationSpan.endOffset)
    }));
    assert.deepEqual(actual, example.expected, example.name);
  }
});

test('normalizes BOM, CRLF, and Unicode NFC before comparing', () => {
  const report = analyzePrismLiteralRisk({
    canonicalBody: '\uFEFF> “Cafe\u0301 costs $5.”\r\n',
    configurationBody: '> “Café costs $5.”\n',
    protectionContract: {}
  });
  assert.deepEqual(report.findings, []);
});

test('rejects malformed protection declarations instead of silently weakening protection', () => {
  assert.throws(() => analyzePrismLiteralRisk({
    canonicalBody: '# Work\n', configurationBody: '# Brief\n',
    protectionContract: { schemaVersion: 1, caveats: 'not-a-list' }
  }), /must contain non-empty text/);
  assert.throws(() => analyzePrismLiteralRisk({
    canonicalBody: '# Work\n', configurationBody: '# Brief\n',
    protectionContract: { schemaVersion: 1, caveats: ['Absent caveat'] }
  }), /absent from the canonical work/);
});
