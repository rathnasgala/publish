import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createPostMetadata,
  createContentId,
  derivePublicationState,
  evaluatePublicationState,
  findArticleIdentityConflicts,
  findDuplicateVariants,
  normalizeContactConfiguration,
  normalizeSiteConfigurationOptions,
  normalizePathPrefix,
  parseFrontmatter,
  PublicationState,
  regenerateBuildManifest,
  resolveEffectivePost,
  resolveFolderSlugs,
  slugifyTitle,
  validatePost,
  validatePublicationState,
  validateContent
} from '../src/index.js';

const today = '2026-06-15';
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const LEGACY_THEME_PUBLICATION_STATES = new Set([
  PublicationState.PUBLISHED,
  PublicationState.TOMBSTONED
]);
const valid = {
  id: '01K00000000000000000000000',
  title: 'Valid post',
  slug: 'valid-post',
  publishAfterDate: '2026-06-15',
  language: 'en-US',
  tags: ['testing'],
  editHistory: ['2026-06-14 Corrected an example']
};

function assertLegacyThemeCanRead(manifest) {
  for (const [index, post] of manifest.posts.entries()) {
    assert.match(post.id, ULID_PATTERN, `legacy posts[${index}].id`);
    assert.equal(LEGACY_THEME_PUBLICATION_STATES.has(post.publicationState), true,
      `legacy posts[${index}].publicationState`);
  }
}

