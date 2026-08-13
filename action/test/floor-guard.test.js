import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateDeployFloor, floorOverrideReason } from '../src/floor-guard.js';

test('uses the smaller proportional or absolute loss threshold', () => {
  assert.throws(() => evaluateDeployFloor({
    previousPageCount: 10, currentPageCount: 8
  }), /2 of 10 pages missing/);
  assert.doesNotThrow(() => evaluateDeployFloor({
    previousPageCount: 10, currentPageCount: 9
  }));
  assert.throws(() => evaluateDeployFloor({
    previousPageCount: 1_000, currentPageCount: 975
  }), /25 of 1000 pages missing/);
  assert.throws(() => evaluateDeployFloor({
    previousPageCount: 5_000, currentPageCount: 4_975
  }), /25 of 5000 pages missing/);
});

test('exempts only an absent prior successful deployment count', () => {
  assert.equal(evaluateDeployFloor({
    previousPageCount: null, currentPageCount: 0
  }).exempt, true);
  assert.equal(evaluateDeployFloor({
    previousPageCount: 0, currentPageCount: 0
  }).exempt, false);
});

test('parses one non-empty commit trailer and does not inherit it across messages', () => {
  assert.equal(
    floorOverrideReason('Retire archive\n\nGala-Floor-Override: Remove obsolete 2019 series\n'),
    'Remove obsolete 2019 series'
  );
  assert.equal(floorOverrideReason('Follow-up typo fix'), null);
  assert.throws(() => floorOverrideReason(
    'Gala-Floor-Override: first\nGala-Floor-Override: second'
  ), /at most one/);
});

test('a reasoned override is loud and preserves the loss magnitude', () => {
  const result = evaluateDeployFloor({
    previousPageCount: 1_000,
    currentPageCount: 800,
    overrideReason: 'Retire obsolete archive'
  });
  assert.deepEqual(result, {
    previousPageCount: 1_000,
    currentPageCount: 800,
    lostPages: 200,
    permittedLoss: 25,
    exempt: false,
    overridden: true,
    allowed: true,
    reason: 'Retire obsolete archive'
  });
  assert.throws(() => evaluateDeployFloor({
    previousPageCount: 100,
    currentPageCount: 50,
    overrideReason: 'x'.repeat(501)
  }), /1 to 500/);
});

test('guard failure names magnitude and every skipped validation reason', () => {
  assert.throws(() => evaluateDeployFloor({
    previousPageCount: 100,
    currentPageCount: 50,
    skipped: [{ source: 'content/posts/broken/index.en.md', errors: ['title is required'] }]
  }), /content\/posts\/broken\/index\.en\.md: title is required/);
});
