import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ulid } from 'ulid';
import MarkdownIt from 'markdown-it';
import { readPrismRepository, normalizePrismSettings } from './prism-validation.js';

export {
  compileContractSchema,
  reconciliationAjvOptions,
  reconciliationFormatNames,
  validateReconciliationEnvelope
} from './reconciliation-contract.js';

export { PRISM_LITERAL_RISK_V1, analyzePrismLiteralRisk } from './prism-literal-risk.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const RESERVED_SLUGS = new Set([
  'feed', 'rss', 'sitemap', 'tags', 'search', 'about', 'admin',
  'api', 'assets', 'media', 'page', 'deleted'
]);
const SHARE_TARGETS = new Set([
  'x', 'linkedin', 'mastodon', 'bluesky', 'reddit', 'hacker-news', 'whatsapp', 'email'
]);
const SOCIAL_PROFILES = new Set([
  'github', 'x', 'linkedin', 'mastodon', 'bluesky', 'website', 'rss'
]);
const SLUG_GUIDANCE = 'Use only lowercase letters and numbers separated by single hyphens, '
  + 'for example "field-notes".';
const REQUIRED_POST_FIELDS = Object.freeze({
  title: 'Title is missing. Add a non-empty "title" value to the post frontmatter.',
  publishAfterDate: 'Publish date is missing. Add "publishAfterDate" in YYYY-MM-DD format to the post frontmatter.',
  language: 'Language is missing. Add a language such as "en" or "en-US" to the post frontmatter.'
});

function shown(value) {
  return JSON.stringify(value) ?? String(value);
}

export const PublicationState = Object.freeze({
  PUBLISHED: 'published',
  TOMBSTONED: 'tombstoned',
  NOT_EMITTED: 'not-emitted'
});

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalLanguage(value) {
  try {
    return Intl.getCanonicalLocales(nonEmptyString(value, 'defaultLanguage'))[0];
  } catch {
    throw new TypeError('defaultLanguage must be a valid BCP-47 language tag');
  }
}

function requireTimezone(value) {
  const timezone = nonEmptyString(value, 'timezone');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw new TypeError('timezone must be a valid IANA timezone');
  }
  return timezone;
}

function configuredShareTargets(values) {
  if (!Array.isArray(values)) throw new TypeError('shareTargets must be an array');
  const targets = values.map((value) => nonEmptyString(value, 'share target').toLowerCase());
  for (const target of targets) {
    if (!SHARE_TARGETS.has(target)) throw new TypeError(`Unsupported share target: ${target}`);
  }
  return [...new Set(targets)];
}

