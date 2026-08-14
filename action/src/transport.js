import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const MAX_TRANSMITTED_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 10 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

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
  maxAttempts = 2
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
      if (attempt < maxAttempts) continue;
      throw new ReconciliationTransportError('Reconciliation API is unreachable', { code: 'UNREACHABLE' });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Status remains authoritative when a proxy returns a non-JSON error body.
    }
    if (response.ok) return payload;
    if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) continue;
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
  fetchImpl = fetch
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
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Gala-Signature': signReconciliationBody(siteId, body, siteSecret)
    },
    body
  });
  if (response.ok) return;
  let payload = null;
  try { payload = await response.json(); } catch { /* Status remains authoritative. */ }
  throw new ReconciliationTransportError(
    payload?.message ?? `Build report failed with HTTP ${response.status}`,
    { status: response.status, code: payload?.code ?? null }
  );
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
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(payload.refreshedAt)
      || payload.articles == null
      || Array.isArray(payload.articles) || typeof payload.articles !== 'object') {
    throw new ReconciliationTransportError('Engagement snapshot response is invalid');
  }
  for (const [articleId, counts] of Object.entries(payload.articles)) {
    if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(articleId)
        || counts == null || Array.isArray(counts) || typeof counts !== 'object'
        || Object.keys(counts).sort().join(',') !== 'comments,reactions,views'
        || !['reactions', 'comments', 'views'].every(
      (field) => Number.isSafeInteger(counts[field]) && counts[field] >= 0
    )) {
      throw new ReconciliationTransportError('Engagement snapshot response is invalid');
    }
  }
  return payload;
}
