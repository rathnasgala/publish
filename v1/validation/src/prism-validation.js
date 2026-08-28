import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseDocument } from 'yaml';
import {
  markdownBodyHashV2,
  prismSourceHashV1,
  verifyApprovalHmac,
  GALA_PRISM_HASH_V1
} from './prism-hashing.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const DIMENSIONS = Object.freeze({
  depth: new Set(['SIGNAL', 'BRIEF', 'STANDARD', 'COMPLETE', 'METHODS_REFERENCES']),
  intent: new Set(['ORIENTATION', 'STORY', 'PROOF', 'PRACTICE']),
  modality: new Set(['TEXT'])
});
const CONFIGURATION_KEYS = new Set([
  'schemaVersion', 'configurationId', 'revisionId', 'approvalId', 'parentArticleId',
  'parentLanguage', 'sourceRevisionHash', 'configurationContentHash', 'depth', 'intent',
  'modality', 'approvedAt', 'hashContract', 'approvalTokenVersion', 'approvalToken'
]);
const PRISM_SETTING_KEYS = new Set([
  'schemaVersion', 'mode', 'configurationLinkPolicy', 'articleModes',
  'articleConfigurationLinkPolicies'
]);
const MODES = new Set(['OFF', 'PRESENTATION_ONLY', 'MANUAL', 'ASSISTED']);
const LINK_POLICIES = new Set(['NOFOLLOW', 'FOLLOW']);
const PROTECTION_KEYS = new Set(['schemaVersion', 'caveats', 'names', 'attributions']);
const KEEP_MARKER = /<!--\s*(\/?)prism-keep(?::([A-Za-z0-9._-]+))?\s*-->/g;

export function normalizePrismSettings(value, knownArticleIds) {
  if (value == null) return null;
  if (Array.isArray(value) || typeof value !== 'object' || value.schemaVersion !== 1) {
    throw new TypeError('prism must be a schemaVersion 1 mapping');
  }
  const unknown = Object.keys(value).filter((key) => !PRISM_SETTING_KEYS.has(key));
  if (unknown.length > 0) throw new TypeError(`Unsupported prism option: ${unknown.join(', ')}`);
  const mode = value.mode ?? 'OFF';
  const configurationLinkPolicy = value.configurationLinkPolicy ?? 'NOFOLLOW';
  if (!MODES.has(mode)) throw new TypeError(`Unsupported prism mode: ${mode}`);
  if (!LINK_POLICIES.has(configurationLinkPolicy)) {
    throw new TypeError(`Unsupported prism configurationLinkPolicy: ${configurationLinkPolicy}`);
  }
  const articleModes = settingMap(value.articleModes, MODES, 'articleModes', knownArticleIds);
  const articleConfigurationLinkPolicies = settingMap(value.articleConfigurationLinkPolicies,
    LINK_POLICIES, 'articleConfigurationLinkPolicies', knownArticleIds);
  return Object.freeze({
    schemaVersion: 1, mode, configurationLinkPolicy,
    articleModes, articleConfigurationLinkPolicies,
  });
}