function configuredSocialProfiles(values) {
  if (!Array.isArray(values)) throw new TypeError('socialProfiles must be an array');
  const profiles = {};
  for (const value of values) {
    const entry = nonEmptyString(value, 'social profile');
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new TypeError('social profile must use <type>=<https-url>');
    const type = entry.slice(0, separator).toLowerCase();
    if (!SOCIAL_PROFILES.has(type)) throw new TypeError(`Unsupported social profile: ${type}`);
    let url;
    try {
      url = new URL(entry.slice(separator + 1));
    } catch {
      throw new TypeError(`Social profile ${type} must be an absolute URL`);
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      throw new TypeError(`Social profile ${type} must use HTTPS without credentials`);
    }
    url.hash = '';
    profiles[type] = url.toString();
  }
  return profiles;
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isLanguageTag(value) {
  if (typeof value !== 'string') return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

export function canonicalizeLanguageTag(value) {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    throw new TypeError('language must be a valid BCP-47 tag');
  }
}

export function parseFrontmatter(source) {
  if (typeof source === 'string' && source.startsWith('\uFEFF')) source = source.slice(1);
  if (typeof source !== 'string') {
    return { data: null, body: source, errors: [
      'Post settings are missing. Start the file with a YAML frontmatter block between two "---" lines.'
    ] };
  }
  const lineEnding = source.startsWith('---\r\n')
    ? '\r\n'
    : source.startsWith('---\n') ? '\n' : null;
  if (lineEnding == null) {
    return { data: null, body: source, errors: [
      'Post settings are missing. Start the file with a YAML frontmatter block between two "---" lines.'
    ] };
  }

  const openingLength = 3 + lineEnding.length;
  const closingMarker = `${lineEnding}---${lineEnding}`;
  const closing = source.indexOf(closingMarker, openingLength);
  if (closing === -1) {
    return { data: null, body: '', errors: [
      'Post settings are not closed. Add a closing "---" line before the article body.'
    ] };
  }

  try {
    const data = parseYaml(source.slice(openingLength, closing));
    if (data == null || Array.isArray(data) || typeof data !== 'object') {
      return { data: null, body: '', errors: [
        'Post settings must use YAML names and values, for example "title: My article".'
      ] };
    }
    return { data, body: source.slice(closing + closingMarker.length), errors: [] };
  } catch (error) {
    return { data: null, body: '', errors: [
      `Post settings contain invalid YAML: ${error.message}. Correct the YAML between the "---" lines.`
    ] };
  }
}

export function validatePost(data, { today }) {
  if (!isCalendarDate(today)) throw new TypeError('today must be a valid YYYY-MM-DD date');
  const errors = [];
  if (data == null || Array.isArray(data) || typeof data !== 'object') {
    return ['post metadata must be a mapping'];
  }

  for (const field of ['title', 'publishAfterDate', 'language']) {
    if (typeof data[field] !== 'string' || data[field].trim() === '') {
      errors.push(REQUIRED_POST_FIELDS[field]);
    }
  }

  if (data.id != null && !isContentId(data.id)) {
    errors.push(`Article ID ${shown(data.id)} is invalid. Keep the 26-character ID created by Gala, or remove "id" and create the post again.`);
  }

  if (data.slug != null) {
    if (typeof data.slug !== 'string' || data.slug.length > 80 || !SLUG_PATTERN.test(data.slug)) {
      errors.push(`Post URL name ${shown(data.slug)} is invalid. ${SLUG_GUIDANCE} Keep it at most 80 characters.`);
    } else if (RESERVED_SLUGS.has(data.slug)) {
      errors.push(`Post URL name ${shown(data.slug)} is reserved for a Gala page. Choose a different slug.`);
    }
  }
  if (data.allowPublishedSlugChange != null
      && typeof data.allowPublishedSlugChange !== 'boolean') {
    errors.push('"allowPublishedSlugChange" must be true or false without quotes.');
  }

  if (data.publishAfterDate != null && !isCalendarDate(data.publishAfterDate)) {
    errors.push(`Publish date ${shown(data.publishAfterDate)} is invalid. Use a real date in YYYY-MM-DD format, for example "2026-08-29".`);
  }
  if (data.createdDate != null && !isCalendarDate(data.createdDate)) {
    errors.push(`Created date ${shown(data.createdDate)} is invalid. Use a real date in YYYY-MM-DD format, for example "2026-08-29".`);
  }
  if (data.deleteDate != null && !isCalendarDate(data.deleteDate)) {
    errors.push(`Delete date ${shown(data.deleteDate)} is invalid. Use a real date in YYYY-MM-DD format, for example "2026-08-29".`);
  }
  if (
    isCalendarDate(data.publishAfterDate) &&
    isCalendarDate(data.deleteDate) &&
    data.deleteDate < data.publishAfterDate
  ) {
    errors.push(`Delete date ${shown(data.deleteDate)} is before publish date ${shown(data.publishAfterDate)}. Move the delete date to the publish date or later.`);
  }

  if (data.language != null && !isLanguageTag(data.language)) {
    errors.push(`Language ${shown(data.language)} is invalid. Use a standard language code such as "en", "fr", or "en-US".`);
  }

  if (data.contentType != null && !['article', 'technical'].includes(data.contentType)) {
    errors.push('"contentType" must be "article" or "technical".');
  }

  if (data.sources != null) {
    if (!Array.isArray(data.sources) || data.sources.length === 0) {
      errors.push('Sources must be a non-empty YAML list of credential-free HTTPS URLs.');
    } else {
      data.sources.forEach((source, index) => {
        try {
          absoluteHttpsUrl(source, `Source ${index + 1}`);
        } catch (error) {
          errors.push(error.message);
        }
      });
    }
  }

  if (data.faq != null) {
    if (!Array.isArray(data.faq) || data.faq.length === 0 || data.faq.length > 20) {
      errors.push('FAQ must be a YAML list containing between 1 and 20 question/answer mappings.');
    } else {
      data.faq.forEach((entry, index) => {
        const unknown = entry != null && !Array.isArray(entry) && typeof entry === 'object'
          ? Object.keys(entry).filter((key) => !['question', 'answer'].includes(key)) : [];
        if (entry == null || Array.isArray(entry) || typeof entry !== 'object' || unknown.length > 0
            || typeof entry.question !== 'string' || entry.question.trim() === ''
            || typeof entry.answer !== 'string' || entry.answer.trim() === ''
            || [...entry.question].length > 300 || [...entry.answer].length > 2000) {
          errors.push(`FAQ entry ${index + 1} must contain only a non-empty question (at most 300 characters) and answer (at most 2000 characters).`);
        }
      });
    }
  }

  if (data.tags != null) {
    if (!Array.isArray(data.tags)) {
      errors.push('Tags must be a YAML list, for example "tags: [field-notes, writing]".');
    } else {
      if (data.tags.length > 8) errors.push(`This post has ${data.tags.length} tags. Keep at most 8 tags.`);
      data.tags.forEach((tag, index) => {
        if (typeof tag !== 'string' || tag.length > 80 || !SLUG_PATTERN.test(tag)) {
          errors.push(`Tag ${index + 1} (${shown(tag)}) is invalid. ${SLUG_GUIDANCE}`);
        } else if (RESERVED_SLUGS.has(tag)) {
          errors.push(`Tag ${index + 1} (${shown(tag)}) is reserved for a Gala page. Choose a different tag.`);
        }
      });
    }
  }

  if (data.editHistory != null) {
    if (!Array.isArray(data.editHistory)) {
      errors.push('Edit history must be a YAML list, with entries such as "2026-08-29 Corrected an example".');
    } else {
      data.editHistory.forEach((entry, index) => {
        const match = typeof entry === 'string' && entry.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
        if (!match || !isCalendarDate(match[1])) {
          errors.push(`Edit history entry ${index + 1} (${shown(entry)}) is invalid. Use "YYYY-MM-DD one-line summary".`);
        } else if (match[1] > today) {
          errors.push(`Edit history entry ${index + 1} is dated ${match[1]}, which is after today (${today}). Use today or an earlier date.`);
        }
      });
    }
  }

  if (data.canonicalUrl != null) {
    try {
      absoluteHttpsUrl(data.canonicalUrl, 'canonicalUrl');
    } catch (error) {
      errors.push(error.message);
    }
  }

  return errors;
}

export function evaluatePublicationState(post, today) {
  if (!isCalendarDate(today)) throw new TypeError('today must be a valid YYYY-MM-DD date');
  if (!isCalendarDate(post?.publishAfterDate)) {
    throw new TypeError('publishAfterDate must be a valid YYYY-MM-DD date');
  }
  if (post.publishAfterDate > today) return PublicationState.NOT_EMITTED;
  if (post.deleteDate != null) {
    if (!isCalendarDate(post.deleteDate)) {
      throw new TypeError('deleteDate must be a valid YYYY-MM-DD date');
    }
    if (post.deleteDate <= today) return PublicationState.TOMBSTONED;
  }
  return PublicationState.PUBLISHED;
}

function absoluteHttpsUrl(value, field) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${field} ${shown(value)} is invalid. Use a complete URL beginning with "https://".`);
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError(`${field} ${shown(value)} is invalid. Use HTTPS and remove any username or password from the URL.`);
  }
  parsed.hash = '';
  return parsed;
}

function canonicalBaseOrigin(value) {
  let supplied;
  try {
    supplied = new URL(value);
  } catch {
    throw new TypeError('canonicalBaseUrl must be an absolute URL');
  }
  const parsed = absoluteHttpsUrl(value, 'canonicalBaseUrl');
  if (parsed.pathname !== '/' || supplied.search !== '' || supplied.hash !== '') {
    throw new TypeError('canonicalBaseUrl must be an origin only; put the URL path in pathPrefix');
  }
  return parsed.origin;
}

export function normalizePathPrefix(value = '/') {
  if (value === '') return '/';
  const segments = pathSegments(value, 'pathPrefix');
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function pathSegments(value, field) {
  if (typeof value !== 'string' || value.includes('?') || value.includes('#')) {
    throw new TypeError(`${field} must be a URL path without query or fragment`);
  }
  const segments = value.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError(`${field} must not contain dot segments`);
  }
  return segments;
}

export function resolveEffectivePost({ data, slug, today, canonicalBaseUrl, pathPrefix = '/' }) {
  if (data == null || Array.isArray(data) || typeof data !== 'object') {
    throw new TypeError('data must be a mapping');
  }
  if (typeof slug !== 'string' || slug.length > 80 || !SLUG_PATTERN.test(slug)) {
    throw new TypeError('slug must be a validated slug');
  }
  const language = canonicalizeLanguageTag(data.language);
  const relativeUrl = `/${encodeURIComponent(language)}/${encodeURIComponent(slug)}/`;
  const base = new URL(canonicalBaseOrigin(canonicalBaseUrl));
  const segments = [
    ...pathSegments(normalizePathPrefix(pathPrefix), 'pathPrefix'),
    ...pathSegments(relativeUrl, 'relativeUrl')
  ].map(encodeURIComponent);
  base.pathname = `/${segments.join('/')}/`;
  base.search = '';
  const pageUrl = base.toString();
  const canonical = data.canonicalUrl == null
    ? pageUrl
    : absoluteHttpsUrl(data.canonicalUrl, 'canonicalUrl').toString();
  return Object.freeze({
    slug,
    language,
    relativeUrl,
    pageUrl,
    canonicalUrl: canonical,
    publicationState: evaluatePublicationState(data, today)
  });
}

export function validatePublicationState(value) {
  if (value == null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('publication state must be a mapping');
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.posts)) {
    throw new TypeError('unsupported publication state schema');
  }
  const seen = new Set();
  const deployedCommitSha = value.deployedCommitSha;
  if (deployedCommitSha != null
      && (typeof deployedCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(deployedCommitSha))) {
    throw new TypeError('publication state deployedCommitSha must be a lowercase commit SHA');
  }
  const hasConfigurations = Object.hasOwn(value, 'configurations');
  const configurations = value.configurations == null ? [] : value.configurations;
  if (!Array.isArray(configurations)) {
    throw new TypeError('publication state configurations must be a list');
  }
  const seenConfigurations = new Set();
  const validatedConfigurations = configurations.map((configuration, index) => {
    if (configuration == null || Array.isArray(configuration) || typeof configuration !== 'object') {
      throw new TypeError(`publication state configurations[${index}] must be a mapping`);
    }
    for (const field of ['configurationId', 'articleId', 'revisionId', 'approvalId']) {
      if (!isContentId(configuration[field])) {
        throw new TypeError(`publication state configurations[${index}].${field} must be a ULID`);
      }
    }
    if (seenConfigurations.has(configuration.configurationId)) {
      throw new TypeError(`publication state configurations[${index}].configurationId must be unique`);
    }
    seenConfigurations.add(configuration.configurationId);
    if (!isLanguageTag(configuration.language)
        || !['SIGNAL', 'BRIEF', 'STANDARD', 'COMPLETE', 'METHODS_REFERENCES'].includes(configuration.depth)
        || !['ORIENTATION', 'STORY', 'PROOF', 'PRACTICE'].includes(configuration.intent)
        || configuration.modality !== 'TEXT'
        || !['PUBLISHED', 'STALE', 'DISABLED', 'REVOKED'].includes(configuration.state)
        || !['NOFOLLOW', 'FOLLOW'].includes(configuration.configurationLinkPolicy)
        || configuration.approvalTokenVersion !== 1
        || !['CURRENT', 'PREVIOUS'].includes(configuration.approvalTokenVerifiedWith)
        || typeof configuration.relativeUrl !== 'string' || !configuration.relativeUrl.startsWith('/')
        || !/^[0-9a-f]{64}$/.test(configuration.sourceRevisionHash)
        || !/^[0-9a-f]{64}$/.test(configuration.configurationContentHash)
        || configuration.hashContract !== 'GALA_PRISM_HASH_V1') {
      throw new TypeError(`publication state configurations[${index}] is invalid`);
    }
    return Object.freeze({ ...configuration, language: canonicalizeLanguageTag(configuration.language) });
  });
  return Object.freeze({
    schemaVersion: 1,
    ...(deployedCommitSha == null ? {} : { deployedCommitSha }),
    posts: Object.freeze(value.posts.map((post, index) => {
      if (post == null || Array.isArray(post) || typeof post !== 'object') {
        throw new TypeError(`publication state posts[${index}] must be a mapping`);
      }
      if (!isContentId(post.id) || seen.has(post.id)) {
        throw new TypeError(`publication state posts[${index}].id must be a unique ULID`);
      }
      seen.add(post.id);
      if (typeof post.slug !== 'string' || post.slug.length > 80 || !SLUG_PATTERN.test(post.slug)
          || RESERVED_SLUGS.has(post.slug)) {
        throw new TypeError(`publication state posts[${index}].slug is invalid`);
      }
      if (post.languages == null || Array.isArray(post.languages)
          || typeof post.languages !== 'object' || Object.keys(post.languages).length === 0) {
        throw new TypeError(`publication state posts[${index}].languages must be a non-empty mapping`);
      }
      const languages = Object.entries(post.languages).map(([language, state]) => {
        const canonical = canonicalizeLanguageTag(language);
        if (state == null || Array.isArray(state) || typeof state !== 'object'
            || !isCalendarDate(state.firstPublishedOn)) {
          throw new TypeError(
            `publication state posts[${index}].languages.${canonical}.firstPublishedOn must be a calendar date`
          );
        }
        return [canonical, Object.freeze({ firstPublishedOn: state.firstPublishedOn })];
      });
      if (new Set(languages.map(([language]) => language.toLowerCase())).size !== languages.length) {
        throw new TypeError(`publication state posts[${index}].languages must be unique`);
      }
      languages.sort(([left], [right]) => left.localeCompare(right));
      return Object.freeze({
        id: post.id,
        slug: post.slug,
        languages: Object.freeze(Object.fromEntries(languages))
      });
    })),
    ...(hasConfigurations ? { configurations: Object.freeze(validatedConfigurations.sort((left, right) =>
      left.configurationId.localeCompare(right.configurationId))) } : {})
  });
}

export function isContentId(value) {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

export function findDuplicateVariants(posts) {
  const occurrences = new Map();
  posts.forEach((post, index) => {
    if (typeof post.slug !== 'string' || !isLanguageTag(post.language)) return;
    const key = `${post.slug}\u0000${canonicalizeLanguageTag(post.language)}`;
    occurrences.set(key, [...(occurrences.get(key) ?? []), index]);
  });
  return [...occurrences.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([key, indexes]) => {
      const [slug, language] = key.split('\u0000');
      return { slug, language, indexes };
    });
}

export function resolveFolderSlugs(posts) {
  if (!Array.isArray(posts)) throw new TypeError('posts must be a list');
  const slugs = Array(posts.length).fill(null);
  const errors = Array.from({ length: posts.length }, () => []);
  const folders = new Map();

  posts.forEach((post, index) => {
    if (post == null || Array.isArray(post) || typeof post !== 'object') {
      throw new TypeError(`posts[${index}] must be a mapping`);
    }
    if (typeof post.folder !== 'string' || post.folder === '') {
      throw new TypeError(`posts[${index}].folder is required`);
    }
    if (typeof post.folderName !== 'string' || post.folderName === '') {
      throw new TypeError(`posts[${index}].folderName is required`);
    }
    const group = folders.get(post.folder) ?? {
      folderName: post.folderName,
      indexes: [],
      explicitSlugs: new Set()
    };
    if (group.folderName !== post.folderName) {
      throw new TypeError(`posts in folder ${post.folder} disagree on folderName`);
    }
    group.indexes.push(index);
    if (typeof post.slug === 'string') group.explicitSlugs.add(post.slug);
    folders.set(post.folder, group);
  });

  for (const group of folders.values()) {
    const folderErrors = [];
    if (group.folderName.length > 80 || !SLUG_PATTERN.test(group.folderName)) {
      folderErrors.push(
        `Post folder ${shown(group.folderName)} is invalid. ${SLUG_GUIDANCE} ` +
        'Keep it at most 80 characters.'
      );
    } else if (RESERVED_SLUGS.has(group.folderName)) {
      folderErrors.push(`Post folder ${shown(group.folderName)} is reserved for a Gala page. Rename the folder.`);
    }
    if (group.explicitSlugs.size > 1) {
      folderErrors.push('Language versions in this post folder use different slugs. Keep one slug for every language version.');
    } else if (group.explicitSlugs.size === 1) {
      const explicitSlug = group.explicitSlugs.values().next().value;
      if (explicitSlug.length > 80 || !SLUG_PATTERN.test(explicitSlug)) {
        folderErrors.push(
          `Explicit slug ${shown(explicitSlug)} is invalid. ${SLUG_GUIDANCE} Keep it at most 80 characters.`
        );
      } else if (RESERVED_SLUGS.has(explicitSlug)) {
        folderErrors.push(`Explicit slug ${shown(explicitSlug)} is reserved for a Gala page. Choose a different slug.`);
      }
    }

    if (folderErrors.length === 0) {
      const slug = group.explicitSlugs.size === 1
        ? group.explicitSlugs.values().next().value
        : group.folderName;
      group.indexes.forEach((index) => {
        slugs[index] = slug;
      });
    } else {
      group.indexes.forEach((index) => {
        errors[index].push(...folderErrors);
      });
    }
  }

  return { slugs, errors };
}

export function findArticleIdentityConflicts(posts) {
  if (!Array.isArray(posts)) throw new TypeError('posts must be a list');
  const folders = new Map();
  const identities = new Map();

  posts.forEach((post, index) => {
    if (post == null || Array.isArray(post) || typeof post !== 'object') return;
    if (typeof post.folder !== 'string' || post.folder === '' || !isContentId(post.id)) return;
    const folder = folders.get(post.folder) ?? { ids: new Set(), indexes: [] };
    folder.ids.add(post.id);
    folder.indexes.push(index);
    folders.set(post.folder, folder);

    const identity = identities.get(post.id) ?? { folders: new Set(), indexes: [] };
    identity.folders.add(post.folder);
    identity.indexes.push(index);
    identities.set(post.id, identity);
  });

  const conflicts = [];
  for (const [folder, group] of folders) {
    if (group.ids.size > 1) {
      conflicts.push({ type: 'folder', value: folder, indexes: [...group.indexes] });
    }
  }
  for (const [id, group] of identities) {
    if (group.folders.size > 1) {
      conflicts.push({ type: 'identity', value: id, indexes: [...group.indexes] });
    }
  }
  return conflicts;
}

export function slugifyTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new TypeError('title is required');
  }

  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-$/g, '');

  if (!slug) throw new TypeError('title must contain a Latin letter or digit');
  if (RESERVED_SLUGS.has(slug)) throw new TypeError(`derived slug is reserved: ${slug}`);
  return slug;
}

export function createPostMetadata({ title, language, today, timestamp = Date.parse(`${today}T00:00:00Z`) }) {
  if (!isCalendarDate(today)) throw new TypeError('today must be a valid YYYY-MM-DD date');
  const metadata = {
    id: createContentId(timestamp),
    title,
    publishAfterDate: today,
    language: canonicalizeLanguageTag(language)
  };
  const errors = validatePost(metadata, { today });
  if (errors.length > 0) throw new TypeError(errors.join('; '));
  return metadata;
}

export function createContentId(timestamp) {
  const value = timestamp == null ? ulid() : ulid(timestamp);
  if (!isContentId(value)) throw new TypeError('ULID generator returned a non-canonical identifier');
  return value;
}

export function normalizeSiteConfigurationOptions(options) {
  if (options == null || Array.isArray(options) || typeof options !== 'object') {
    throw new TypeError('site configuration options must be a mapping');
  }
  const normalized = {};
  for (const [name, value] of Object.entries(options)) {
    if (name === 'siteName') normalized.siteName = nonEmptyString(value, 'siteName');
    else if (name === 'siteAuthor') normalized.siteAuthor = nonEmptyString(value, 'siteAuthor');
    else if (name === 'defaultLanguage') normalized.defaultLanguage = canonicalLanguage(value);
    else if (name === 'timezone') normalized.timezone = requireTimezone(value);
    else if (name === 'shareTargets') normalized.shareTargets = configuredShareTargets(value);
    else if (name === 'socialProfiles') normalized.socialProfiles = configuredSocialProfiles(value);
    else throw new TypeError(`Unsupported site configuration option: ${name}`);
  }
  return normalized;
}

export const BUILD_MANIFEST_PATH = path.join('.gala', 'build', 'validated-posts.json');
export const PUBLICATION_STATE_PATH = path.join('.gala', 'publication-state.yml');
const THEME_PACKAGE_NAME = '@rathnasgala/theme';
const EXACT_SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PREVIEW_PUBLICATION_STATE_THEME_VERSION = Object.freeze([2, 0, 15]);
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function themeSupportsPreviewPublicationState(version) {
  const [withoutBuildMetadata] = version.split('+', 1);
  const [core, prerelease] = withoutBuildMetadata.split('-', 2);
  const parts = core.split('.').map(Number);
  for (let index = 0; index < PREVIEW_PUBLICATION_STATE_THEME_VERSION.length; index += 1) {
    if (parts[index] !== PREVIEW_PUBLICATION_STATE_THEME_VERSION[index]) {
      return parts[index] > PREVIEW_PUBLICATION_STATE_THEME_VERSION[index];
    }
  }
  return prerelease == null;
}

function deterministicPreviewContentId(source) {
  let value = BigInt(`0x${createHash('sha256').update(`gala-preview:${source}`).digest('hex')}`)
    & ((1n << 125n) - 1n);
  let suffix = '';
  for (let index = 0; index < 25; index += 1) {
    suffix = CROCKFORD_BASE32[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return `0${suffix}`;
}

async function regularYaml(root, relativePath, description) {
  const file = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TypeError(`${description} path must stay within the repository`);
  }
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError(`${description} must be a regular file`);
  }
  try {
    return parseYaml(await readFile(file, 'utf8'));
  } catch (error) {
    throw new TypeError(`Invalid ${description}: ${error.message}`);
  }
}

async function validatedThemeConfiguration(root, config) {
  const identity = config?.framework?.themePackage;
  if (identity?.name !== THEME_PACKAGE_NAME || !EXACT_SEMVER.test(identity?.version ?? '')) {
    throw new TypeError(
      `site configuration framework.themePackage must pin ${THEME_PACKAGE_NAME} at an exact semantic version`
    );
  }
  const manifestPath = path.resolve(root, '.gala', 'managed-files.json');
  const relative = path.relative(path.resolve(root), manifestPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TypeError('managed-file manifest path must stay within the repository');
  }
  const metadata = await lstat(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError('managed-file manifest must be a regular file');
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new TypeError(`Invalid managed-file manifest: ${error.message}`);
  }
  const artifact = manifest?.themePackage;
  if (artifact?.name !== identity.name || artifact?.version !== identity.version) {
    throw new TypeError(
      'framework.themePackage pin does not match the installed managed-file manifest; run gala doctor'
    );
  }
  if (!Array.isArray(artifact.availableDesignThemes)
      || !artifact.availableDesignThemes.includes(config?.design?.theme)) {
    throw new TypeError(
      `design.theme ${String(config?.design?.theme)} is unavailable in ${identity.name}@${identity.version}`
    );
  }
  return identity;
}

export async function repositoryEvaluationDate({
  root,
  now = Date.now,
  configPath = 'site.config.yml',
  timezone
}) {
  const config = await regularYaml(root, configPath, 'site configuration');
  if (config?.schemaVersion !== 1 || config.site == null || Array.isArray(config.site)) {
    throw new TypeError('Unsupported site configuration schema');
  }
  await validatedThemeConfiguration(root, config);
  const selectedTimezone = normalizeSiteConfigurationOptions({
    timezone: timezone ?? config.site.timezone
  }).timezone;
  const instant = now();
  if (typeof instant !== 'number' || !Number.isFinite(instant)) {
    throw new TypeError('Clock must return epoch milliseconds');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: selectedTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function markdownPostFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'prism' ? [] : markdownPostFiles(entryPath);
    return entry.isFile() && /^index\.[^.]+\.md$/.test(entry.name) ? [entryPath] : [];
  }));
  return nested.flat();
}

export function normalizeTypography(source) {
  return String(source).replaceAll('\u2014', '-');
}

async function persistNormalizedTypography(root) {
  const files = await markdownPostFiles(path.join(root, 'content', 'posts'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const normalized = normalizeTypography(source);
    if (normalized === source) continue;
    const temporary = `${file}.gala-typography-${process.pid}`;
    try {
      await writeFile(temporary, normalized, { flag: 'wx' });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

async function replaceWithId(file, source, id) {
  const opening = source.match(/^(\uFEFF?---)(\r?\n)/);
  if (opening == null) throw new TypeError(`Cannot insert id into malformed frontmatter: ${file}`);
  const replacement = `${opening[1]}${opening[2]}id: ${id}${opening[2]}`
    + source.slice(opening[0].length);
  const temporary = `${file}.gala-id-${process.pid}`;
  try {
    await writeFile(temporary, replacement, { flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function assignMissingContentIds(root, { idFactory = createContentId } = {}) {
  const postsRoot = path.join(root, 'content', 'posts');
  const files = (await markdownPostFiles(postsRoot)).filter((file) => {
    const segments = path.relative(postsRoot, file).split(path.sep);
    return segments.length === 2;
  });
  const folders = new Map();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const parsed = parseFrontmatter(source);
    const folder = path.dirname(file);
    folders.set(folder, [...folders.get(folder) ?? [], { file, source, parsed }]);
  }
  const assigned = [];
  for (const variants of folders.values()) {
    const parseable = variants.filter(({ parsed }) => parsed.errors.length === 0);
    const declared = new Set(parseable.map(({ parsed }) => parsed.data.id).filter((id) => id != null));
    if (declared.size > 1 || [...declared].some((id) => !isContentId(id))) continue;
    const id = declared.size === 1 ? declared.values().next().value : idFactory();
    if (!isContentId(id)) throw new TypeError('idFactory must return a canonical ULID');
    for (const variant of parseable.filter(({ parsed }) => parsed.data.id == null)) {
      await replaceWithId(variant.file, variant.source, id);
      assigned.push({ file: variant.file, id });
    }
  }
  return assigned;
}

export async function readPublicationState(root, { allowMissing = false } = {}) {
  try {
    return validatePublicationState(await regularYaml(root, PUBLICATION_STATE_PATH, 'publication state'));
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return { schemaVersion: 1, posts: [] };
    if (error.code === 'ENOENT') throw error;
    throw new TypeError(`Invalid publication state: ${error.message}`);
  }
}

function requireCalendarDate(value, field) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a valid YYYY-MM-DD date`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1
      || parsed.getUTCDate() !== day) {
    throw new TypeError(`${field} must be a valid YYYY-MM-DD date`);
  }
}

