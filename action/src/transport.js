import { createHmac } from 'node:crypto';
import { setTimeout as waitFor } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

const MAX_TRANSMITTED_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 10 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 6;
const ARTICLE_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ARTICLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTICLE_IDENTITY_REASONS = new Set(['RESTORED_SITE_ID', 'ASSIGNED_NEW_ID']);

async function retryPause(wait, attempt) {
  await wait(1_000 * (2 ** (attempt - 1)));
}

export class ReconciliationTransportError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'ReconciliationTransportError';
    this.status = status;
    this.code = code;
  }
}

export function signReconciliationBody(siteId, body, secret) {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(siteId)) {
    throw new TypeError('siteId must be a canonical ULID');
  }
  if (!Buffer.isBuffer(body)) throw new TypeError('body must be a Buffer');
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new TypeError('site secret must contain at least 256 bits');
  }
  return `sha256=${createHmac('sha256', secret)
    .update(siteId, 'utf8').update(Buffer.from([0x0a])).update(body).digest('hex')}`;
}

function transmittedBody(envelope, gzipThreshold) {
  const json = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (json.length > MAX_EXPANDED_BYTES) {
    throw new ReconciliationTransportError('Reconciliation payload exceeds 10 MiB expanded', {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE'
    });
  }
  if (json.length < gzipThreshold) return { body: json, encoding: null };
  return { body: gzipSync(json), encoding: 'gzip' };
}

export async function sendReconciliation({
  apiBaseUrl,
  siteId,
  siteSecret,
  envelopeForAttempt,
  fetchImpl = fetch,
  gzipThreshold = 1024,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  wait = waitFor
}) {
  const endpoint = new URL(`/v1/sites/${siteId}/reconciliation`, apiBaseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
    throw new TypeError('apiBaseUrl must use HTTPS without credentials');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const envelope = envelopeForAttempt(attempt);
    const transmitted = transmittedBody(envelope, gzipThreshold);
    if (transmitted.body.length > MAX_TRANSMITTED_BYTES) {
      throw new ReconciliationTransportError('Reconciliation payload exceeds 2 MiB', {
        status: 413,
        code: 'PAYLOAD_TOO_LARGE'
      });
    }
    const headers = {
      'Content-Type': 'application/json',
      'Gala-Signature': signReconciliationBody(siteId, transmitted.body, siteSecret)
    };
    if (transmitted.encoding != null) headers['Content-Encoding'] = transmitted.encoding;
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', headers, body: transmitted.body });
    } catch (error) {
      if (attempt < maxAttempts) {
        await retryPause(wait, attempt);
        continue;
      }
      throw new ReconciliationTransportError('Reconciliation API is unreachable', { code: 'UNREACHABLE' });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Status remains authoritative when a proxy returns a non-JSON error body.
    }
    if (response.ok) return payload;
    if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
      await retryPause(wait, attempt);
      continue;
    }
    throw new ReconciliationTransportError(
      payload?.message ?? `Reconciliation failed with HTTP ${response.status}`,
      { status: response.status, code: payload?.code ?? null }
    );
  }
  throw new ReconciliationTransportError('Reconciliation attempts exhausted');
}

export async function sendBuildFailure({
  apiBaseUrl,
  siteId,
  siteSecret,
  report,
  fetchImpl = fetch,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  wait = waitFor
}) {
  const endpoint = new URL(`/v1/sites/${siteId}/build-reports`, apiBaseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
    throw new TypeError('apiBaseUrl must use HTTPS without credentials');
  }
  const body = Buffer.from(JSON.stringify(report), 'utf8');
  if (body.length > 256 * 1024) {
    throw new ReconciliationTransportError('Build report exceeds 256 KiB', {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE'
    });
  }
  const headers = {
    'Content-Type': 'application/json',
    'Gala-Signature': signReconciliationBody(siteId, body, siteSecret)
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', headers, body });
    } catch (error) {
      if (attempt < maxAttempts) {
        await retryPause(wait, attempt);
        continue;
      }
      throw new ReconciliationTransportError('Build report API is unreachable', { code: 'UNREACHABLE' });
    }
    if (response.ok) return;
    let payload = null;
    try { payload = await response.json(); } catch { /* Status remains authoritative. */ }
    if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
      await retryPause(wait, attempt);
      continue;
    }
    throw new ReconciliationTransportError(
      payload?.message ?? `Build report failed with HTTP ${response.status}`,
      { status: response.status, code: payload?.code ?? null }
    );
  }
  throw new ReconciliationTransportError('Build report attempts exhausted');
}

