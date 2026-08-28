import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { approvalHmac, markdownBodyHashV2, GALA_PRISM_HASH_V1 } from '../src/prism-hashing.js';
import {
  normalizePrismProtection, normalizePrismSettings, readPrismRepository,
  validatePrismConfigurations,
} from '../src/prism-validation.js';

const IDS = {
  siteId: '01K00000000000000000000010',
  articleId: '01K00000000000000000000011',
  configurationId: '01K00000000000000000000012',
  revisionId: '01K00000000000000000000013',
  approvalId: '01K00000000000000000000014'
};
const SOURCE = 'a'.repeat(64);
const CURRENT = Buffer.alloc(32, 1);
const PREVIOUS = Buffer.alloc(32, 2);

test('normalized Prism settings retain the manifest schema discriminator', () => {
  assert.deepEqual(normalizePrismSettings({
    schemaVersion: 1, mode: 'MANUAL', configurationLinkPolicy: 'NOFOLLOW',
  }, new Set()), {
    schemaVersion: 1, mode: 'MANUAL', configurationLinkPolicy: 'NOFOLLOW',
    articleModes: {}, articleConfigurationLinkPolicies: {},
  });
});

test('normalizes only the versioned protection contract and verifies declared source text', () => {
  assert.deepEqual(normalizePrismProtection({
    schemaVersion: 1,
    caveats: ['Keep this caveat'],
    names: ['Café'],
    attributions: ['By Example']
  }, 'Café\n\nKeep this caveat\n\nBy Example\n'), {
    schemaVersion: 1,
    caveats: ['Keep this caveat'],
    names: ['Café'],
    attributions: ['By Example']
  });
  assert.throws(() => normalizePrismProtection({ caveats: ['Keep'] }, 'Keep'), /schemaVersion 1/);
  assert.throws(() => normalizePrismProtection(
    { schemaVersion: 1, unknown: [] }, '# Work\n'), /Unsupported prismProtection option/);
  assert.throws(() => normalizePrismProtection(
    { schemaVersion: 1, caveats: ['Missing'] }, '# Work\n'), /absent from the canonical work/);
});

test('rejects nested, mismatched, unclosed, and duplicate named prism-keep blocks', () => {
  assert.throws(() => normalizePrismProtection(null,
    '<!-- prism-keep:a -->\n<!-- prism-keep:b -->\n<!-- /prism-keep:b -->\n<!-- /prism-keep:a -->'),
  /must not be nested/);
  assert.throws(() => normalizePrismProtection(null,
    '<!-- prism-keep:a -->\nText\n<!-- /prism-keep:b -->'), /does not match/);
  assert.throws(() => normalizePrismProtection(null,
    '<!-- prism-keep:a -->\nText'), /not closed/);
  assert.throws(() => normalizePrismProtection(null,
    '<!-- prism-keep:a --><!-- /prism-keep:a -->\n'
      + '<!-- prism-keep:a --><!-- /prism-keep:a -->'), /Duplicate prism-keep id/);
  assert.deepEqual(normalizePrismProtection(null,
    '<!-- prism-keep:a -->\nText\n<!-- /prism-keep:a -->'), {});
});

function fixture(secret = CURRENT) {
  const markdown = '# A brief\n\nFaithful text.\n';
  const { siteId, ...artifactIds } = IDS;
  const approval = {
    schemaVersion: 1,
    ...artifactIds,
    language: 'en',
    sourceRevisionHash: SOURCE,
    configurationContentHash: markdownBodyHashV2(Buffer.from(markdown)),
    depth: 'BRIEF',
    intent: 'ORIENTATION',
    modality: 'TEXT',
    approvedAt: '2026-08-26T16:00:00.000Z',
    approvedBy: 'AUTHOR_OWNER',
    hashContract: GALA_PRISM_HASH_V1,
    approvalTokenVersion: 1
  };
  approval.approvalToken = approvalHmac(secret, {
    siteId,
    ...approval,
    authorityType: approval.approvedBy
  });
  const configuration = {
    configurationId: IDS.configurationId,
    revisionId: IDS.revisionId,
    approvalId: IDS.approvalId,
    articleId: IDS.articleId,
    language: 'en',
    depth: 'BRIEF',
    intent: 'ORIENTATION',
    modality: 'TEXT',
    sourceRevisionHash: approval.sourceRevisionHash,
    configurationContentHash: approval.configurationContentHash,
    approvedAt: approval.approvedAt,
    hashContract: approval.hashContract,
    approvalTokenVersion: approval.approvalTokenVersion,
    approvalToken: approval.approvalToken,
    markdown
  };
  return { approval, configuration };
}

test('publishes an approved body verified by the current secret', () => {
  const { approval, configuration } = fixture();
  const result = validatePrismConfigurations({
    siteId: IDS.siteId,
    canonicalVariants: new Map([[`${IDS.articleId}:en`, { sourceRevisionHash: SOURCE }]]),
    configurations: [configuration], approvals: [approval], currentSiteSecret: CURRENT
  });
  assert.equal(result[0].state, 'PUBLISHED');
  assert.equal(result[0].approvalTokenVerifiedWith, 'CURRENT');
  assert.equal(result[0].markdown, configuration.markdown);
});