export function derivePublicationState({ current, manifest, deployedOn, deployedCommitSha }) {
  if (manifest == null || ![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.posts)) {
    throw new TypeError('A current validated build manifest is required');
  }
  requireCalendarDate(deployedOn, 'deployedOn');
  if (typeof deployedCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(deployedCommitSha)) {
    throw new TypeError('deployedCommitSha must be a lowercase commit SHA');
  }
  const validatedCurrent = validatePublicationState(current ?? { schemaVersion: 1, posts: [] });
  const byId = new Map(validatedCurrent.posts.map((post) => [post.id, { ...post }]));
  const deployed = new Map();
  for (const post of manifest.posts) {
    if (post.publicationState !== PublicationState.PUBLISHED) continue;
    if (typeof post.id !== 'string') {
      throw new TypeError(`Published post is missing a stable ULID: ${post.source}`);
    }
    const entry = deployed.get(post.id) ?? { slug: post.slug, languages: new Set() };
    if (entry.slug !== post.slug) {
      throw new TypeError(`Published variants disagree on slug for ${post.id}`);
    }
    entry.languages.add(post.language);
    deployed.set(post.id, entry);
  }
  for (const [id, entry] of deployed) {
    const previous = byId.get(id);
    const languages = { ...(previous?.languages ?? {}) };
    for (const language of [...entry.languages].sort()) {
      languages[language] ??= { firstPublishedOn: deployedOn };
    }
    byId.set(id, { id, slug: entry.slug, languages });
  }
  return validatePublicationState({
    schemaVersion: 1,
    deployedCommitSha,
    posts: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    configurations: manifest.schemaVersion === 2
      ? (manifest.configurations ?? []).map((configuration) => ({
          configurationId: configuration.configurationId,
          articleId: configuration.articleId,
          language: configuration.language,
          revisionId: configuration.revisionId,
          approvalId: configuration.approvalId,
          approvalTokenVersion: configuration.approvalTokenVersion,
          approvalTokenVerifiedWith: configuration.approvalTokenVerifiedWith,
          sourceRevisionHash: configuration.sourceRevisionHash,
          configurationContentHash: configuration.configurationContentHash,
          hashContract: configuration.hashContract,
          depth: configuration.depth,
          intent: configuration.intent,
          modality: configuration.modality,
          state: configuration.state,
          relativeUrl: configuration.relativeUrl,
          configurationLinkPolicy: configuration.configurationLinkPolicy
        }))
      : validatedCurrent.configurations ?? []
  });
}

