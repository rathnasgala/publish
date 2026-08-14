import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import { attributionTier } from '../src/attribution.js';

const SITE = '01K00000000000000000000010';
const PRIVATE_KEY = 'MC4CAQAwBQYDK2VwBCIEIDJgh3gXVrzAdr2SutJ5CZAbZ0OiCCWIKnb0PT9ztoS5';

function entitlement(overrides = {}) {
  const value = {
    siteId: SITE,
    tier: 'PAID',
    issuedAt: '2026-08-14T00:00:00Z',
    expiresAt: '2026-08-15T00:00:00Z',
    keyId: 'attribution-v1',
    ...overrides
  };
  const canonical = JSON.stringify({
    expiresAt: value.expiresAt, issuedAt: value.issuedAt, keyId: value.keyId,
    siteId: value.siteId, tier: value.tier
  });
  value.signature = sign(null, Buffer.from(canonical), createPrivateKey({
    key: Buffer.from(PRIVATE_KEY, 'base64'), format: 'der', type: 'pkcs8'
  })).toString('base64url');
  return value;
}

test('valid site-bound current Ed25519 artifact removes attribution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-entitlement-'));
  await mkdir(path.join(root, '.gala'));
  await writeFile(path.join(root, '.gala', 'entitlement.json'), `${JSON.stringify(entitlement())}\n`);

  assert.equal(await attributionTier({
    root, siteId: SITE, now: new Date('2026-08-14T12:00:00Z')
  }), 'PAID');
});

test('missing malformed expired or site-mismatched artifacts fail safe to free', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-entitlement-'));
  await mkdir(path.join(root, '.gala'));
  assert.equal(await attributionTier({ root, siteId: SITE }), 'FREE');
  await writeFile(path.join(root, '.gala', 'entitlement.json'), '{');
  assert.equal(await attributionTier({ root, siteId: SITE }), 'FREE');
  await writeFile(path.join(root, '.gala', 'entitlement.json'), JSON.stringify(entitlement({
    expiresAt: '2026-08-13T00:00:00Z'
  })));
  assert.equal(await attributionTier({
    root, siteId: SITE, now: new Date('2026-08-14T12:00:00Z')
  }), 'FREE');
  await writeFile(path.join(root, '.gala', 'entitlement.json'), JSON.stringify(entitlement({
    siteId: '01K00000000000000000000011'
  })));
  assert.equal(await attributionTier({ root, siteId: SITE }), 'FREE');
});