async function previewFixture(context, {
  themeVersion = '2.0.15',
  publishAfterDate = '2026-06-16',
  id = null
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-preview-manifest-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.gala'), { recursive: true });
  await mkdir(path.join(root, 'content', 'posts', 'scheduled'), { recursive: true });
  await writeFile(path.join(root, '.gala', 'managed-files.json'), JSON.stringify({
    themePackage: {
      name: '@rathnasgala/theme', version: themeVersion, availableDesignThemes: ['editorial']
    }
  }));
  await writeFile(path.join(root, 'site.config.yml'), [
    'schemaVersion: 1',
    'framework:',
    '  themePackage:',
    '    name: "@rathnasgala/theme"',
    `    version: "${themeVersion}"`,
    'site:',
    '  defaultLanguage: en',
    '  timezone: UTC',
    'hosting:',
    '  canonicalBaseUrl: https://writer.example',
    '  pathPrefix: /',
    '  canonicalPolicy: self',
    'design:',
    '  theme: editorial'
  ].join('\n'));
  const post = path.join(root, 'content', 'posts', 'scheduled', 'index.en.md');
  await writeFile(post, [
    '---',
    ...(id == null ? [] : [`id: ${id}`]),
    'title: Scheduled post',
    `publishAfterDate: ${publishAfterDate}`,
    'language: en',
    '---',
    '',
    'Private draft body.'
  ].join('\n'));
  return { root, post };
}

test('preview manifest includes scheduled posts without modifying their source', async (context) => {
  const { root, post } = await previewFixture(context);
  const before = await readFile(post, 'utf8');

  const generated = await regenerateBuildManifest({ root, today, preview: true });

  assert.equal(await readFile(post, 'utf8'), before);
  assert.equal(generated.manifest.preview, true);
  assert.equal(generated.manifest.posts.length, 1);
  assert.equal(generated.manifest.posts[0].publicationState, PublicationState.NOT_EMITTED);
  assert.equal(generated.manifest.posts[0].id, null);
  assert.deepEqual(generated.manifest.assignedContentIds, []);
});

test('preview manifest remains consumable by themes predating preview publication states', async (context) => {
  const { root, post } = await previewFixture(context, { themeVersion: '2.0.12' });
  const before = await readFile(post, 'utf8');

  const first = await regenerateBuildManifest({ root, today, preview: true });
  const second = await regenerateBuildManifest({ root, today, preview: true });

  assert.equal(await readFile(post, 'utf8'), before);
  assert.equal(first.manifest.posts[0].publicationState, PublicationState.PUBLISHED);
  assert.match(first.manifest.posts[0].id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.equal(second.manifest.posts[0].id, first.manifest.posts[0].id);
  assert.deepEqual(first.manifest.assignedContentIds, []);
  assertLegacyThemeCanRead(first.manifest);
});

test('preview-state support accepts build metadata and rejects prereleases at the capability boundary', async (context) => {
  const supported = await previewFixture(context, { themeVersion: '2.0.15+verified' });
  const prerelease = await previewFixture(context, { themeVersion: '2.0.15-beta.1' });

  const supportedManifest = await regenerateBuildManifest({ root: supported.root, today, preview: true });
  const prereleaseManifest = await regenerateBuildManifest({ root: prerelease.root, today, preview: true });

  assert.equal(supportedManifest.manifest.posts[0].publicationState, PublicationState.NOT_EMITTED);
  assert.equal(supportedManifest.manifest.posts[0].id, null);
  assert.equal(prereleaseManifest.manifest.posts[0].publicationState, PublicationState.PUBLISHED);
  assert.match(prereleaseManifest.manifest.posts[0].id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
});

test('preview compatibility covers every released-theme state and identity combination', async (context) => {
  const existingId = '01K00000000000000000000023';
  const cases = [
    { name: 'legacy scheduled without id', themeVersion: '2.0.12',
      publishAfterDate: '2026-06-16', id: null, state: PublicationState.PUBLISHED, generatedId: true },
    { name: 'legacy scheduled with id', themeVersion: '2.0.12',
      publishAfterDate: '2026-06-16', id: existingId, state: PublicationState.PUBLISHED, generatedId: false },
    { name: 'legacy published without id', themeVersion: '2.0.12',
      publishAfterDate: today, id: null, state: PublicationState.PUBLISHED, generatedId: true },
    { name: 'legacy published with id', themeVersion: '2.0.12',
      publishAfterDate: today, id: existingId, state: PublicationState.PUBLISHED, generatedId: false },
    { name: 'current scheduled without id', themeVersion: '2.0.15',
      publishAfterDate: '2026-06-16', id: null, state: PublicationState.NOT_EMITTED, generatedId: false },
    { name: 'current scheduled with id', themeVersion: '2.0.15',
      publishAfterDate: '2026-06-16', id: existingId, state: PublicationState.NOT_EMITTED, generatedId: false },
    { name: 'current published without id', themeVersion: '2.0.15',
      publishAfterDate: today, id: null, state: PublicationState.PUBLISHED, generatedId: false },
    { name: 'current published with id', themeVersion: '3.0.0',
      publishAfterDate: today, id: existingId, state: PublicationState.PUBLISHED, generatedId: false }
  ];

  for (const scenario of cases) {
    const fixture = await previewFixture(context, scenario);
    const sourceBefore = await readFile(fixture.post, 'utf8');
    const generated = await regenerateBuildManifest({ root: fixture.root, today, preview: true });
    const post = generated.manifest.posts[0];

    assert.equal(post.publicationState, scenario.state, `${scenario.name}: state`);
    assert.equal(await readFile(fixture.post, 'utf8'), sourceBefore, `${scenario.name}: source`);
    assert.deepEqual(generated.manifest.assignedContentIds, [], `${scenario.name}: assignments`);
    if (scenario.id != null) assert.equal(post.id, scenario.id, `${scenario.name}: existing id`);
    else if (scenario.generatedId) assert.match(post.id, ULID_PATTERN, `${scenario.name}: preview id`);
    else assert.equal(post.id, null, `${scenario.name}: nullable id`);
    if (scenario.themeVersion === '2.0.12') assertLegacyThemeCanRead(generated.manifest);
  }
});

test('preview normalizes em dashes in rendered content without modifying source', async (context) => {
  const { root, post } = await previewFixture(context);
  const source = (await readFile(post, 'utf8')).replace('Private draft body.', 'Private \u2014 draft.');
  await writeFile(post, source);

  const generated = await regenerateBuildManifest({ root, today, preview: true });

  assert.match(generated.manifest.posts[0].body, /Private - draft\./);
  assert.match(await readFile(post, 'utf8'), /Private \u2014 draft\./);
});

test('publish persists normalized em dashes before creating the manifest', async (context) => {
  const { root, post } = await previewFixture(context);
  const source = (await readFile(post, 'utf8'))
    .replace('publishAfterDate: 2026-06-16', 'publishAfterDate: 2026-06-15')
    .replace('Private draft body.', 'Private \u2014 draft.');
  await writeFile(post, source);

  const generated = await regenerateBuildManifest({
    root, today, idFactory: () => '01K00000000000000000000022'
  });

  assert.match(generated.manifest.posts[0].body, /Private - draft\./);
  assert.doesNotMatch(await readFile(post, 'utf8'), /\u2014/);
});

test('publish manifest remains the sole writer of missing article ids and withholds scheduled posts', async (context) => {
  const assignedIds = ['01K00000000000000000000009', '01K00000000000000000000010'];
  for (const [index, themeVersion] of ['2.0.12', '2.0.15'].entries()) {
    const { root, post } = await previewFixture(context, { themeVersion });
    const assignedId = assignedIds[index];

    const generated = await regenerateBuildManifest({
      root, today, idFactory: () => assignedId
    });

    assert.match(await readFile(post, 'utf8'), new RegExp(`^---\\nid: ${assignedId}\\n`));
    assert.equal(generated.manifest.preview, undefined);
    assert.equal(generated.manifest.posts.length, 0);
    assert.equal(generated.manifest.assignedContentIds.length, 1);
  }
});

test('derives durable deployment state only from published manifest variants', () => {
  const deployed = derivePublicationState({
    current: { schemaVersion: 1, posts: [] },
    deployedOn: today,
    deployedCommitSha: 'a'.repeat(40),
    manifest: {
      schemaVersion: 1,
      posts: [
        {
          source: 'content/posts/post/index.en.md', id: valid.id,
          slug: 'valid-post', language: 'en', publicationState: PublicationState.PUBLISHED
        },
        {
          source: 'content/posts/post/index.fr.md', id: valid.id,
          slug: 'valid-post', language: 'fr', publicationState: PublicationState.TOMBSTONED
        }
      ]
    }
  });
  assert.deepEqual(deployed.posts, [{
    id: valid.id,
    slug: 'valid-post',
    languages: { en: { firstPublishedOn: today } }
  }]);
});

test('retains body-free Prism configuration identity for later fallback builds', () => {
  const configuration = {
    configurationId: '01K00000000000000000000010',
    articleId: valid.id,
    language: 'en',
    revisionId: '01K00000000000000000000011',
    approvalId: '01K00000000000000000000012',
    approvalTokenVersion: 1,
    approvalTokenVerifiedWith: 'CURRENT',
    sourceRevisionHash: 'a'.repeat(64),
    configurationContentHash: 'b'.repeat(64),
    hashContract: 'GALA_PRISM_HASH_V1',
    depth: 'BRIEF', intent: 'ORIENTATION', modality: 'TEXT', state: 'PUBLISHED',
    relativeUrl: '/en/valid-post/prism/01K00000000000000000000010/',
    configurationLinkPolicy: 'NOFOLLOW',
    body: 'Approved prose that must not enter durable publication state.'
  };

  const deployed = derivePublicationState({
    current: { schemaVersion: 1, posts: [] }, deployedOn: today,
    deployedCommitSha: 'a'.repeat(40),
    manifest: {
      schemaVersion: 2,
      posts: [{ source: 'content/posts/post/index.en.md', id: valid.id,
        slug: 'valid-post', language: 'en', publicationState: PublicationState.PUBLISHED }],
      configurations: [configuration]
    }
  });

  assert.equal(deployed.configurations[0].configurationId, configuration.configurationId);
  assert.equal(deployed.configurations[0].configurationContentHash,
    configuration.configurationContentHash);
  assert.equal(deployed.configurations[0].approvalTokenVersion, 1);
  assert.equal(deployed.configurations[0].approvalTokenVerifiedWith, 'CURRENT');
  assert.equal(Object.hasOwn(deployed.configurations[0], 'body'), false);
});

test('parses YAML frontmatter and preserves unknown keys', () => {
  const result = parseFrontmatter('---\ntitle: Hello\ncustomField: preserved\n---\nBody\n');
  assert.deepEqual(result.errors, []);
  assert.equal(result.data.customField, 'preserved');
  assert.equal(result.body, 'Body\n');
});

test('strips one file-leading UTF-8 BOM before frontmatter parsing', () => {
  const result = parseFrontmatter('\uFEFF---\ntitle: Hello\n---\nBody\n');
  assert.deepEqual(result.errors, []);
  assert.equal(result.body, 'Body\n');
});

test('parses CRLF frontmatter without normalizing Markdown body bytes', () => {
  const source = '---\r\ntitle: Hello\r\n---\r\nBody\r\n';
  const result = parseFrontmatter(source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.data.title, 'Hello');
  assert.equal(result.body, 'Body\r\n');
  assert.notEqual(result.body, 'Body\n');
});

test('frontmatter errors explain the broken boundary or YAML and the correction', () => {
  assert.deepEqual(parseFrontmatter('# Article\n').errors, [
    'Post settings are missing. Start the file with a YAML frontmatter block between two "---" lines.'
  ]);
  assert.deepEqual(parseFrontmatter('---\ntitle: Article\n').errors, [
    'Post settings are not closed. Add a closing "---" line before the article body.'
  ]);
  const malformed = parseFrontmatter('---\ntitle: [broken\n---\nBody\n').errors[0];
  assert.match(malformed, /^Post settings contain invalid YAML:/);
  assert.match(malformed, /Correct the YAML between the "---" lines\.$/);
});

test('one Markdown AST accepts Markdown images and rejects raw HTML media', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-media-contract-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const post = path.join(root, 'content', 'posts', 'media-post');
  await mkdir(post, { recursive: true });
  await writeFile(path.join(post, 'photo.png'), 'fixture');
  const frontmatter = `---
id: 01K00000000000000000000000
title: Media
publishAfterDate: 2026-06-15
language: en
tags: [testing]
---
`;
  await writeFile(path.join(post, 'index.en.md'), `${frontmatter}![Photo](photo.png)\n`);
  let results = await validateContent({ root, today });
  assert.deepEqual(results[0].errors, []);
  assert.equal(results[0].media[0].reference, 'photo.png');

  await writeFile(path.join(post, 'index.en.md'),
    `${frontmatter}<img src="photo.png" alt="Photo">\n`);
  results = await validateContent({ root, today });
  assert.deepEqual(results[0].errors,
    ['An image, audio, or video uses raw HTML. Use Markdown image syntax such as "![Description](media/photo.jpg)".']);
  assert.deepEqual(results[0].media, []);
});

test('a missing media file names the file and gives both recovery choices', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-missing-media-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const post = path.join(root, 'content', 'posts', 'media-post');
  await mkdir(post, { recursive: true });
  await writeFile(path.join(post, 'index.en.md'), `---
id: 01K00000000000000000000000
title: Media
publishAfterDate: 2026-06-15
language: en
---
![Photo](media/missing.png)
`);

  const results = await validateContent({ root, today });

  assert.deepEqual(results[0].errors, [
    'Media file "media/missing.png" is missing. Upload it into this post folder or remove the Markdown reference.'
  ]);
});

test('canonical discovery never treats Prism configuration Markdown as a post', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-prism-discovery-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const post = path.join(root, 'content', 'posts', 'canonical');
  const prism = path.join(post, 'prism', '01K00000000000000000000012');
  await mkdir(prism, { recursive: true });
  await writeFile(path.join(post, 'index.en.md'), `---
id: 01K00000000000000000000011
title: Canonical
publishAfterDate: 2026-06-15
language: en
---
Canonical body.
`);
  await writeFile(path.join(prism, 'index.en.md'), `---
prism:
  schemaVersion: 1
---
Approved configuration body.
`);

  const results = await validateContent({ root, today });

  assert.equal(results.length, 1);
  assert.equal(path.basename(results[0].file), 'index.en.md');
  assert.equal(path.dirname(results[0].file), post);
  assert.deepEqual(results[0].errors, []);
});