test('discovers exact repository paths and emits verified Prism configuration state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-prism-repository-'));
  const parentDirectory = path.join(root, 'content', 'posts', 'example');
  const configurationDirectory = path.join(parentDirectory, 'prism', IDS.configurationId);
  const approvalDirectory = path.join(root, '.gala', 'prism', 'approvals');
  await mkdir(configurationDirectory, { recursive: true });
  await mkdir(approvalDirectory, { recursive: true });
  const parent = {
    source: 'content/posts/example/index.en.md',
    id: IDS.articleId,
    language: 'en',
    rawFrontmatter: { title: 'Canonical title', description: 'Description' },
    contentBody: '# Canonical\n\nTruth.\n',
    media: [{
      source: 'content/posts/example/restored-room.png',
      output: 'en/example/restored-room.png',
    }]
  };
  const media = Buffer.from('sandbox image bytes');
  await writeFile(path.join(parentDirectory, 'restored-room.png'), media);
  const { approval, configuration } = fixture();
  const { markdown, articleId: _articleId, language: _language, ...frontmatter } = configuration;
  frontmatter.schemaVersion = 1;
  frontmatter.parentArticleId = IDS.articleId;
  frontmatter.parentLanguage = 'en';
  delete frontmatter.articleId;
  delete frontmatter.language;
  // Repository source hash is derived from the exact canonical post rather than supplied by a fixture.
  const probe = await import('../src/prism-hashing.js');
  const sourceRevisionHash = probe.prismSourceHashV1({
    title: 'Canonical title', description: 'Description', markdownBody: Buffer.from(parent.contentBody),
    protectionContractJson: '{}', referencedMediaDigestsJson: JSON.stringify({
      'restored-room.png': (await import('node:crypto')).createHash('sha256')
        .update(media).digest('hex'),
    })
  });
  frontmatter.sourceRevisionHash = sourceRevisionHash;
  approval.sourceRevisionHash = sourceRevisionHash;
  approval.approvalToken = approvalHmac(CURRENT, {
    siteId: IDS.siteId, ...approval, authorityType: approval.approvedBy
  });
  frontmatter.approvalToken = approval.approvalToken;
  const yaml = Object.entries(frontmatter).map(([key, value]) => `  ${key}: ${value}`).join('\n');
  await writeFile(path.join(configurationDirectory, 'index.en.md'), `---\nprism:\n${yaml}\n---\n${markdown}`);
  await writeFile(path.join(approvalDirectory, `${IDS.approvalId}.json`), JSON.stringify(approval));

  const configurations = await readPrismRepository({
    root, siteId: IDS.siteId, canonicalPosts: [parent], currentSiteSecret: CURRENT
  });

  assert.equal(configurations.length, 1);
  assert.equal(configurations[0].state, 'PUBLISHED');
  assert.equal(configurations[0].parentSource, parent.source);
  assert.equal(parent.prismSourceHash, sourceRevisionHash);
});

test('falls back without transformed prose when the canonical source is stale', () => {
  const { approval, configuration } = fixture(PREVIOUS);
  const result = validatePrismConfigurations({
    siteId: IDS.siteId,
    canonicalVariants: new Map([[`${IDS.articleId}:en`, { sourceRevisionHash: 'b'.repeat(64) }]]),
    configurations: [configuration], approvals: [approval], currentSiteSecret: CURRENT,
    previousSiteSecret: PREVIOUS
  });
  assert.equal(result[0].state, 'STALE');
  assert.equal(result[0].approvalTokenVerifiedWith, 'PREVIOUS');
  assert.equal('markdown' in result[0], false);
});

test('fails closed for tampered prose, invalid tokens, and orphan approvals', () => {
  const { approval, configuration } = fixture();
  assert.throws(() => validatePrismConfigurations({
    siteId: IDS.siteId,
    canonicalVariants: new Map([[`${IDS.articleId}:en`, { sourceRevisionHash: SOURCE }]]),
    configurations: [{ ...configuration, markdown: 'tampered' }], approvals: [approval],
    currentSiteSecret: CURRENT
  }), /Unapproved Prism body/);
  assert.throws(() => validatePrismConfigurations({
    siteId: IDS.siteId,
    canonicalVariants: new Map([[`${IDS.articleId}:en`, { sourceRevisionHash: SOURCE }]]),
    configurations: [{ ...configuration, approvalToken: 'invalid' }],
    approvals: [{ ...approval, approvalToken: 'invalid' }],
    currentSiteSecret: CURRENT
  }), /Invalid Prism approval token/);
  assert.throws(() => validatePrismConfigurations({
    siteId: IDS.siteId,
    canonicalVariants: new Map(), configurations: [], approvals: [approval],
    currentSiteSecret: CURRENT
  }), /Orphan Prism approval/);
});