export async function readEngagementSnapshot({
  apiBaseUrl,
  siteId,
  siteSecret,
  runId,
  runAttempt,
  emittedAt,
  fetchImpl = fetch
}) {
  const endpoint = new URL(`/v1/sites/${siteId}/engagement-snapshot/read`, apiBaseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
    throw new TypeError('apiBaseUrl must use HTTPS without credentials');
  }
  const body = Buffer.from(JSON.stringify({ emittedAt, runId, runAttempt }), 'utf8');
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Gala-Signature': signReconciliationBody(siteId, body, siteSecret)
    },
    body
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* Status remains authoritative. */ }
  if (!response.ok) {
    throw new ReconciliationTransportError(
      payload?.message ?? `Engagement snapshot read failed with HTTP ${response.status}`,
      { status: response.status, code: payload?.code ?? null }
    );
  }
  if (payload?.schemaVersion !== 1
      || typeof payload.refreshedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(payload.refreshedAt)
      || payload.articles == null
      || Array.isArray(payload.articles) || typeof payload.articles !== 'object') {
    throw new ReconciliationTransportError('Engagement snapshot response is invalid');
  }
  for (const [articleId, counts] of Object.entries(payload.articles)) {
    if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(articleId)
        || counts == null || Array.isArray(counts) || typeof counts !== 'object') {
      throw new ReconciliationTransportError('Engagement snapshot response is invalid');
    }
    const keys = Object.keys(counts).sort().join(',');
    const countFields = keys === 'comments,reactions,views'
      ? ['reactions', 'comments', 'views']
      : ['reactions', 'comments', 'views', 'activeReadingSeconds'];
    if ((keys !== 'comments,reactions,views'
        && keys !== 'activeReadingSeconds,comments,reactions,views')
        || !countFields.every(
          (field) => Number.isSafeInteger(counts[field]) && counts[field] >= 0
        )) {
      throw new ReconciliationTransportError('Engagement snapshot response is invalid');
    }
  }
  return payload;
}

export async function readBuildSettings({
  apiBaseUrl,
  siteId,
  siteSecret,
  runId,
  runAttempt,
  emittedAt,
  fetchImpl = fetch
}) {
  const endpoint = new URL(`/v1/sites/${siteId}/build-settings/read`, apiBaseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
    throw new TypeError('apiBaseUrl must use HTTPS without credentials');
  }
  const body = Buffer.from(JSON.stringify({ emittedAt, runId, runAttempt }), 'utf8');
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Gala-Signature': signReconciliationBody(siteId, body, siteSecret)
    },
    body
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* Status remains authoritative. */ }
  if (!response.ok) {
    throw new ReconciliationTransportError(
      payload?.message ?? `Build settings read failed with HTTP ${response.status}`,
      { status: response.status, code: payload?.code ?? null }
    );
  }
  const policy = payload?.paginationPolicy;
  const contributorCredits = payload?.contributorCredits;
  if (payload?.schemaVersion !== 1
      || typeof payload.generatedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(payload.generatedAt)
      || policy == null || Array.isArray(policy) || typeof policy !== 'object'
      || Object.keys(policy).sort().join(',')
        !== 'defaultPageSize,maximumPageSize,minimumPageSize'
      || !['minimumPageSize', 'maximumPageSize', 'defaultPageSize'].every(
        (field) => Number.isSafeInteger(policy[field])
      )
      || policy.minimumPageSize < 1 || policy.maximumPageSize > 100
      || policy.minimumPageSize > policy.defaultPageSize
      || policy.defaultPageSize > policy.maximumPageSize
      || !validContributorCredits(contributorCredits)) {
    throw new ReconciliationTransportError('Build settings response is invalid');
  }
  return payload;
}