test('accepts the documented valid content contract', () => {
  assert.deepEqual(validatePost(valid, { today }), []);
});

test('reports required fields by name', () => {
  assert.deepEqual(validatePost({}, { today }), [
    'Title is missing. Add a non-empty "title" value to the post frontmatter.',
    'Publish date is missing. Add "publishAfterDate" in YYYY-MM-DD format to the post frontmatter.',
    'Language is missing. Add a language such as "en" or "en-US" to the post frontmatter.'
  ]);
});

test('rejects reserved and structurally invalid slugs', () => {
  assert.match(validatePost({ ...valid, slug: 'feed' }, { today }).join('\n'), /reserved/);
  assert.match(validatePost({ ...valid, slug: 'Bad_slug' }, { today }).join('\n'), /lowercase/);
});

test('applies reserved slug rules to tags', () => {
  assert.deepEqual(validatePost({ ...valid, tags: ['feed'] }, { today }), [
    'Tag 1 ("feed") is reserved for a Gala page. Choose a different tag.'
  ]);
});

test('explains which tag is invalid, why it failed, and how to fix it', () => {
  assert.deepEqual(validatePost({
    ...valid,
    tags: ['Field Notes', 'valid-tag', 'two--hyphens', 'trailing-']
  }, { today }), [
    'Tag 1 ("Field Notes") is invalid. Use only lowercase letters and numbers separated by single hyphens, for example "field-notes".',
    'Tag 3 ("two--hyphens") is invalid. Use only lowercase letters and numbers separated by single hyphens, for example "field-notes".',
    'Tag 4 ("trailing-") is invalid. Use only lowercase letters and numbers separated by single hyphens, for example "field-notes".'
  ]);
});

