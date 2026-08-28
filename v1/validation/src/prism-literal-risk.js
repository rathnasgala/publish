const MAX_BODY_BYTES = 1_048_576;

const patterns = Object.freeze({
  frontmatter: /^---(?:\n|$)/,
  keep: /<!--\s*prism-keep(?::([A-Za-z0-9._-]+))?\s*-->[\s\S]*?<!--\s*\/prism-keep(?:\:\1)?\s*-->/g,
  rawHtml: /<(?:script|iframe)\b[^>]*>[\s\S]*?<\/(?:script|iframe)\s*>|<!--(?!\s*\/?prism-keep(?:[:\s-]|$))[\s\S]*?-->|<\/?[A-Za-z][^>]*>/gi,
  unsupported: /^(?:import|export)\s+(?:[A-Za-z_$*{]|default\b)|^\s*<[\/]?[A-Z][A-Za-z0-9._-]*(?:\s|\/?>)/gm,
  blockQuote: /^>\s?(?!\[!)[^\n]+(?:\n|$)/gm,
  quoted: /[“][^”\n]+[”]|"[^"\n]+"/g,
  link: /(?<!!)\[([^\]\n]+)]\((\S+?)(?:\s+["'][^"']*["'])?\)/g,
  date: /(?<![\p{L}\p{N}])\d{4}-\d{2}-\d{2}(?![\p{L}\p{N}])/gu,
  time: /(?<![\p{L}\p{N}])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s?(?:am|pm|utc|gmt))?(?![\p{L}\p{N}])/giu,
  unit: /(?<![\p{L}\p{N}])(?:[$€£¥₹]\s*)?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:%|°[cf]|ms|s|sec(?:ond)?s?|min(?:ute)?s?|h|hr|hours?|mm|cm|km|m|in|ft|yd|mi|mg|g|kg|oz|lb|kb|mb|gb|tb|hz|khz|mhz|ghz|kbps|mbps|gbps)(?![\p{L}\p{N}])/giu,
  number: /(?<![\p{L}\p{N}])(?:[$€£¥₹]\s*)?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\p{L}\p{N}])/gu
});

export const PRISM_LITERAL_RISK_V1 = 1;

export function analyzePrismLiteralRisk({ canonicalBody, configurationBody, protectionContract = {} }) {
  const source = normalizeRequired(canonicalBody, 'canonicalBody');
  const configuration = normalizeRequired(configurationBody, 'configurationBody');
  if (Buffer.byteLength(configuration) > MAX_BODY_BYTES) {
    throw new TypeError('configurationBody exceeds 1 MiB');
  }
  const findings = validateBody(configuration);
  compare(findings, source, configuration, quotations(source), 'QUOTATION', 'WARNING', 'quotation');
  compareNumeric(findings, source, configuration);
  compare(findings, source, configuration, occurrences(source, patterns.link),
    'ATTRIBUTION', 'WARNING', 'Markdown link or attribution');
  compare(findings, source, configuration, occurrences(source, patterns.keep),
    'KEEP_BLOCK', 'BLOCKER', 'author-marked prism-keep block');
  compareProtection(findings, source, configuration, protectionContract);
  removeCoveredAttributionFindings(findings);
  findNewOutboundLinks(findings, source, configuration);
  findings.sort((left, right) => (left.sourceSpan?.startOffset ?? Number.MAX_SAFE_INTEGER)
    - (right.sourceSpan?.startOffset ?? Number.MAX_SAFE_INTEGER)
    || (left.configurationSpan?.startOffset ?? Number.MAX_SAFE_INTEGER)
      - (right.configurationSpan?.startOffset ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id));
  return Object.freeze({ schemaVersion: PRISM_LITERAL_RISK_V1, findings: Object.freeze(findings) });
}

function validateBody(configuration) {
  const findings = [];
  addMatches(findings, configuration, patterns.frontmatter, 'configuration.frontmatter-not-allowed',
    'UNSUPPORTED_MARKDOWN', 'Configuration Markdown must not contain frontmatter', true);
  addMatches(findings, configuration, patterns.rawHtml, 'literal.forbidden:raw-html',
    'RAW_HTML', 'Configuration Markdown must not contain raw HTML');
  addMatches(findings, configuration, patterns.unsupported, 'literal.forbidden:unsupported-markdown',
    'UNSUPPORTED_MARKDOWN', 'Configuration Markdown contains an unsupported executable or MDX construct');
  removeOverlappingUnsupportedFindings(findings);
  return findings;
}

function removeOverlappingUnsupportedFindings(findings) {
  const html = findings.filter(({ kind }) => kind === 'RAW_HTML')
    .map(({ configurationSpan }) => configurationSpan);
  for (let index = findings.length - 1; index >= 0; index -= 1) {
    const candidate = findings[index];
    if (candidate.kind !== 'UNSUPPORTED_MARKDOWN') continue;
    if (html.some((span) => span.startOffset < candidate.configurationSpan.endOffset
      && candidate.configurationSpan.startOffset < span.endOffset)) findings.splice(index, 1);
  }
}

function compareNumeric(findings, source, configuration) {
  const occupied = [];
  for (const [pattern, kind, label] of [
    [patterns.date, 'DATE', 'date'], [patterns.time, 'TIME', 'time'],
    [patterns.unit, 'UNIT', 'unit'], [patterns.number, 'NUMBER', 'number']
  ]) {
    const candidates = occurrences(source, pattern)
      .filter((candidate) => !occupied.some((existing) => overlaps(existing, candidate)));
    occupied.push(...candidates);
    compare(findings, source, configuration, candidates, kind, 'WARNING', label);
  }
}

