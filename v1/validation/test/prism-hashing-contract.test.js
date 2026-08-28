import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  GALA_PRISM_HASH_V1,
  approvalHmac,
  approvalPayload,
  canonicalJson,
  markdownBodyHashV2,
  normalizedMarkdownBytes,
  prismSourceHashV1
} from '../src/prism-hashing.js';

const fixture = JSON.parse(await readFile(
  new URL('../contracts/prism-hashing-v1.json', import.meta.url),
  'utf8'
));

test('matches every language-neutral GALA_PRISM_HASH_V1 fixture', () => {
  assert.equal(fixture.contract, GALA_PRISM_HASH_V1);
  for (const example of fixture.markdownCases) {
    const input = Buffer.from(example.inputBase64, 'base64');
    assert.equal(normalizedMarkdownBytes(input).toString('base64'), example.normalizedBase64, example.name);
    assert.equal(markdownBodyHashV2(input), example.digest, example.name);
  }
  for (const example of fixture.canonicalJsonCases) {
    assert.equal(canonicalJson(example.input), example.canonical, example.name);
  }

  const { facts, keyBase64, payloadBase64, hmac } = fixture.approvalCase;
  assert.equal(approvalPayload(facts).toString('base64'), payloadBase64);
  assert.equal(approvalHmac(Buffer.from(keyBase64, 'base64'), facts), hmac);
});

test('normalizes one leading BOM, line endings, and Unicode NFC', () => {
  const serialized = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('Cafe\u0301\r\nsecond\rthird')
  ]);
  assert.equal(markdownBodyHashV2(serialized), markdownBodyHashV2(Buffer.from('Café\nsecond\nthird')));
});

test('rejects malformed UTF-8 and preserves significant bytes', () => {
  assert.throws(() => markdownBodyHashV2(Buffer.from([0xc3, 0x28])), /UTF-8/);
  assert.notEqual(markdownBodyHashV2(Buffer.from('body')), markdownBodyHashV2(Buffer.from('body\n')));
  assert.notEqual(markdownBodyHashV2(Buffer.from('body')), markdownBodyHashV2(Buffer.from('bo\uFEFFdy')));
  const twoLeadingBoms = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]),
    Buffer.from('body')
  ]);
  assert.deepEqual(normalizedMarkdownBytes(twoLeadingBoms), Buffer.from('\uFEFFbody'));
});

test('canonicalizes nested JSON and rejects ambiguous keys', () => {
  const first = '{"z":{"é":1,"a":[true,null,"Cafe\\u0301"]},"a":2}';
  const second = '{"a":2.0,"z":{"a":[true,null,"Café"],"\\u0065\\u0301":1}}';
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(canonicalJson(first), '{"a":2,"z":{"a":[true,null,"Café"],"é":1}}');
  assert.throws(() => canonicalJson('{"a":1,"a":2}'), /duplicate/i);
  assert.throws(() => canonicalJson('{"é":1,"e\\u0301":2}'), /normalization/i);
});

test('source hash includes title and canonical contracts', () => {
  const input = {
    title: 'A title',
    description: '',
    markdownBody: Buffer.from('Words\n'),
    protectionContractJson: '{"caveats":["Keep this"]}',
    referencedMediaDigestsJson: `{"media/photo.jpg":"${'a'.repeat(64)}"}`
  };
  const hash = prismSourceHashV1(input);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, prismSourceHashV1({ ...input, title: 'A changed title' }));
});

test('approval payload uses UTF-8 byte lengths and stable base64url HMAC', () => {
  const facts = {
    siteId: '01K00000000000000000000010',
    approvalId: '01K00000000000000000000011',
    configurationId: '01K00000000000000000000012',
    revisionId: '01K00000000000000000000013',
    articleId: '01K00000000000000000000014',
    language: 'en',
    sourceRevisionHash: 'a'.repeat(64),
    configurationContentHash: 'b'.repeat(64),
    depth: 'BRIEF',
    intent: 'ORIENTATION',
    modality: 'TEXT',
    approvedAt: '2026-08-26T16:00:00.000Z',
    authorityType: 'AUTHOR_OWNER',
    hashContract: GALA_PRISM_HASH_V1,
    approvalTokenVersion: 1
  };
  assert.match(approvalPayload(facts).toString(), /^gala-prism-approval-v1\n26:01K/);
  assert.match(approvalHmac(Buffer.from('0123456789abcdef0123456789abcdef'), facts), /^[\w-]{43}$/);
});