function validContributorCredits(value) {
  if (value == null || Array.isArray(value) || typeof value !== 'object') return false;
  return Object.entries(value).every(([slug, credits]) =>
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
      && credits != null && !Array.isArray(credits) && typeof credits === 'object'
      && Object.keys(credits).sort().join(',') === 'authors,editors'
      && ['authors', 'editors'].every((field) => Array.isArray(credits[field])
        && credits[field].length <= 50
        && credits[field].every((name) => typeof name === 'string'
          && name.trim() !== '' && [...name].length <= 120)));
}

function validatedIdentityResolution(payload, articles) {
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.repairs)) {
    throw new ReconciliationTransportError('Article identity resolution response is invalid');
  }
  const requested = new Set(articles.map(({ id, slug }) => `${id}\n${slug}`));
  const repaired = new Set();
  const resolved = new Set();
  for (const repair of payload.repairs) {
    if (repair == null || Array.isArray(repair) || typeof repair !== 'object'
        || Object.keys(repair).sort().join(',') !== 'reason,requestedId,resolvedId,slug'
        || !ARTICLE_ID.test(repair.requestedId)
        || !ARTICLE_ID.test(repair.resolvedId)
        || repair.requestedId === repair.resolvedId
        || typeof repair.slug !== 'string' || repair.slug.length > 80
        || !ARTICLE_SLUG.test(repair.slug)
        || !ARTICLE_IDENTITY_REASONS.has(repair.reason)
        || !requested.has(`${repair.requestedId}\n${repair.slug}`)
        || repaired.has(repair.requestedId)
        || resolved.has(repair.resolvedId)) {
      throw new ReconciliationTransportError('Article identity resolution response is invalid');
    }
    repaired.add(repair.requestedId);
    resolved.add(repair.resolvedId);
  }
  return payload;
}

export async function resolveArticleIdentities({
  apiBaseUrl,
  siteId,
  siteSecret,
  runId,
  runAttempt,
  emittedAt,
  articles,
  fetchImpl = fetch,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  wait = waitFor
}) {
  const endpoint = new URL(`/v1/sites/${siteId}/article-identities/resolve`, apiBaseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
    throw new TypeError('apiBaseUrl must use HTTPS without credentials');
  }
  if (!Array.isArray(articles) || articles.length < 1 || articles.length > 1000) {
    throw new TypeError('articles must contain between 1 and 1000 identities');
  }
  const ids = new Set();
  const slugs = new Set();
  for (const article of articles) {
    if (article == null || Array.isArray(article) || typeof article !== 'object'
        || Object.keys(article).sort().join(',') !== 'id,slug'
        || !ARTICLE_ID.test(article.id)
        || typeof article.slug !== 'string' || article.slug.length > 80
        || !ARTICLE_SLUG.test(article.slug)
        || ids.has(article.id) || slugs.has(article.slug)) {
      throw new TypeError('articles contain an invalid or duplicate identity');
    }
    ids.add(article.id);
    slugs.add(article.slug);
  }
  const body = Buffer.from(JSON.stringify({ emittedAt, runId, runAttempt, articles }), 'utf8');
  if (body.length > 128 * 1024) {
    throw new ReconciliationTransportError('Article identity resolution request exceeds 128 KiB', {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE'
    });
  }
  const headers = {
    'Content-Type': 'application/json',
    'Gala-Signature': signReconciliationBody(siteId, body, siteSecret)
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', headers, body });
    } catch {
      if (attempt < maxAttempts) {
        await retryPause(wait, attempt);
        continue;
      }
      throw new ReconciliationTransportError(
        'Article identity resolution API is unreachable',
        { code: 'UNREACHABLE' }
      );
    }
    let payload = null;
    try { payload = await response.json(); } catch { /* Status remains authoritative. */ }
    if (response.ok) return validatedIdentityResolution(payload, articles);
    if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
      await retryPause(wait, attempt);
      continue;
    }
    throw new ReconciliationTransportError(
      payload?.message ?? `Article identity resolution failed with HTTP ${response.status}`,
      { status: response.status, code: payload?.code ?? null }
    );
  }
  throw new ReconciliationTransportError('Article identity resolution attempts exhausted');
}