test('accepts only a boolean published-slug override', () => {
  assert.deepEqual(validatePost({
    ...valid,
    allowPublishedSlugChange: true
  }, { today }), []);
  assert.deepEqual(validatePost({
    ...valid,
    allowPublishedSlugChange: 'true'
  }, { today }), ['"allowPublishedSlugChange" must be true or false without quotes.']);
});

test('rejects malformed, unsafe, and credential-bearing canonical URLs per post', () => {
  for (const canonicalUrl of [
    'not a URL',
    'javascript:alert(1)',
    'http://example.com/post',
    'https://user:secret@example.com/post'
  ]) {
    assert.match(
      validatePost({ ...valid, canonicalUrl }, { today }).join('\n'),
      /canonicalUrl .* is invalid/
    );
  }
  assert.deepEqual(validatePost({
    ...valid,
    canonicalUrl: 'https://canonical.example/post?source=gala#ignored'
  }, { today }), []);
});

test('rejects impossible dates and deletion before publication', () => {
  assert.match(
    validatePost({ ...valid, publishAfterDate: '2026-02-30' }, { today }).join('\n'),
    /real date in YYYY-MM-DD/
  );
  assert.match(
    validatePost({ ...valid, createdDate: '2026-02-30' }, { today }).join('\n'),
    /Created date .* is invalid/
  );
  assert.match(
    validatePost({ ...valid, deleteDate: '2026-06-14' }, { today }).join('\n'),
    /before publish date/
  );
});

