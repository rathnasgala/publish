import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ulid } from 'ulid';

export {
  compileContractSchema,
  reconciliationAjvOptions,
  reconciliationFormatNames,
  validateReconciliationEnvelope
} from './reconciliation-contract.js';

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
    return { data: null, body: source, errors: ['frontmatter block is required'] };
  }
  const lineEnding = source.startsWith('---\r\n')
    ? '\r\n'
    : source.startsWith('---\n') ? '\n' : null;
  if (lineEnding == null) {
    return { data: null, body: source, errors: ['frontmatter block is required'] };
  }

  const openingLength = 3 + lineEnding.length;
  const closingMarker = `${lineEnding}---${lineEnding}`;
  const closing = source.indexOf(closingMarker, openingLength);
  if (closing === -1) {
    return { data: null, body: '', errors: ['frontmatter block is not closed'] };
  }

  try {
    const data = parseYaml(source.slice(openingLength, closing));
    if (data == null || Array.isArray(data) || typeof data !== 'object') {
      return { data: null, body: '', errors: ['frontmatter must be a mapping'] };
    }
    return { data, body: source.slice(closing + closingMarker.length), errors: [] };
  } catch (error) {
    return { data: null, body: '', errors: [`malformed frontmatter: ${error.message}`] };
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
      errors.push(`${field} is required`);
    }
  }

  if (data.id != null && !isContentId(data.id)) {
    errors.push('id must be a ULID');
  }

  if (data.slug != null) {
    if (typeof data.slug !== 'string' || data.slug.length > 80 || !SLUG_PATTERN.test(data.slug)) {
      errors.push('slug must be lowercase [a-z0-9-] and at most 80 characters');
    } else if (RESERVED_SLUGS.has(data.slug)) {
      errors.push(`slug is reserved: ${data.slug}`);
    }
  }
  if (data.allowPublishedSlugChange != null
      && typeof data.allowPublishedSlugChange !== 'boolean') {
    errors.push('allowPublishedSlugChange must be a boolean');
  }

  if (data.publishAfterDate != null && !isCalendarDate(data.publishAfterDate)) {
    errors.push('publishAfterDate must be a valid YYYY-MM-DD date');
  }
  if (data.createdDate != null && !isCalendarDate(data.createdDate)) {
    errors.push('createdDate must be a valid YYYY-MM-DD date');
  }
  if (data.deleteDate != null && !isCalendarDate(data.deleteDate)) {
    errors.push('deleteDate must be a valid YYYY-MM-DD date');
  }
  if (
    isCalendarDate(data.publishAfterDate) &&
    isCalendarDate(data.deleteDate) &&
    data.deleteDate < data.publishAfterDate
  ) {
    errors.push('deleteDate must not be earlier than publishAfterDate');
  }

  if (data.language != null && !isLanguageTag(data.language)) {
    errors.push('language must be a valid BCP-47 tag');
  }

  if (data.tags != null) {
    if (!Array.isArray(data.tags)) {
      errors.push('tags must be a list');
    } else {
      if (data.tags.length > 8) errors.push('tags must contain at most 8 values');
      data.tags.forEach((tag, index) => {
        if (typeof tag !== 'string' || tag.length > 80 || !SLUG_PATTERN.test(tag)) {
          errors.push(`tags[${index}] must follow slug rules`);
        } else if (RESERVED_SLUGS.has(tag)) {
          errors.push(`tags[${index}] is reserved: ${tag}`);
        }
      });
    }
  }

  if (data.editHistory != null) {
    if (!Array.isArray(data.editHistory)) {
      errors.push('editHistory must be a list');
    } else {
      data.editHistory.forEach((entry, index) => {
        const match = typeof entry === 'string' && entry.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
        if (!match || !isCalendarDate(match[1])) {
          errors.push(`editHistory[${index}] must be [YYYY-MM-DD] [one-line summary]`);
        } else if (match[1] > today) {
          errors.push(`editHistory[${index}] must not be future-dated`);
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
    throw new TypeError(`${field} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError(`${field} must use HTTPS without credentials`);
  }
  parsed.hash = '';
  return parsed;
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
  const base = absoluteHttpsUrl(canonicalBaseUrl, 'canonicalBaseUrl');
  const segments = [
    ...pathSegments(pathPrefix, 'pathPrefix'),
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
    }))
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
        `post folder "${group.folderName}" is invalid; use lowercase [a-z0-9-] ` +
        'with no leading, trailing, or repeated hyphens, maximum 80 characters'
      );
    } else if (RESERVED_SLUGS.has(group.folderName)) {
      folderErrors.push(`post folder is reserved: ${group.folderName}`);
    }
    if (group.explicitSlugs.size > 1) {
      folderErrors.push('language variants in one post folder declare conflicting slugs');
    } else if (group.explicitSlugs.size === 1) {
      const explicitSlug = group.explicitSlugs.values().next().value;
      if (explicitSlug.length > 80 || !SLUG_PATTERN.test(explicitSlug)) {
        folderErrors.push(
          'explicit slug must be lowercase [a-z0-9-] and at most 80 characters'
        );
      } else if (RESERVED_SLUGS.has(explicitSlug)) {
        folderErrors.push(`explicit slug is reserved: ${explicitSlug}`);
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
    if (entry.isDirectory()) return markdownPostFiles(entryPath);
    return entry.isFile() && /^index\.[^.]+\.md$/.test(entry.name) ? [entryPath] : [];
  }));
  return nested.flat();
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
  if (manifest == null || manifest.schemaVersion !== 1 || !Array.isArray(manifest.posts)) {
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
    posts: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
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

function mediaReferences(data, body) {
  const references = [];
  if (typeof data?.coverImage === 'string'
      && !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(data.coverImage)) {
    references.push(data.coverImage);
  }
  for (const match of body.matchAll(/!\[[^\]]*]\((?:<)?([^\s)>]+)(?:>)?(?:\s+['"][^'"]*['"])?\)/g)) {
    references.push(match[1]);
  }
  return references.filter((reference) => !/^(?:https:|mailto:|\/)/i.test(reference));
}

async function validateMedia(file, data, body) {
  const postDirectory = path.dirname(file);
  const realPostDirectory = await realpath(postDirectory);
  const errors = [];
  const media = [];
  if (data?.coverImage != null && (
    typeof data.coverImage !== 'string'
    || data.coverImage.trim() === ''
    || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(data.coverImage)
    || data.coverImage.includes('\\')
  )) {
    errors.push(`coverImage must be relative to the post folder: ${data.coverImage}`);
  }
  for (const reference of new Set(mediaReferences(data, body))) {
    const resolved = path.resolve(postDirectory, reference);
    const relative = path.relative(postDirectory, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      errors.push(`media reference escapes the post folder: ${reference}`);
      continue;
    }
    try {
      const realTarget = await realpath(resolved);
      const realRelative = path.relative(realPostDirectory, realTarget);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        errors.push(`media reference resolves outside the post folder: ${reference}`);
        continue;
      }
      if (!(await stat(realTarget)).isFile()) {
        errors.push(`media reference is not a file: ${reference}`);
      } else {
        media.push({ reference, realTarget });
      }
    } catch (error) {
      if (error.code === 'ENOENT') errors.push(`media reference does not exist: ${reference}`);
      else if (error.code === 'ELOOP') errors.push(`media reference does not resolve: ${reference}`);
      else throw error;
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
    errors.push('post path must be content/posts/<post-folder>/index.<lang>.md');
  }
  if (filenameLanguage == null) return errors;
  if (!isLanguageTag(filenameLanguage)) {
    errors.push(`filename language ${filenameLanguage} must be a valid BCP-47 tag`);
  } else if (isLanguageTag(data?.language)
      && canonicalizeLanguageTag(filenameLanguage) !== canonicalizeLanguageTag(data.language)) {
    errors.push(
      `filename language ${filenameLanguage} does not match frontmatter language ${data.language}`
    );
  }
  return errors;
}

export async function validateContent({ root, today, now, configPath, timezone }) {
  const evaluationDate = today ?? await repositoryEvaluationDate({ root, now, configPath, timezone });
  const postsRoot = path.join(root, 'content', 'posts');
  const files = await markdownPostFiles(postsRoot);
  const results = await Promise.all(files.map(async (file) => {
    const parsed = parseFrontmatter(await readFile(file, 'utf8'));
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
    const warnings = parsed.errors.length === 0
        && (typeof parsed.data.description !== 'string' || parsed.data.description.trim() === '')
      ? ['description is missing; SEO metadata will use the first 160 characters of rendered body text']
      : [];
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
      results[index].errors.push(`duplicate slug-language variant: ${duplicate.slug} (${duplicate.language})`);
    }
  }
  for (const conflict of findArticleIdentityConflicts(metadata)) {
    const message = conflict.type === 'folder'
      ? 'language variants in one post folder must share one article id'
      : `article id is reused across post folders: ${conflict.value}`;
    for (const index of conflict.indexes) results[index].errors.push(message);
  }
  return results;
}

function siteLocation(config) {
  if (config == null || Array.isArray(config) || typeof config !== 'object'
      || config.schemaVersion !== 1 || config.hosting == null) {
    throw new TypeError('Unsupported site.config.yml schema');
  }
  return { canonicalBaseUrl: config.hosting.canonicalBaseUrl, pathPrefix: config.hosting.pathPrefix ?? '/' };
}

export async function regenerateBuildManifest({
  root,
  today,
  now,
  idFactory,
  configPath = 'site.config.yml',
  timezone
}) {
  const siteRoot = path.resolve(root);
  const realSiteRoot = await realpath(siteRoot);
  const manifestPath = path.join(siteRoot, BUILD_MANIFEST_PATH);
  await rm(manifestPath, { force: true });
  const assigned = await assignMissingContentIds(siteRoot, { idFactory });
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
        result.warnings.push(`published slug changed from ${previous.slug}; static hosting emits a meta-refresh redirect, not a true 301, so some link equity will be lost`);
      } else {
        result.errors.push(`published slug changed from ${previous.slug}; pin that slug explicitly to keep the URL`);
      }
    }
  }
  const location = siteLocation(await regularYaml(siteRoot, configPath, 'site configuration'));
  const posts = [];
  for (const result of results) {
    if (result.errors.length > 0) continue;
    const effective = resolveEffectivePost({
      data: result.data, slug: result.effectiveSlug, today: evaluationDate, ...location
    });
    if (effective.publicationState === PublicationState.NOT_EMITTED) continue;
    const previous = publishedById.get(result.data.id);
    if (effective.publicationState === PublicationState.TOMBSTONED
        && !Object.hasOwn(previous?.languages ?? {}, effective.language)) continue;
    const source = path.relative(siteRoot, result.file);
    if (source.startsWith('..') || path.isAbsolute(source)) {
      throw new TypeError(`Validated post escapes the site root: ${result.file}`);
    }
    posts.push({
      source: source.split(path.sep).join('/'),
      id: result.data.id ?? null,
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
      publicationState: effective.publicationState
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
  const manifest = { schemaVersion: 1, evaluationDate, assignedContentIds, posts, redirects };
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
