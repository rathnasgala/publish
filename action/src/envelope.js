import { validateReconciliationEnvelope } from '@rathnasgala/content-validation';
import validatorPackage from '@rathnasgala/content-validation/package.json' with { type: 'json' };
import { markdownBodyHash } from './content-hash.js';

const STATE = Object.freeze({ published: 'PUBLISHED', tombstoned: 'TOMBSTONED' });
export const CONTENT_VALIDATION_VERSION = validatorPackage.version;

function normalizedVariant(post) {
  const raw = post.rawFrontmatter;
  if (raw == null || Array.isArray(raw) || typeof raw !== 'object') {
    throw new TypeError(`Validated post ${post.source} is missing rawFrontmatter`);
  }
  const state = STATE[post.publicationState];
  if (state == null) throw new TypeError(`Post ${post.source} is not emitted`);
  return {
    language: post.language,
    state,
    contentHash: markdownBodyHash(post.contentBody),
    title: post.frontmatter?.title,
    description: post.frontmatter?.description ?? null,
    tags: post.frontmatter?.tags ?? [],
    coverImage: post.frontmatter?.coverImage ?? null,
    canonicalUrl: post.canonicalUrl,
    frontmatter: raw
  };
}

export function createReconciliationEnvelope({
  manifest,
  commitSha,
  runId,
  runAttempt,
  emittedAt,
  runStatus,
  daysSinceLastCommit,
  floorGuardOverride = null
}) {
  if (manifest == null || manifest.schemaVersion !== 1 || !Array.isArray(manifest.posts)) {
    throw new TypeError('Current validated build manifest is required');
  }
  const grouped = new Map();
  for (const post of manifest.posts) {
    const article = grouped.get(post.id) ?? { id: post.id, slug: post.slug, variants: [] };
    if (article.slug !== post.slug) {
      throw new TypeError(`Validated variants disagree on slug for ${post.id}`);
    }
    article.variants.push(normalizedVariant(post));
    grouped.set(post.id, article);
  }
  const articles = [...grouped.values()]
    .map((article) => ({
      ...article,
      variants: article.variants.sort((left, right) => left.language.localeCompare(right.language))
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const envelope = {
    schemaVersion: 1,
    commitSha,
    runId,
    runAttempt,
    emittedAt,
    runStatus,
    daysSinceLastCommit,
    themePackage: manifest.themePackage,
    statistics: manifest.statistics ?? { publicViewCounts: false },
    contact: manifest.contact ?? { enabled: false, websiteEnabled: false, phoneEnabled: false },
    ...(floorGuardOverride == null ? {} : { floorGuardOverride }),
    articles
  };
  const validation = validateReconciliationEnvelope(envelope);
  if (!validation.valid) {
    throw new TypeError(`Invalid reconciliation envelope: ${validation.errorIds.join(', ')}`);
  }
  return envelope;
}