export async function writePublicationState(root, state, {
  relativePath = PUBLICATION_STATE_PATH
} = {}) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new TypeError('Publication state path must stay within the repository');
  }
  const validated = validatePublicationState(state);
  const statePath = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), statePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TypeError('Publication state path must be a repository child');
  }
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.tmp-${process.pid}`;
  const backup = `${statePath}.backup-${process.pid}`;
  let backedUp = false;
  try {
    await writeFile(temporary, stringifyYaml(validated), { flag: 'wx' });
    try {
      await rename(statePath, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await rename(temporary, statePath);
    } catch (error) {
      if (backedUp) await rename(backup, statePath);
      throw error;
    }
    if (backedUp) await rm(backup);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return validated;
}

export async function recordSuccessfulDeployment({ root, manifest, deployedOn, deployedCommitSha }) {
  const current = await readPublicationState(root, { allowMissing: true });
  const next = derivePublicationState({ current, manifest, deployedOn, deployedCommitSha });
  return writePublicationState(root, next);
}

const mediaMarkdown = new MarkdownIt({ html: true, linkify: false, typographer: false });

function parsedMedia(data, body) {
  const references = [];
  const errors = [];
  if (typeof data?.coverImage === 'string'
      && !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(data.coverImage)) {
    references.push(data.coverImage);
  }
  for (const token of mediaMarkdown.parse(body, {})) {
    const candidates = token.children == null ? [token] : [token, ...token.children];
    for (const candidate of candidates) {
      if ((candidate.type === 'html_block' || candidate.type === 'html_inline')
          && /<(?:img|audio|video|source|picture)\b/i.test(candidate.content)) {
        errors.push('An image, audio, or video uses raw HTML. Use Markdown image syntax such as "![Description](media/photo.jpg)".');
      }
      if (candidate.type === 'image') references.push(candidate.attrGet('src'));
    }
  }
  return {
    errors,
    references: references.filter((reference) => !/^(?:https:|mailto:|\/)/i.test(reference))
  };
}

async function validateMedia(file, data, body) {
  const postDirectory = path.dirname(file);
  const realPostDirectory = await realpath(postDirectory);
  const parsed = parsedMedia(data, body);
  const errors = [...parsed.errors];
  const media = [];
  if (data?.coverImage != null && (
    typeof data.coverImage !== 'string'
    || data.coverImage.trim() === ''
    || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(data.coverImage)
    || data.coverImage.includes('\\')
  )) {
    errors.push(`Cover image ${shown(data.coverImage)} is invalid. Use a file path inside this post folder, for example "media/cover.jpg".`);
  }
  for (const reference of new Set(parsed.references)) {
    const resolved = path.resolve(postDirectory, reference);
    const relative = path.relative(postDirectory, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      errors.push(`Media file ${shown(reference)} points outside this post folder. Move the file into the post folder and update the Markdown path.`);
      continue;
    }
    try {
      const realTarget = await realpath(resolved);
      const realRelative = path.relative(realPostDirectory, realTarget);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        errors.push(`Media file ${shown(reference)} resolves outside this post folder. Use a regular file stored inside the post folder.`);
        continue;
      }
      if (!(await stat(realTarget)).isFile()) {
        errors.push(`Media path ${shown(reference)} is not a file. Point it to an image, audio, or video file inside this post folder.`);
      } else {
        media.push({ reference, realTarget });
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        errors.push(`Media file ${shown(reference)} is missing. Upload it into this post folder or remove the Markdown reference.`);
      } else if (error.code === 'ELOOP') {
        errors.push(`Media file ${shown(reference)} points through a broken link. Replace it with a regular file inside this post folder.`);
      } else throw error;
    }
  }
  return { errors, media };
}

function validatePostLocation(postsRoot, file, data) {
  const relative = path.relative(postsRoot, file);
  const segments = relative.split(path.sep);
  const filename = segments.at(-1) ?? '';
  const filenameLanguage = filename.match(/^index\.([^.]+)\.md$/)?.[1];
  const errors = [];
  if (segments.length !== 2 || filenameLanguage == null) {
    errors.push('This post is in the wrong location. Store it as "content/posts/<post-folder>/index.<language>.md", for example "content/posts/field-notes/index.en.md".');
  }
  if (filenameLanguage == null) return errors;
  if (!isLanguageTag(filenameLanguage)) {
    errors.push(`Filename language ${shown(filenameLanguage)} is invalid. Use a standard language code such as "en", "fr", or "en-US".`);
  } else if (isLanguageTag(data?.language)
      && canonicalizeLanguageTag(filenameLanguage) !== canonicalizeLanguageTag(data.language)) {
    errors.push(
      `Filename language ${shown(filenameLanguage)} does not match the post language ${shown(data.language)}. Make both language codes the same.`
    );
  }
  return errors;
}

export async function validateContent({ root, today, now, configPath, timezone }) {
  const evaluationDate = today ?? await repositoryEvaluationDate({ root, now, configPath, timezone });
  const postsRoot = path.join(root, 'content', 'posts');
  const files = await markdownPostFiles(postsRoot);
  const results = await Promise.all(files.map(async (file) => {
    const parsed = parseFrontmatter(normalizeTypography(await readFile(file, 'utf8')));
    const errors = validatePostLocation(postsRoot, file, parsed.data);
    let media = [];
    if (parsed.errors.length === 0) {
      const mediaValidation = await validateMedia(file, parsed.data, parsed.body);
      errors.push(
        ...validatePost(parsed.data, { today: evaluationDate }),
        ...mediaValidation.errors
      );
      media = mediaValidation.media;
    } else {
      errors.push(...parsed.errors);
    }
    const warnings = [];
    if (parsed.errors.length === 0
        && (typeof parsed.data.description !== 'string' || parsed.data.description.trim() === '')) {
      warnings.push('Summary is missing. Gala will use the first 160 characters of the article in search and link previews. Add "description" to control that text.');
    }
    if (parsed.errors.length === 0 && !/^>\s*\[!ANSWER]/m.test(parsed.body)) {
      warnings.push('Direct answer block is missing. Add a short `> [!ANSWER]` block near the beginning when the article answers a specific question.');
    }
    return { file, data: parsed.data, body: parsed.body, media, errors, warnings };
  }));
  const metadata = results.map(({ file, data }) => ({
    ...(data ?? {}), folder: path.dirname(file), folderName: path.basename(path.dirname(file))
  }));
  const folderSlugs = resolveFolderSlugs(metadata);
  folderSlugs.errors.forEach((errors, index) => results[index].errors.push(...errors));
  const resolved = metadata.map((value, index) => ({ ...value, slug: folderSlugs.slugs[index] }));
  results.forEach((result, index) => { result.effectiveSlug = folderSlugs.slugs[index]; });
  for (const duplicate of findDuplicateVariants(resolved)) {
    for (const index of duplicate.indexes) {
      results[index].errors.push(`Another post already uses URL name ${shown(duplicate.slug)} for language ${shown(duplicate.language)}. Give one of them a different slug or folder name.`);
    }
  }
  for (const conflict of findArticleIdentityConflicts(metadata)) {
    const message = conflict.type === 'folder'
      ? 'Language versions in one post folder have different article IDs. Keep the same "id" in every language file.'
      : `Article ID ${shown(conflict.value)} is also used in another post folder. Give each article its own ID.`;
    for (const index of conflict.indexes) results[index].errors.push(message);
  }
  return results;
}

function siteLocation(config) {
  if (config == null || Array.isArray(config) || typeof config !== 'object'
      || config.schemaVersion !== 1 || config.hosting == null) {
    throw new TypeError('Unsupported site.config.yml schema');
  }
  if (config.hosting.canonicalPolicy !== 'self') {
    throw new TypeError('hosting.canonicalPolicy must be self in v1');
  }
  return {
    canonicalBaseUrl: canonicalBaseOrigin(config.hosting.canonicalBaseUrl),
    pathPrefix: normalizePathPrefix(config.hosting.pathPrefix ?? '/')
  };
}

function siteStatistics(config) {
  const statistics = config.statistics ?? { publicViewCounts: false };
  if (statistics == null || Array.isArray(statistics) || typeof statistics !== 'object') {
    throw new TypeError('statistics must be a mapping');
  }
  const unknown = Object.keys(statistics).filter((key) => key !== 'publicViewCounts');
  if (unknown.length > 0) {
    throw new TypeError(`Unsupported statistics option: ${unknown.join(', ')}`);
  }
  if (statistics.publicViewCounts != null && typeof statistics.publicViewCounts !== 'boolean') {
    throw new TypeError('statistics.publicViewCounts must be a boolean');
  }
  return Object.freeze({ publicViewCounts: statistics.publicViewCounts === true });
}

const CONTACT_KEYS = Object.freeze([
  'enabled', 'websiteEnabled', 'phoneEnabled'
]);

export function normalizeContactConfiguration(value) {
  if (value == null) {
    return Object.freeze({ enabled: false, websiteEnabled: false, phoneEnabled: false });
  }
  if (Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('contact must be a mapping');
  }
  const unknown = Object.keys(value).filter((key) => !CONTACT_KEYS.includes(key));
  if (unknown.length > 0) throw new TypeError(`Unsupported contact option: ${unknown.join(', ')}`);
  for (const field of ['enabled', 'websiteEnabled', 'phoneEnabled']) {
    if (value[field] != null && typeof value[field] !== 'boolean') {
      throw new TypeError(`contact.${field} must be a boolean`);
    }
  }
  return Object.freeze({
    enabled: value.enabled === true,
    websiteEnabled: value.websiteEnabled === true,
    phoneEnabled: value.phoneEnabled === true
  });
}

export async function regenerateBuildManifest({
  root,
  today,
  now,
  idFactory,
  preview = false,
  configPath = 'site.config.yml',
  timezone,
  siteId = null,
  currentSiteSecret = null,
  previousSiteSecret = null
}) {
  if (typeof preview !== 'boolean') throw new TypeError('preview must be true or false');
  const siteRoot = path.resolve(root);
  const realSiteRoot = await realpath(siteRoot);
  const manifestPath = path.join(siteRoot, BUILD_MANIFEST_PATH);
  await rm(manifestPath, { force: true });
  // Preview is observational: opening a local server must never edit an author's repository. IDs
  // become durable only on publish, after the CLI has incorporated the remote branch.
  if (!preview) await persistNormalizedTypography(siteRoot);
  const assigned = preview ? [] : await assignMissingContentIds(siteRoot, { idFactory });
  const evaluationDate = today ?? await repositoryEvaluationDate({
    root: siteRoot, now, configPath, timezone
  });
  const results = await validateContent({
    root: siteRoot, today: evaluationDate, configPath, timezone
  });
  const validFiles = new Set(results.filter(({ errors }) => errors.length === 0).map(({ file }) => file));
  const assignedContentIds = await Promise.all(assigned
    .filter(({ file }) => validFiles.has(file))
    .map(async ({ file, id }) => {
      const source = path.relative(siteRoot, file);
      if (source.startsWith('..') || path.isAbsolute(source)) {
        throw new TypeError(`Assigned post escapes the site root: ${file}`);
      }
      return {
        source: source.split(path.sep).join('/'),
        id,
        fileHash: createHash('sha256').update(await readFile(file)).digest('hex')
      };
    }));
  assignedContentIds.sort((left, right) => left.source.localeCompare(right.source));
  const publicationState = await readPublicationState(siteRoot, { allowMissing: true });
  const publishedById = new Map(publicationState.posts.map((post) => [post.id, post]));
  const overrideFolders = new Set(results
    .filter(({ data }) => data?.allowPublishedSlugChange === true)
    .map(({ file }) => path.dirname(file)));
  for (const result of results) {
    const previous = publishedById.get(result.data?.id);
    if (previous != null && result.effectiveSlug != null && result.effectiveSlug !== previous.slug) {
      if (overrideFolders.has(path.dirname(result.file))) {
        result.warnings.push(`The published URL changed from ${shown(previous.slug)} to ${shown(result.effectiveSlug)}. Gala can provide only a page redirect on static hosting, so search ranking may be reduced.`);
      } else {
        result.errors.push(`The published URL would change from ${shown(previous.slug)} to ${shown(result.effectiveSlug)}. Set "slug: ${previous.slug}" to keep the existing URL, or explicitly allow the change.`);
      }
    }
  }
  const siteConfig = await regularYaml(siteRoot, configPath, 'site configuration');
  const themePackage = await validatedThemeConfiguration(siteRoot, siteConfig);
  const legacyPreviewManifest = preview
    && !themeSupportsPreviewPublicationState(themePackage.version);
  const location = siteLocation(siteConfig);
  const statistics = siteStatistics(siteConfig);
  const contact = normalizeContactConfiguration(siteConfig.contact);
  const posts = [];
  const canonicalPostSources = new Set();
  for (const result of results) {
    if (result.errors.length > 0) continue;
    const effective = resolveEffectivePost({
      data: result.data, slug: result.effectiveSlug, today: evaluationDate, ...location
    });
    if (!preview && effective.publicationState === PublicationState.NOT_EMITTED) continue;
    const previous = publishedById.get(result.data.id);
    if (effective.publicationState === PublicationState.TOMBSTONED
        && !Object.hasOwn(previous?.languages ?? {}, effective.language)) continue;
    const source = path.relative(siteRoot, result.file);
    if (source.startsWith('..') || path.isAbsolute(source)) {
      throw new TypeError(`Validated post escapes the site root: ${result.file}`);
    }
    const publicationStateForManifest = legacyPreviewManifest
      && effective.publicationState === PublicationState.NOT_EMITTED
      ? PublicationState.PUBLISHED
      : effective.publicationState;
    if (effective.publicationState === PublicationState.PUBLISHED) {
      canonicalPostSources.add(source.split(path.sep).join('/'));
    }
    posts.push({
      source: source.split(path.sep).join('/'),
      id: result.data.id ?? (legacyPreviewManifest ? deterministicPreviewContentId(source) : null),
      rawFrontmatter: { ...result.data },
      frontmatter: { ...result.data, slug: effective.slug, language: effective.language, canonicalUrl: effective.canonicalUrl },
      contentBody: result.body,
      body: effective.publicationState === PublicationState.TOMBSTONED ? null : result.body,
      slug: effective.slug,
      language: effective.language,
      relativeUrl: effective.relativeUrl,
      pageUrl: effective.pageUrl,
      canonicalUrl: effective.canonicalUrl,
      media: result.media.map(({ reference, realTarget }) => {
        const mediaSource = path.relative(realSiteRoot, realTarget);
        if (mediaSource.startsWith('..') || path.isAbsolute(mediaSource)) {
          throw new TypeError(`Validated media escapes the site root: ${realTarget}`);
        }
        return {
          source: mediaSource.split(path.sep).join('/'),
          output: path.posix.join(effective.relativeUrl.slice(1), reference)
        };
      }).sort((left, right) => left.output.localeCompare(right.output)),
      publicationState: publicationStateForManifest
    });
  }
  posts.sort((left, right) => left.source.localeCompare(right.source));
  const emittedBySource = new Map(posts.map((post) => [post.source, post]));
  const redirects = [];
  for (const result of results) {
    const previous = publishedById.get(result.data?.id);
    const source = path.relative(siteRoot, result.file).split(path.sep).join('/');
    const emitted = emittedBySource.get(source);
    if (emitted == null || previous == null || emitted.slug === previous.slug
        || !overrideFolders.has(path.dirname(result.file))) continue;
    const oldLocation = resolveEffectivePost({
      data: result.data, slug: previous.slug, today: evaluationDate, ...location
    });
    redirects.push({
      id: emitted.id,
      language: emitted.language,
      relativeUrl: oldLocation.relativeUrl,
      pageUrl: oldLocation.pageUrl,
      targetUrl: emitted.pageUrl
    });
  }
  redirects.sort((left, right) => left.relativeUrl.localeCompare(right.relativeUrl));
  const knownArticleIds = new Set([
    ...results.map((result) => result.data?.id).filter(Boolean),
    ...publicationState.posts.map((post) => post.id)
  ]);
  const prism = normalizePrismSettings(siteConfig.prism, knownArticleIds);
  let configurations;
  if (prism != null) {
    if (!ULID_PATTERN.test(siteId ?? '')) throw new TypeError('siteId is required for Prism manifest V2');
    for (const post of posts) {
      post.prismMode = prism.mode === 'OFF' ? 'OFF' : (prism.articleModes[post.id] ?? prism.mode);
      post.prismConfigurationLinkPolicy = prism.articleConfigurationLinkPolicies[post.id]
        ?? prism.configurationLinkPolicy;
    }
    configurations = await readPrismRepository({
      root: siteRoot,
      siteId,
      canonicalPosts: posts.filter((post) => canonicalPostSources.has(post.source)),
      currentSiteSecret: currentSiteSecret ?? Buffer.alloc(0),
      previousSiteSecret
    });
    configurations = configurations.map((configuration) => {
      const parent = posts.find((post) => post.source === configuration.parentSource);
      if (parent == null) throw new TypeError(`Prism parent is not emitted: ${configuration.configurationId}`);
      const enabled = ['MANUAL', 'ASSISTED'].includes(parent.prismMode);
      const relativeUrl = `${parent.relativeUrl}prism/${configuration.configurationId}/`;
      return {
        ...configuration,
        state: enabled ? configuration.state : 'DISABLED',
        ...(enabled && configuration.state === 'PUBLISHED'
          ? { body: configuration.markdown }
          : {}),
        markdown: undefined,
        relativeUrl,
        pageUrl: new URL(`prism/${configuration.configurationId}/`, parent.pageUrl).href,
        canonicalUrl: parent.canonicalUrl,
        configurationLinkPolicy: parent.prismConfigurationLinkPolicy
      };
    });
    const currentIds = new Set(configurations.map(({ configurationId }) => configurationId));
    for (const previous of publicationState.configurations ?? []) {
      if (currentIds.has(previous.configurationId)) continue;
      const parent = posts.find((post) => post.id === previous.articleId
        && post.language === previous.language);
      if (parent == null || parent.publicationState !== PublicationState.PUBLISHED) continue;
      configurations.push({
        ...previous,
        state: 'REVOKED',
        pageUrl: new URL(`prism/${previous.configurationId}/`, parent.pageUrl).href,
        canonicalUrl: parent.canonicalUrl,
        relativeUrl: `${parent.relativeUrl}prism/${previous.configurationId}/`,
        configurationLinkPolicy: parent.prismConfigurationLinkPolicy
      });
    }
    configurations.sort((left, right) => left.configurationId.localeCompare(right.configurationId));
  }
  const manifest = {
    schemaVersion: prism == null ? 1 : 2,
    ...(preview ? { preview: true } : {}),
    evaluationDate,
    themePackage: { ...themePackage },
    statistics,
    contact,
    assignedContentIds,
    posts,
    redirects,
    ...(prism == null ? {} : { prism, configurations })
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const temporary = `${manifestPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, manifestPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { results, manifest, manifestPath };
}
