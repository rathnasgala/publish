import { createPublicKey, verify } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const KEYS = Object.freeze({
  'attribution-v1': 'MCowBQYDK2VwAyEAlrOwYWiSj4EEkqc+IiPNQ3bM6xJgaZdQxiMCisuO7No='
});
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const FIELDS = ['expiresAt', 'issuedAt', 'keyId', 'signature', 'siteId', 'tier'];

function canonical(value) {
  return JSON.stringify({
    expiresAt: value.expiresAt,
    issuedAt: value.issuedAt,
    keyId: value.keyId,
    siteId: value.siteId,
    tier: value.tier
  });
}

export async function attributionTier({ root, siteId, now = new Date() }) {
  if (!ULID.test(siteId)) throw new TypeError('siteId is invalid');
  const target = path.join(root, '.gala', 'entitlement.json');
  let source;
  try {
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return 'FREE';
    source = await readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return 'FREE';
    throw error;
  }
  try {
    const value = JSON.parse(source);
    if (value == null || Array.isArray(value) || typeof value !== 'object'
        || Object.keys(value).sort().join('\0') !== FIELDS.join('\0')
        || value.siteId !== siteId || value.tier !== 'PAID'
        || typeof value.keyId !== 'string' || KEYS[value.keyId] == null
        || typeof value.signature !== 'string') return 'FREE';
    const issuedAt = new Date(value.issuedAt);
    const expiresAt = new Date(value.expiresAt);
    if (!Number.isFinite(issuedAt.getTime()) || !Number.isFinite(expiresAt.getTime())
        || issuedAt > now || expiresAt <= now || expiresAt <= issuedAt) return 'FREE';
    const publicKey = createPublicKey({
      key: Buffer.from(KEYS[value.keyId], 'base64'), format: 'der', type: 'spki'
    });
    return verify(
      null, Buffer.from(canonical(value), 'utf8'), publicKey,
      Buffer.from(value.signature, 'base64url')
    ) ? 'PAID' : 'FREE';
  } catch {
    return 'FREE';
  }
}