test('rejects future edit history instead of deferring it', () => {
  assert.match(
    validatePost({ ...valid, editHistory: ['2026-06-16 Future change'] }, { today }).join('\n'),
    /after today/
  );
});

test('rejects a missing, malformed, or impossible injected date', () => {
  assert.throws(() => validatePost(valid, {}), /today must be a valid YYYY-MM-DD date/);
  assert.throws(() => validatePost(valid, { today: 'tomorrow' }), /today must be a valid YYYY-MM-DD date/);
  assert.throws(() => validatePost(valid, { today: '2026-02-30' }), /today must be a valid YYYY-MM-DD date/);
});

test('identifies every member of a duplicate slug-language variant', () => {
  assert.deepEqual(findDuplicateVariants([
    { slug: 'same', language: 'en' },
    { slug: 'same', language: 'fr' },
    { slug: 'same', language: 'EN' }
  ]), [{ slug: 'same', language: 'en', indexes: [0, 2] }]);

  assert.deepEqual(findDuplicateVariants([
    { slug: 'same', language: 'iw' },
    { slug: 'same', language: 'he' }
  ]), [{ slug: 'same', language: 'he', indexes: [0, 1] }]);
});

test('derives one folder-wide slug without transforming the folder name', () => {
  assert.deepEqual(resolveFolderSlugs([
    { folder: '/posts/hello-world', folderName: 'hello-world', language: 'en' },
    { folder: '/posts/hello-world', folderName: 'hello-world', language: 'fr' }
  ]), {
    slugs: ['hello-world', 'hello-world'],
    errors: [[], []]
  });

  const invalid = resolveFolderSlugs([
    { folder: '/posts/My Post!', folderName: 'My Post!', language: 'en' }
  ]);
  assert.equal(invalid.slugs[0], null);
  assert.match(invalid.errors[0][0], /Post folder "My Post!" is invalid/);
  assert.match(invalid.errors[0][0], /lowercase letters and numbers/);

  const reserved = resolveFolderSlugs([
    { folder: '/posts/feed', folderName: 'feed', language: 'en' }
  ]);
  assert.deepEqual(reserved.errors[0], [
    'Post folder "feed" is reserved for a Gala page. Rename the folder.'
  ]);
});

