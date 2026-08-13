const TRAILER = /^Gala-Floor-Override:[ \t]+(.\S|\S.*)$/im;

export function floorOverrideReason(commitMessage) {
  if (typeof commitMessage !== 'string') throw new TypeError('commit message must be a string');
  const matches = [...commitMessage.matchAll(new RegExp(TRAILER.source, 'gim'))];
  if (matches.length > 1) throw new TypeError('commit must contain at most one Gala-Floor-Override trailer');
  return matches[0]?.[1].trim() ?? null;
}

export function evaluateDeployFloor({
  previousPageCount,
  currentPageCount,
  percent = 20,
  pages = 25,
  overrideReason = null,
  skipped = []
}) {
  for (const [name, value] of Object.entries({ currentPageCount, percent, pages })) {
    if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  }
  if (previousPageCount == null) {
    return Object.freeze({ exempt: true, overridden: false, allowed: true, lostPages: 0 });
  }
  if (!Number.isInteger(previousPageCount) || previousPageCount < 0) {
    throw new TypeError('previousPageCount must be a non-negative integer or null');
  }
  const lostPages = Math.max(0, previousPageCount - currentPageCount);
  const percentLimit = Math.ceil(previousPageCount * percent / 100);
  const permittedLoss = Math.min(percentLimit, pages);
  const tripped = lostPages >= permittedLoss && lostPages > 0;
  const magnitude = Object.freeze({ previousPageCount, currentPageCount, lostPages, permittedLoss });
  if (!tripped) return Object.freeze({ ...magnitude, exempt: false, overridden: false, allowed: true });
  if (overrideReason != null) {
    if (typeof overrideReason !== 'string' || overrideReason.trim() === ''
        || overrideReason.trim().length > 500) {
      throw new TypeError('floor override reason must contain 1 to 500 characters');
    }
    return Object.freeze({
      ...magnitude,
      exempt: false,
      overridden: true,
      allowed: true,
      reason: overrideReason.trim()
    });
  }
  const skippedDetails = skipped.map(({ source, errors }) =>
    `${source}: ${Array.isArray(errors) ? errors.join('; ') : errors}`
  );
  const detail = skippedDetails.length === 0 ? '' : ` Skipped posts: ${skippedDetails.join(' | ')}`;
  throw new Error(
    `Deployment aborted: ${lostPages} of ${previousPageCount} pages missing `
    + `(current ${currentPageCount}; limit ${permittedLoss}).${detail}`
  );
}