function compareProtection(findings, source, configuration, contract) {
  if (contract == null || Array.isArray(contract) || typeof contract !== 'object') {
    throw new TypeError('protectionContract must be a mapping');
  }
  if (Object.keys(contract).length > 0) {
    if (contract.schemaVersion !== 1) {
      throw new TypeError('protectionContract must use schemaVersion 1');
    }
    const unknown = Object.keys(contract)
      .filter((key) => !['schemaVersion', 'caveats', 'names', 'attributions'].includes(key));
    if (unknown.length > 0) throw new TypeError(`Unsupported protectionContract option: ${unknown[0]}`);
  }
  compareDeclared(findings, source, configuration, contract, 'caveats',
    'DECLARED_CAVEAT', 'BLOCKER', 'declared-caveat', 'declared caveat');
  compareDeclared(findings, source, configuration, contract, 'names',
    'NAME', 'WARNING', 'name', 'protected name');
  compareDeclared(findings, source, configuration, contract, 'attributions',
    'ATTRIBUTION', 'WARNING', 'declared-attribution', 'declared attribution');
}

function compareDeclared(findings, source, configuration, contract, field, kind, severity, idLabel, label) {
  const values = contract[field];
  if (values == null) return;
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.trim() === '')) {
    throw new TypeError(`protectionContract.${field} must contain non-empty text`);
  }
  values.forEach((raw, index) => {
    const text = normalize(raw);
    const sourceOffset = source.indexOf(text);
    if (sourceOffset < 0) {
      throw new TypeError(`protectionContract.${field} contains text absent from the canonical work`);
    }
    if (!configuration.includes(text)) {
      findings.push(finding(`literal.omitted:${idLabel}:${index + 1}`, kind, severity,
        span(source, sourceOffset, sourceOffset + text.length), null,
        `Configuration omits or changes a ${label}`));
    }
  });
}

function removeCoveredAttributionFindings(findings) {
  const declared = findings.filter(({ id }) => id.startsWith('literal.omitted:declared-attribution:'))
    .map(({ sourceSpan }) => sourceSpan);
  for (let index = findings.length - 1; index >= 0; index -= 1) {
    const candidate = findings[index];
    if (!candidate.id.startsWith('literal.omitted:attribution:')) continue;
    if (declared.some((span) => span.startOffset <= candidate.sourceSpan.startOffset
      && span.endOffset >= candidate.sourceSpan.endOffset)) findings.splice(index, 1);
  }
}

function findNewOutboundLinks(findings, source, configuration) {
  const canonical = new Set(links(source).map(({ target }) => target));
  let ordinal = 0;
  for (const link of links(configuration)) {
    if (!isOutbound(link.target) || canonical.has(link.target)) continue;
    ordinal += 1;
    findings.push(finding(`literal.new:outbound-link:${ordinal}`, 'OUTBOUND_LINK', 'BLOCKER', null,
      span(configuration, link.start, link.end),
      'Configuration introduces an outbound link absent from the canonical work'));
  }
}

function isOutbound(value) {
  try { return new URL(value).protocol !== ''; } catch { return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value); }
}

function compare(findings, source, configuration, canonical, kind, severity, label) {
  const available = new Map();
  for (const occurrence of canonical) {
    if (!available.has(occurrence.text)) available.set(occurrence.text, count(configuration, occurrence.text));
  }
  const consumed = new Map();
  canonical.forEach((occurrence, index) => {
    const used = (consumed.get(occurrence.text) ?? 0) + 1;
    consumed.set(occurrence.text, used);
    if (used <= available.get(occurrence.text)) return;
    findings.push(finding(`literal.omitted:${kind.toLowerCase().replaceAll('_', '-')}:${index + 1}`,
      kind, severity, span(source, occurrence.start, occurrence.end), null,
      `Configuration omits or changes a canonical ${label}`));
  });
}

function quotations(source) {
  const output = occurrences(source, patterns.blockQuote);
  for (const occurrence of occurrences(source, patterns.quoted)) {
    if (!output.some((existing) => overlaps(existing, occurrence))) output.push(occurrence);
  }
  return output.sort((left, right) => left.start - right.start);
}

function links(source) {
  return matches(source, patterns.link).map((match) => ({
    target: match[2], start: match.index, end: match.index + match[0].length
  }));
}

function occurrences(source, pattern) {
  return matches(source, pattern).map((match) => ({
    text: match[0], start: match.index, end: match.index + match[0].length
  }));
}

function matches(source, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...source.matchAll(new RegExp(pattern.source, flags))];
}

function addMatches(findings, configuration, pattern, id, kind, message, single = false) {
  const found = matches(configuration, pattern);
  for (let index = 0; index < found.length; index += 1) {
    const match = found[index];
    findings.push(finding(single ? id : `${id}:${index + 1}`, kind, 'BLOCKER', null,
      span(configuration, match.index, match.index + match[0].length), message));
    if (single) break;
  }
}

function finding(id, kind, severity, sourceSpan, configurationSpan, message) {
  return Object.freeze({ id, kind, severity, sourceSpan, configurationSpan, message });
}

function span(value, startOffset, endOffset) {
  const position = (offset) => {
    const before = value.slice(0, offset);
    const lines = before.split('\n');
    return { line: lines.length, column: lines.at(-1).length + 1 };
  };
  const start = position(startOffset);
  const end = position(endOffset);
  return Object.freeze({ startOffset, endOffset, startLine: start.line, startColumn: start.column,
    endLine: end.line, endColumn: end.column });
}

function count(value, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) >= 0) {
    total += 1;
    offset += Math.max(1, needle.length);
  }
  return total;
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function normalizeRequired(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return normalize(value);
}

function normalize(value) {
  const withoutBom = value.startsWith('\uFEFF') ? value.slice(1) : value;
  return withoutBom.replaceAll('\r\n', '\n').replaceAll('\r', '\n').normalize('NFC');
}
