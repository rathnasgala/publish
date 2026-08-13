import { createHash } from 'node:crypto';

export function markdownBodyHash(body) {
  if (typeof body !== 'string') throw new TypeError('Markdown body must be a string');
  const withoutBom = body.startsWith('\uFEFF') ? body.slice(1) : body;
  return createHash('sha256').update(withoutBom, 'utf8').digest('hex');
}
