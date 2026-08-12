import path from 'node:path';

export const ActionOutcome = Object.freeze({
  SUCCESS: 'SUCCESS',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  NO_OP: 'NO_OP',
  SKIPPED_STALE: 'SKIPPED_STALE'
});

const OPERATIONS = new Set(['build', 'acknowledge-deployment']);
const MODES = new Set(['build-only', 'build-and-deploy']);
const SHA = /^[0-9a-f]{40}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function required(getInput, name) {
  const value = getInput(name, { required: true });
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required`);
  return value.trim();
}

function integer(value, name, { minimum = 0 } = {}) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TypeError(`${name} must be at least ${minimum}`);
  }
  return parsed;
}

function timezone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
  } catch {
    throw new TypeError('timezone must be a valid IANA timezone');
  }
  return value;
}

export function parseActionInputs({ getInput, env = process.env, root = process.cwd() }) {
  const operation = required(getInput, 'operation');
  const mode = required(getInput, 'mode');
  if (!OPERATIONS.has(operation)) throw new TypeError(`Unsupported operation: ${operation}`);
  if (!MODES.has(mode)) throw new TypeError(`Unsupported mode: ${mode}`);
  if (operation === 'acknowledge-deployment' && mode !== 'build-only') {
    throw new TypeError('acknowledge-deployment requires mode build-only');
  }

  const deployedCommitSha = getInput('deployed-commit-sha').trim();
  const recordedStateSha = getInput('recorded-state-sha').trim();
  if (operation === 'acknowledge-deployment') {
    if (!SHA.test(deployedCommitSha) || !SHA.test(recordedStateSha)) {
      throw new TypeError(
        'deployed-commit-sha and recorded-state-sha are required lowercase commit SHAs'
      );
    }
  } else if (deployedCommitSha !== '' || recordedStateSha !== '') {
    throw new TypeError('deployment SHAs are accepted only for acknowledge-deployment');
  }
  const commitSha = operation === 'acknowledge-deployment' ? recordedStateSha : env.GITHUB_SHA;
  if (!SHA.test(commitSha ?? '')) throw new TypeError('GITHUB_SHA must be a lowercase commit SHA');

  const siteId = required(getInput, 'site-id');
  if (!ULID.test(siteId)) throw new TypeError('site-id must be a canonical ULID');
  const configPath = getInput('config-path').trim() || 'site.config.yml';
  if (path.isAbsolute(configPath) || configPath.split(/[\\/]/).includes('..')) {
    throw new TypeError('config-path must stay within the checkout');
  }
  const outputDirectory = required(getInput, 'output-directory');
  if (path.isAbsolute(outputDirectory) || outputDirectory === '.'
      || outputDirectory.split(/[\\/]/).includes('..')) {
    throw new TypeError('output-directory must be a child path within the checkout');
  }
  const floorGuardOverrideCommitSha = getInput('floor-guard-override-commit-sha').trim();
  if (floorGuardOverrideCommitSha !== '') {
    if (operation !== 'build' || mode !== 'build-and-deploy') {
      throw new TypeError('floor-guard override is accepted only for build-and-deploy');
    }
    if (!SHA.test(floorGuardOverrideCommitSha) || floorGuardOverrideCommitSha !== commitSha) {
      throw new TypeError('floor-guard override SHA must equal checkout HEAD');
    }
  }
  const keepaliveThresholdDays = integer(
    getInput('keepalive-threshold-days').trim() || '50',
    'keepalive-threshold-days',
    { minimum: 1 }
  );
  if (keepaliveThresholdDays >= 60) {
    throw new TypeError('keepalive-threshold-days must remain below 60');
  }

  return Object.freeze({
    operation,
    mode,
    root: path.resolve(root),
    commitSha,
    deployedCommitSha: deployedCommitSha || null,
    recordedStateSha: recordedStateSha || null,
    siteId,
    siteSecret: required(getInput, 'site-secret'),
    apiBaseUrl: required(getInput, 'api-base-url'),
    outputDirectory,
    timezone: timezone(required(getInput, 'timezone')),
    configPath,
    floorGuardPercent: integer(getInput('floor-guard-percent').trim() || '20', 'floor-guard-percent'),
    floorGuardPages: integer(getInput('floor-guard-pages').trim() || '25', 'floor-guard-pages'),
    keepaliveThresholdDays,
    floorGuardOverrideCommitSha: floorGuardOverrideCommitSha || null,
    runId: integer(required(getInput, 'run-id'), 'run-id', { minimum: 1 }),
    runAttempt: integer(required(getInput, 'run-attempt'), 'run-attempt', { minimum: 1 })
  });
}

export function publicOutputs(report, validatorVersion) {
  return Object.freeze({
    outcome: report.outcome,
    'published-count': report.publishedCount,
    'republished-count': report.republishedCount,
    'delisted-count': report.delistedCount,
    'skipped-count': report.skippedCount,
    'days-since-last-commit': report.daysSinceLastCommit,
    'keepalive-committed': report.keepaliveCommitted,
    'floor-guard-overridden': report.floorGuardOverridden,
    'floor-guard-override-reason': report.floorGuardOverrideReason ?? '',
    'floor-guard-lost-pages': report.floorGuardLostPages,
    'validator-version': validatorVersion
  });
}