test('one explicit variant slug applies to the folder and conflicting declarations fail all variants', () => {
  assert.deepEqual(resolveFolderSlugs([
    { folder: '/posts/notes', folderName: 'notes', slug: 'pinned-url', language: 'en' },
    { folder: '/posts/notes', folderName: 'notes', language: 'fr' }
  ]), {
    slugs: ['pinned-url', 'pinned-url'],
    errors: [[], []]
  });

  const conflict = resolveFolderSlugs([
    { folder: '/posts/notes', folderName: 'notes', slug: 'english-url', language: 'en' },
    { folder: '/posts/notes', folderName: 'notes', slug: 'french-url', language: 'fr' }
  ]);
  assert.deepEqual(conflict.slugs, [null, null]);
  assert.ok(conflict.errors.every((errors) =>
    errors.includes('Language versions in this post folder use different slugs. Keep one slug for every language version.')
  ));

  for (const slug of ['Bad_slug', 'feed']) {
    const invalid = resolveFolderSlugs([
      { folder: '/posts/notes', folderName: 'notes', slug, language: 'en' },
      { folder: '/posts/notes', folderName: 'notes', language: 'fr' }
    ]);
    assert.deepEqual(invalid.slugs, [null, null]);
    assert.ok(invalid.errors.every((errors) => errors.length === 1));
  }
});

test('detects conflicting identities within a folder and reuse across folders', () => {
  const posts = [
    { folder: 'one', id: '01K00000000000000000000000' },
    { folder: 'one', id: '01K00000000000000000000001' },
    { folder: 'two', id: '01K00000000000000000000000' },
    { folder: 'one' }
  ];

  assert.deepEqual(findArticleIdentityConflicts(posts), [
    { type: 'folder', value: 'one', indexes: [0, 1] },
    { type: 'identity', value: '01K00000000000000000000000', indexes: [0, 2] }
  ]);
});

test('allows one identity across variants in one folder and ignores missing ids', () => {
  assert.deepEqual(findArticleIdentityConflicts([
    { folder: 'one', id: '01K00000000000000000000000' },
    { folder: 'one', id: '01K00000000000000000000000' },
    { folder: 'two' }
  ]), []);
});