export async function readPrismRepository({
  root,
  siteId,
  canonicalPosts,
  currentSiteSecret,
  previousSiteSecret = null
}) {
  if (!ULID.test(siteId)) throw new TypeError('siteId must be a ULID');
  const canonicalVariants = new Map();
  for (const post of canonicalPosts) {
    const prismProtectionContract = normalizePrismProtection(
      post.rawFrontmatter.prismProtection, post.contentBody);
    const mediaDigests = {};
    for (const media of post.media ?? []) {
      mediaDigests[path.posix.basename(media.output)] = createHash('sha256')
        .update(await readFile(path.join(root, media.source))).digest('hex');
    }
    const sourceRevisionHash = prismSourceHashV1({
      title: post.rawFrontmatter.title,
      description: post.rawFrontmatter.description ?? post.rawFrontmatter.summary ?? '',
      markdownBody: Buffer.from(post.contentBody),
      protectionContractJson: JSON.stringify(prismProtectionContract),
      referencedMediaDigestsJson: JSON.stringify(mediaDigests)
    });
    post.prismSourceHash = sourceRevisionHash;
    post.prismHashContract = GALA_PRISM_HASH_V1;
    post.prismProtectionContract = prismProtectionContract;
    post.prismReferencedMediaDigests = mediaDigests;
    canonicalVariants.set(`${post.id}:${post.language}`, { sourceRevisionHash, post });
  }

  const configurations = [];
  for (const parent of canonicalPosts) {
    const directory = path.join(root, path.dirname(parent.source), 'prism');
    let identities;
    try { identities = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const identity of identities) {
      if (!identity.isDirectory() || !ULID.test(identity.name)) {
        throw new TypeError(`Invalid Prism configuration path: ${identity.name}`);
      }
      const entries = await readdir(path.join(directory, identity.name), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/^index\.[A-Za-z0-9-]+\.md$/.test(entry.name)) {
          throw new TypeError(`Invalid Prism configuration file: ${entry.name}`);
        }
        const source = await readFile(path.join(directory, identity.name, entry.name), 'utf8');
        configurations.push({
          ...parseConfiguration(source, identity.name, parent),
          source: path.relative(root, path.join(directory, identity.name, entry.name)).split(path.sep).join('/')
        });
      }
    }
  }

  const approvalsDirectory = path.join(root, '.gala', 'prism', 'approvals');
  let approvalEntries = [];
  try { approvalEntries = await readdir(approvalsDirectory, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const approvals = [];
  for (const entry of approvalEntries) {
    if (!entry.isFile() || !ULID.test(entry.name.replace(/\.json$/, '')) || !entry.name.endsWith('.json')) {
      throw new TypeError(`Invalid Prism approval path: ${entry.name}`);
    }
    const document = parseDocument(await readFile(path.join(approvalsDirectory, entry.name), 'utf8'), {
      strict: true,
      uniqueKeys: true
    });
    if (document.errors.length > 0) throw new TypeError(`Malformed Prism approval: ${entry.name}`);
    const approval = document.toJS();
    if (approval.approvalId !== entry.name.slice(0, -5)) {
      throw new TypeError(`Prism approval path does not match approvalId: ${entry.name}`);
    }
    approvals.push(approval);
  }
  return validatePrismConfigurations({
    siteId,
    canonicalVariants,
    configurations,
    approvals,
    currentSiteSecret: Buffer.from(currentSiteSecret),
    previousSiteSecret: previousSiteSecret == null ? null : Buffer.from(previousSiteSecret)
  });
}

export function normalizePrismProtection(value, canonicalBody) {
  validateKeepMarkers(canonicalBody);
  if (value == null) return Object.freeze({});
  if (Array.isArray(value) || typeof value !== 'object' || value.schemaVersion !== 1) {
    throw new TypeError('prismProtection must be a schemaVersion 1 mapping');
  }
  const unknown = Object.keys(value).filter((key) => !PROTECTION_KEYS.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unsupported prismProtection option: ${unknown.join(', ')}`);
  }
  const normalized = { schemaVersion: 1 };
  for (const field of ['caveats', 'names', 'attributions']) {
    const entries = value[field] ?? [];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string'
      || entry.trim() === '')) {
      throw new TypeError(`prismProtection.${field} must contain non-empty text`);
    }
    const unique = [...new Set(entries.map((entry) => entry.normalize('NFC')))];
    for (const entry of unique) {
      if (!canonicalBody.normalize('NFC').includes(entry)) {
        throw new TypeError(`prismProtection.${field} contains text absent from the canonical work`);
      }
    }
    if (unique.length > 0) normalized[field] = Object.freeze(unique);
  }
  return Object.freeze(normalized);
}

function validateKeepMarkers(value) {
  if (typeof value !== 'string') throw new TypeError('canonicalBody must be a string');
  let open = null;
  const seenIds = new Set();
  for (const marker of value.matchAll(KEEP_MARKER)) {
    const closing = marker[1] === '/';
    const id = marker[2] ?? null;
    if (!closing) {
      if (open != null) throw new TypeError('prism-keep blocks must not be nested');
      if (id != null && seenIds.has(id)) throw new TypeError(`Duplicate prism-keep id: ${id}`);
      if (id != null) seenIds.add(id);
      open = id ?? '';
    } else {
      if (open == null || open !== (id ?? '')) {
        throw new TypeError('prism-keep closing marker does not match its opening marker');
      }
      open = null;
    }
  }
  if (open != null) throw new TypeError('prism-keep block is not closed');
}

function settingMap(value, allowed, field, knownArticleIds) {
  if (value == null) return Object.freeze({});
  if (Array.isArray(value) || typeof value !== 'object') throw new TypeError(`prism.${field} must be a mapping`);
  const output = {};
  for (const [articleId, setting] of Object.entries(value)) {
    if (!ULID.test(articleId)) throw new TypeError(`prism.${field} key must be an article ULID`);
    if (!knownArticleIds.has(articleId)) throw new TypeError(`prism.${field} contains unknown articleId: ${articleId}`);
    if (!allowed.has(setting)) throw new TypeError(`prism.${field}.${articleId} has an unsupported value`);
    output[articleId] = setting;
  }
  return Object.freeze(output);
}

export function validatePrismConfigurations({
  siteId,
  canonicalVariants,
  configurations,
  approvals,
  currentSiteSecret,
  previousSiteSecret = null
}) {
  if (!ULID.test(siteId)) throw new TypeError('siteId must be a ULID');
  if (!(canonicalVariants instanceof Map)) throw new TypeError('canonicalVariants must be a Map');
  if (!Array.isArray(configurations) || !Array.isArray(approvals)) {
    throw new TypeError('configurations and approvals must be arrays');
  }
  const approvalsById = uniqueBy(approvals, 'approvalId', 'approval');
  const seenApprovals = new Set();
  const dimensions = new Set();
  const output = configurations.map((configuration) => {
    requireConfiguration(configuration);
    const parentKey = `${configuration.articleId}:${configuration.language}`;
    const parent = canonicalVariants.get(parentKey);
    if (parent == null) throw new TypeError(`Orphan Prism configuration: ${configuration.configurationId}`);
    const dimensionKey = `${parentKey}:${configuration.depth}:${configuration.intent}:${configuration.modality}`;
    if (dimensions.has(dimensionKey)) throw new TypeError(`Duplicate Prism dimensions: ${dimensionKey}`);
    dimensions.add(dimensionKey);
    const approval = approvalsById.get(configuration.approvalId);
    if (approval == null) throw new TypeError(`Missing Prism approval: ${configuration.approvalId}`);
    seenApprovals.add(configuration.approvalId);
    const facts = approvalFacts(siteId, configuration, approval);
    requireApprovalMatch(configuration, approval);
    const contentHash = markdownBodyHashV2(Buffer.from(configuration.markdown));
    if (contentHash !== approval.configurationContentHash) {
      throw new TypeError(`Unapproved Prism body: ${configuration.configurationId}`);
    }
    const slot = verificationSlot(currentSiteSecret, previousSiteSecret, facts, approval.approvalToken);
    if (slot == null) throw new TypeError(`Invalid Prism approval token: ${configuration.approvalId}`);
    if (parent.sourceRevisionHash !== approval.sourceRevisionHash) {
      return fallback(configuration, approval, 'STALE', slot);
    }
    return {
      ...configuration,
      state: 'PUBLISHED',
      contentHash,
      approvalTokenVerifiedWith: slot
    };
  });
  const orphan = approvals.find((approval) => !seenApprovals.has(approval.approvalId));
  if (orphan != null) throw new TypeError(`Orphan Prism approval: ${orphan.approvalId}`);
  return output;
}

function fallback(configuration, approval, state, slot) {
  const { markdown: _discarded, ...safe } = configuration;
  return {
    ...safe,
    state,
    contentHash: approval.configurationContentHash,
    approvalTokenVerifiedWith: slot
  };
}

function verificationSlot(current, previous, facts, token) {
  if (verifyApprovalHmac(current, facts, token)) return 'CURRENT';
  if (previous != null && verifyApprovalHmac(previous, facts, token)) return 'PREVIOUS';
  return null;
}

function approvalFacts(siteId, configuration, approval) {
  return {
    siteId,
    approvalId: approval.approvalId,
    configurationId: configuration.configurationId,
    revisionId: configuration.revisionId,
    articleId: configuration.articleId,
    language: configuration.language,
    sourceRevisionHash: approval.sourceRevisionHash,
    configurationContentHash: approval.configurationContentHash,
    depth: configuration.depth,
    intent: configuration.intent,
    modality: configuration.modality,
    approvedAt: approval.approvedAt,
    authorityType: approval.approvedBy,
    hashContract: approval.hashContract,
    approvalTokenVersion: approval.approvalTokenVersion
  };
}

function requireApprovalMatch(configuration, approval) {
  for (const field of [
    'configurationId', 'revisionId', 'articleId', 'language', 'sourceRevisionHash',
    'configurationContentHash', 'depth', 'intent', 'modality', 'approvedAt', 'hashContract',
    'approvalTokenVersion', 'approvalToken'
  ]) {
    if (configuration[field] !== approval[field]) {
      throw new TypeError(`Prism approval ${field} mismatch: ${approval.approvalId}`);
    }
  }
  if (approval.hashContract !== GALA_PRISM_HASH_V1 || approval.schemaVersion !== 1) {
    throw new TypeError(`Unsupported Prism approval contract: ${approval.approvalId}`);
  }
}

function parseConfiguration(source, pathId, parent) {
  const match = source.match(/^\uFEFF?---(\r?\n)([\s\S]*?)\1---\1/);
  if (match == null) throw new TypeError(`Prism configuration ${pathId} has malformed frontmatter`);
  const document = parseDocument(match[2], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new TypeError(`Prism configuration ${pathId} has malformed YAML`);
  const root = document.toJS();
  if (root == null || Array.isArray(root) || typeof root !== 'object'
      || root.prism == null || Array.isArray(root.prism) || typeof root.prism !== 'object'
      || Object.keys(root).some((key) => key !== 'prism')) {
    throw new TypeError(`Prism configuration ${pathId} must contain only prism frontmatter`);
  }
  for (const key of Object.keys(root.prism)) {
    if (!CONFIGURATION_KEYS.has(key)) throw new TypeError(`Unsupported Prism frontmatter key: ${key}`);
  }
  const value = root.prism;
  if (value.schemaVersion !== 1 || value.configurationId !== pathId
      || value.parentArticleId !== parent.id || value.parentLanguage !== parent.language) {
    throw new TypeError(`Prism configuration identity mismatch: ${pathId}`);
  }
  return {
    configurationId: value.configurationId,
    revisionId: value.revisionId,
    approvalId: value.approvalId,
    articleId: value.parentArticleId,
    language: value.parentLanguage,
    sourceRevisionHash: value.sourceRevisionHash,
    configurationContentHash: value.configurationContentHash,
    depth: value.depth,
    intent: value.intent,
    modality: value.modality,
    approvedAt: value.approvedAt,
    hashContract: value.hashContract,
    approvalTokenVersion: value.approvalTokenVersion,
    approvalToken: value.approvalToken,
    markdown: source.slice(match[0].length),
    parentSource: parent.source
  };
}

function requireConfiguration(value) {
  for (const field of ['configurationId', 'revisionId', 'approvalId', 'articleId']) {
    if (!ULID.test(value?.[field])) throw new TypeError(`Invalid Prism ${field}`);
  }
  for (const [field, allowed] of Object.entries(DIMENSIONS)) {
    if (!allowed.has(value[field])) throw new TypeError(`Invalid Prism ${field}`);
  }
  if (typeof value.language !== 'string' || typeof value.markdown !== 'string') {
    throw new TypeError('Prism language and markdown are required');
  }
}

function uniqueBy(values, field, label) {
  const output = new Map();
  for (const value of values) {
    if (output.has(value?.[field])) throw new TypeError(`Duplicate Prism ${label}: ${value?.[field]}`);
    output.set(value?.[field], value);
  }
  return output;
}
