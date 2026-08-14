import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  resolveEffectivePost,
  resolveFolderSlugs,
  slugifyTitle,
  validatePost,
  validatePublicationState,
  validateContent
} from '../src/index.js';

const today = '2026-06-15';
const valid = {
  id: '01K00000000000000000000000',
  title: 'Valid post',
  slug: 'valid-post',
  publishAfterDate: '2026-06-15',
  language: 'en-US',
  tags: ['testing'],
  editHistory: ['2026-06-14 Corrected an example']
};

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
    ['raw HTML media is not allowed; use Markdown image syntax']);
  assert.deepEqual(results[0].media, []);
});

test('accepts the documented valid content contract', () => {
  assert.deepEqual(validatePost(valid, { today }), []);
});

test('reports required fields by name', () => {
  assert.deepEqual(validatePost({}, { today }), [
    'title is required',
    'publishAfterDate is required',
    'language is required'
  ]);
});

test('rejects reserved and structurally invalid slugs', () => {
  assert.match(validatePost({ ...valid, slug: 'feed' }, { today }).join('\n'), /reserved/);
  assert.match(validatePost({ ...valid, slug: 'Bad_slug' }, { today }).join('\n'), /lowercase/);
});

test('applies reserved slug rules to tags', () => {
  assert.deepEqual(validatePost({ ...valid, tags: ['feed'] }, { today }), [
    'tags[0] is reserved: feed'
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
  }, { today }), ['allowPublishedSlugChange must be a boolean']);
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
      /canonicalUrl must/
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
    /valid YYYY-MM-DD/
  );
  assert.match(
    validatePost({ ...valid, createdDate: '2026-02-30' }, { today }).join('\n'),
    /createdDate must be a valid YYYY-MM-DD date/
  );
  assert.match(
    validatePost({ ...valid, deleteDate: '2026-06-14' }, { today }).join('\n'),
    /must not be earlier/
  );
});

test('rejects future edit history instead of deferring it', () => {
  assert.match(
    validatePost({ ...valid, editHistory: ['2026-06-16 Future change'] }, { today }).join('\n'),
    /must not be future-dated/
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
  assert.match(invalid.errors[0][0], /post folder "My Post!" is invalid/);
  assert.match(invalid.errors[0][0], /lowercase \[a-z0-9-\]/);

  const reserved = resolveFolderSlugs([
    { folder: '/posts/feed', folderName: 'feed', language: 'en' }
  ]);
  assert.deepEqual(reserved.errors[0], ['post folder is reserved: feed']);
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
    errors.includes('language variants in one post folder declare conflicting slugs')
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
    shareTargets: ['X', 'email', 'x'],
    socialProfiles: [
      'github=https://github.com/example#ignored',
      'mastodon=https://social.example/@author'
    ]
  }), {
    siteName: 'Engineering Notes',
    siteAuthor: 'Anand',
    defaultLanguage: 'fr-CA',
    timezone: 'America/Toronto',
    shareTargets: ['x', 'email'],
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
