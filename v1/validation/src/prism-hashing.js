import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { parseDocument } from 'yaml';

export const GALA_PRISM_HASH_V1 = 'GALA_PRISM_HASH_V1';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HASH = /^[0-9a-f]{64}$/;
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const APPROVED_AT = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function normalizedMarkdownBytes(source) {
  if (!ArrayBuffer.isView(source)) throw new TypeError('Markdown source must be bytes');
  const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const withoutBom = bytes.subarray(bytes.subarray(0, 3).equals(BOM) ? 3 : 0);
  let decoded;
  try {
    // One file preamble was already removed above. Preserve a second leading U+FEFF so Node and
    // Java implement the same versioned byte contract.
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(withoutBom);
  } catch (error) {
    throw new TypeError('Markdown body must be valid UTF-8', { cause: error });
  }
  return Buffer.from(decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC'));
}

export function markdownBodyHashV2(source) {
  return sha256(normalizedMarkdownBytes(source));
}

export function canonicalJson(source) {
  if (typeof source !== 'string') throw new TypeError('Canonical JSON source must be a string');
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new TypeError('Canonical JSON is malformed', { cause: error });
  }

  const duplicateCheck = parseDocument(source, { strict: true, uniqueKeys: true });
  const duplicate = duplicateCheck.errors.find((error) => error.code === 'DUPLICATE_KEY');
  if (duplicate) throw new TypeError('Canonical JSON contains a duplicate key', { cause: duplicate });
  return canonicalValue(value);
}

export function prismSourceHashV1({
  title,
  description = '',
  markdownBody,
  protectionContractJson,
  referencedMediaDigestsJson
}) {
  if (typeof title !== 'string' || title.trim() === '') throw new TypeError('title is required');
  const payload = Buffer.concat([
    Buffer.from('gala-prism-source-v1\n'),
    lengthPrefixed(title),
    lengthPrefixed(description ?? ''),
    lengthPrefixed(markdownBodyHashV2(markdownBody)),
    lengthPrefixed(canonicalJson(protectionContractJson)),
    lengthPrefixed(canonicalJson(referencedMediaDigestsJson))
  ]);
  return sha256(payload);
}

export function approvalPayload(facts) {
  validateApprovalFacts(facts);
  const values = [
    facts.siteId,
    facts.approvalId,
    facts.configurationId,
    facts.revisionId,
    facts.articleId,
    facts.language,
    facts.sourceRevisionHash,
    facts.configurationContentHash,
    facts.depth,
    facts.intent,
    facts.modality,
    facts.approvedAt,
    facts.authorityType,
    facts.hashContract,
    String(facts.approvalTokenVersion)
  ];
  return Buffer.concat([Buffer.from('gala-prism-approval-v1\n'), ...values.map(lengthPrefixed)]);
}

export function approvalHmac(secret, facts) {
  if (!ArrayBuffer.isView(secret) || secret.byteLength < 32) {
    throw new TypeError('Approval secret must contain 32 bytes');
  }
  return createHmac('sha256', secret).update(approvalPayload(facts)).digest('base64url');
}

export function verifyApprovalHmac(secret, facts, encoded) {
  if (typeof encoded !== 'string') return false;
  let supplied;
  try {
    supplied = Buffer.from(encoded, 'base64url');
  } catch {
    return false;
  }
  const expected = Buffer.from(approvalHmac(secret, facts), 'base64url');
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

function canonicalValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(normalizedText(value, 'JSON string'));
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON number is outside I-JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (typeof value === 'object') {
    const normalized = new Map();
    for (const [key, child] of Object.entries(value)) {
      const name = normalizedText(key, 'JSON object key');
      if (normalized.has(name)) throw new TypeError('JSON keys collide after Unicode normalization');
      normalized.set(name, child);
    }
    return `{${[...normalized.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalValue(child)}`)
      .join(',')}}`;
  }
  throw new TypeError('Unsupported JSON value');
}

function normalizedText(value, field) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${field} contains a lone surrogate`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`${field} contains a lone surrogate`);
    }
  }
  return value.normalize('NFC');
}

function lengthPrefixed(value) {
  if (typeof value !== 'string') throw new TypeError('Length-prefixed values must be strings');
  const bytes = Buffer.from(normalizedText(value, 'length-prefixed value'));
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes, Buffer.from('\n')]);
}

function validateApprovalFacts(facts) {
  if (facts == null || Array.isArray(facts) || typeof facts !== 'object') {
    throw new TypeError('Approval facts must be an object');
  }
  for (const id of [facts.siteId, facts.approvalId, facts.configurationId, facts.revisionId, facts.articleId]) {
    if (!ULID.test(id)) throw new TypeError('Approval ID must be a ULID');
  }
  if (!LANGUAGE.test(facts.language)) throw new TypeError('Approval language must be a BCP-47 tag');
  if (!HASH.test(facts.sourceRevisionHash) || !HASH.test(facts.configurationContentHash)) {
    throw new TypeError('Approval hashes must be lowercase SHA-256');
  }
  if (!['SIGNAL', 'BRIEF', 'STANDARD', 'COMPLETE', 'METHODS_REFERENCES'].includes(facts.depth)) {
    throw new TypeError('Unknown Prism depth');
  }
  if (!['ORIENTATION', 'STORY', 'PROOF', 'PRACTICE'].includes(facts.intent)) {
    throw new TypeError('Unknown Prism intent');
  }
  if (facts.modality !== 'TEXT') throw new TypeError('Unknown Prism modality');
  if (!APPROVED_AT.test(facts.approvedAt)) throw new TypeError('Approval timestamp must use UTC milliseconds');
  if (facts.authorityType !== 'AUTHOR_OWNER') throw new TypeError('Unknown Prism authority');
  if (facts.hashContract !== GALA_PRISM_HASH_V1) throw new TypeError('Unknown Prism hash contract');
  if (facts.approvalTokenVersion !== 1) throw new TypeError('Unknown Prism approval token version');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