test('derives a legal folder name and creates metadata without a duplicate slug field', () => {
  assert.equal(slugifyTitle('  Café: A Practical Guide!  '), 'cafe-a-practical-guide');
  const metadata = createPostMetadata({ title: 'Hello World', language: 'fr-ca', today });
  assert.match(metadata.id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.equal(metadata.slug, undefined);
  assert.equal(metadata.publishAfterDate, today);
  assert.equal(metadata.language, 'fr-CA');
});

test('content ID generation is injectable by timestamp and canonical', () => {
  assert.equal(createContentId(Date.parse('2026-06-15T00:00:00Z')).length, 26);
  assert.match(createContentId(Date.parse('2026-06-15T00:00:00Z')), /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
});

test('refuses reserved derived slugs', () => {
  assert.throws(() => slugifyTitle('API'), /reserved/);
});

test('normalizes fail-safe authenticated contact settings', () => {
  assert.deepEqual(normalizeContactConfiguration(), {
    enabled: false,
    websiteEnabled: false,
    phoneEnabled: false
  });
  assert.deepEqual(normalizeContactConfiguration({
    enabled: true,
    websiteEnabled: true,
    phoneEnabled: false
  }), {
    enabled: true,
    websiteEnabled: true,
    phoneEnabled: false
  });
  for (const value of [
    true,
    { enabled: true, destinationEmail: 'author@example.com' },
    { enabled: 'true' },
    { enabled: false, unknown: true }
  ]) {
    assert.throws(() => normalizeContactConfiguration(value), /contact/);
  }
});

test('normalizes the documented local site configuration contract', () => {
  assert.deepEqual(normalizeSiteConfigurationOptions({
    siteName: ' Engineering Notes ',
    siteAuthor: ' Anand ',
    defaultLanguage: 'fr-ca',
    timezone: 'America/Toronto',
    shareTargets: ['LinkedIn', 'email', 'linkedin'],
    socialProfiles: [
      'github=https://github.com/example#ignored',
      'mastodon=https://social.example/@author'
    ]
  }), {
    siteName: 'Engineering Notes',
    siteAuthor: 'Anand',
    defaultLanguage: 'fr-CA',
    timezone: 'America/Toronto',
    shareTargets: ['linkedin', 'email'],
    socialProfiles: {
      github: 'https://github.com/example',
      mastodon: 'https://social.example/@author'
    }
  });
});

test('rejects invalid site configuration values before persistence', () => {
  const invalid = [
    [{ siteAuthor: '   ' }, /siteAuthor/],
    [{ defaultLanguage: 'not_a_language' }, /BCP-47/],
    [{ timezone: 'Mars/Olympus' }, /IANA/],
    [{ shareTargets: ['facebook'] }, /Unsupported share target/],
    [{ socialProfiles: ['facebook=https://example.com'] }, /Unsupported social profile/],
    [{ socialProfiles: ['github=http://github.com/example'] }, /must use HTTPS/],
    [{ socialProfiles: ['github=https://user:secret@github.com/example'] }, /without credentials/],
    [{ unknown: 'value' }, /Unsupported site configuration option/]
  ];
  for (const [options, expected] of invalid) {
    assert.throws(() => normalizeSiteConfigurationOptions(options), expected);
  }
});

test('resolves lifecycle, canonical language, URL, and canonical exactly once', () => {
  assert.equal(normalizePathPrefix(''), '/');
  assert.equal(normalizePathPrefix('/'), '/');
  assert.equal(normalizePathPrefix('/notes/'), '/notes');
  assert.deepEqual(resolveEffectivePost({
    data: { language: 'fr-ca', publishAfterDate: today },
    slug: 'hello-world',
    today,
    canonicalBaseUrl: 'https://example.com',
    pathPrefix: '/notes'
  }), {
    slug: 'hello-world',
    language: 'fr-CA',
    relativeUrl: '/fr-CA/hello-world/',
    pageUrl: 'https://example.com/notes/fr-CA/hello-world/',
    canonicalUrl: 'https://example.com/notes/fr-CA/hello-world/',
    publicationState: PublicationState.PUBLISHED
  });
  assert.equal(evaluatePublicationState({
    publishAfterDate: '2026-06-16',
    deleteDate: '2026-06-14'
  }, today), PublicationState.NOT_EMITTED);
  assert.equal(resolveEffectivePost({
    data: {
      language: 'en',
      publishAfterDate: today,
      canonicalUrl: 'https://canonical.example/post'
    },
    slug: 'post',
    today,
    canonicalBaseUrl: 'https://example.com'
  }).canonicalUrl, 'https://canonical.example/post');
  assert.throws(() => resolveEffectivePost({
    data: { language: 'en', publishAfterDate: today },
    slug: 'post',
    today,
    canonicalBaseUrl: 'https://example.com/notes',
    pathPrefix: '/notes'
  }), /pathPrefix/);
});

test('validates per-language first-publication state', () => {
  assert.deepEqual(validatePublicationState({
    schemaVersion: 1,
    posts: [{
      id: '01K00000000000000000000000',
      slug: 'hello-world',
      languages: {
        en: { firstPublishedOn: today },
        'fr-ca': { firstPublishedOn: '2026-06-14' }
      }
    }]
  }), {
    schemaVersion: 1,
    posts: [{
      id: '01K00000000000000000000000',
      slug: 'hello-world',
      languages: {
        en: { firstPublishedOn: today },
        'fr-CA': { firstPublishedOn: '2026-06-14' }
      }
    }]
  });
  assert.throws(() => validatePublicationState({
    schemaVersion: 1,
    posts: [{
      id: '01K00000000000000000000000',
      slug: 'feed',
      languages: { en: { firstPublishedOn: today } }
    }]
  }), /slug is invalid/);
});
