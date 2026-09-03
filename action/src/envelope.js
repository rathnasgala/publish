import { validateReconciliationEnvelope } from '@rathnasgala/content-validation';
import validatorPackage from '@rathnasgala/content-validation/package.json' with { type: 'json' };
import { markdownBodyHash } from './content-hash.js';

const STATE = Object.freeze({ published: 'PUBLISHED', tombstoned: 'TOMBSTONED' });
export const CONTENT_VALIDATION_VERSION = validatorPackage.version;

function normalizedVariant(post, configurations = []) {
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
    frontmatter: raw,
    markdownBody: post.contentBody,
    ...(post.prismSourceHash == null ? {} : {
      prismSourceHash: post.prismSourceHash,
      prismHashContract: post.prismHashContract,
      prismProtectionContract: post.prismProtectionContract ?? {},
      prismReferencedMediaDigests: post.prismReferencedMediaDigests ?? {},
      configurations: configurations
        .filter((configuration) => configuration.articleId === post.id
          && configuration.language === post.language)
        .map((configuration) => ({
          id: configuration.configurationId,
          revisionId: configuration.revisionId,
          approvalId: configuration.approvalId,
          approvalTokenVersion: configuration.approvalTokenVersion,
          approvalTokenVerifiedWith: configuration.approvalTokenVerifiedWith,
          hashContract: configuration.hashContract,
          state: configuration.state,
          sourceRevisionHash: configuration.sourceRevisionHash,
          contentHash: configuration.configurationContentHash,
          depth: configuration.depth,
          intent: configuration.intent,
          modality: configuration.modality,
          configurationLinkPolicy: configuration.configurationLinkPolicy,
          pageUrl: configuration.pageUrl,
        })),
    }),
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
  deploymentCommitSha,
  floorGuardOverride = null
}) {
  if (manifest == null || ![1, 2].includes(manifest.schemaVersion)
      || !Array.isArray(manifest.posts)) {
    throw new TypeError('Current validated build manifest is required');
  }
  if (typeof deploymentCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(deploymentCommitSha)) {
    throw new TypeError('deploymentCommitSha must be a lowercase commit SHA');
  }
  const grouped = new Map();
  for (const post of manifest.posts) {
    const article = grouped.get(post.id) ?? { id: post.id, slug: post.slug, variants: [] };
    if (article.slug !== post.slug) {
      throw new TypeError(`Validated variants disagree on slug for ${post.id}`);
    }
    article.variants.push(normalizedVariant(post, manifest.configurations));
    grouped.set(post.id, article);
  }
  const articles = [...grouped.values()]
    .map((article) => ({
      ...article,
      variants: article.variants.sort((left, right) => left.language.localeCompare(right.language))
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const envelope = {
    schemaVersion: manifest.schemaVersion,
    commitSha,
    runId,
    runAttempt,
    emittedAt,
    runStatus,
    daysSinceLastCommit,
    deploymentCommitSha,
    themePackage: manifest.themePackage,
    statistics: manifest.statistics ?? { publicViewCounts: false },
    contact: manifest.contact ?? { enabled: false, websiteEnabled: false, phoneEnabled: false },
    ...(floorGuardOverride == null ? {} : { floorGuardOverride }),
    ...(manifest.schemaVersion === 2 ? { prism: {
      mode: manifest.prism.mode,
      configurationLinkPolicy: manifest.prism.configurationLinkPolicy,
      articleModes: manifest.prism.articleModes,
      articleConfigurationLinkPolicies: manifest.prism.articleConfigurationLinkPolicies,
    } } : {}),
    articles
  };
  const validation = validateReconciliationEnvelope(envelope);
  if (!validation.valid) {
    throw new TypeError(`Invalid reconciliation envelope: ${validation.errorIds.join(', ')}`);
  }
  return envelope;
}
