import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEngagementSnapshot } from './transport.js';
import { attributionTier } from './attribution.js';

import * as core from '@actions/core';
import {
  derivePublicationState,
  readPublicationState,
  regenerateBuildManifest,
  writePublicationState
} from '@rathnasgala/content-validation';

/**
 * Whether two publication states describe the same publication, ignoring the deployed stamp.
 *
 * Posts and retained Prism configuration descriptors carry publication meaning here;
 * `deployedCommitSha` only records which commit produced them.
 */
function samePublications(current, next) {
  if (current == null || typeof current.deployedCommitSha !== 'string') return false;
  return JSON.stringify(current.posts ?? []) === JSON.stringify(next.posts ?? [])
    && JSON.stringify(current.configurations ?? []) === JSON.stringify(next.configurations ?? []);
}

const STAGE_PATH = path.join('.gala', 'build', 'deployment-stage.json');
const NEXT_PUBLICATION_STATE_PATH = path.join('.gala', 'build', 'publication-state.yml');

function run(command, args, {
  cwd,
  env = process.env,
  allowFailure = false,
  trimOutput = true
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal != null) return reject(new Error(`${command} terminated by signal ${signal}`));
      if (code !== 0 && !allowFailure) {
        return reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
      }
      resolve({
        code,
        stdout: trimOutput ? stdout.trim() : stdout,
        stderr: trimOutput ? stderr.trim() : stderr
      });
    });
  });
}

const ASSIGNED_ID_TRAILER = /^Gala-Assigned-ID: ([0-7][0-9A-HJKMNP-TV-Z]{25}) (content\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/index\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.md)$/gm;

function assignedIdTrailers(message) {
  const assignments = new Map();
  for (const match of message.matchAll(ASSIGNED_ID_TRAILER)) {
    const [, id, source] = match;
    if (assignments.has(source)) throw new Error(`Duplicate assigned-ID trailer for ${source}`);
    assignments.set(source, id);
  }
  return assignments;
}

function deployedShaTrailer(message) {
  const matches = [...message.matchAll(/^Gala-Deployed-SHA: ([0-9a-f]{40})$/gm)];
  if (matches.length !== 1) throw new Error('Recorded state must contain exactly one deployed-SHA trailer');
  return matches[0][1];
}

function removeAssignedId(source, id, file) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(\\uFEFF?---(?:\\r\\n|\\n))id: ${escaped}(\\r?\\n)`);
  if (!pattern.test(source)) {
    throw new Error(`Recorded state does not add the manifest-bound ULID to ${file}`);
  }
  const withoutId = source.replace(pattern, '$1');
  if (withoutId.includes(`\nid: ${id}\n`) || withoutId.includes(`\r\nid: ${id}\r\n`)) {
    throw new Error(`Recorded state contains duplicate ULID fields in ${file}`);
  }
  return withoutId;
}

async function countHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new TypeError(`Build output contains a symbolic link: ${target}`);
    if (entry.isDirectory()) count += await countHtmlFiles(target);
    else if (entry.isFile() && entry.name.endsWith('.html')) count += 1;
  }
  return count;
}

async function readStage(root, commitSha) {
  try {
    const source = JSON.parse(await readFile(path.join(root, STAGE_PATH), 'utf8'));
    if (source.commitSha !== commitSha) {
      throw new Error(`Deployment stage belongs to ${source.commitSha}, expected ${commitSha}`);
    }
    return source;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function verifyManagedPrismCompiledOutput({ root, outputDirectory, manifest }) {
  const verifier = path.join(root, 'lib', 'prism-compiled-output.js');
  const metadata = await lstat(verifier);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError('Prism compiled-output verifier must be a regular managed file');
  }
  // This verifier belongs to the checked-out publication, not this bundled action. Keeping the
  // import native is required: ncc's module loader cannot resolve an external file:// URL.
  const module = await import(/* webpackIgnore: true */ pathToFileURL(verifier).href);
  if (typeof module.verifyPrismCompiledOutput !== 'function') {
    throw new TypeError('Managed Prism compiled-output verifier has no verifier export');
  }
  await module.verifyPrismCompiledOutput({ outputDirectory, manifest });
}

export function createHostedAdapters({
  env = process.env,
  now = () => new Date(),
  runCommand = run,
  summary = core.summary,
  fetchImpl = fetch,
  verifyCompiledOutput = verifyManagedPrismCompiledOutput
} = {}) {
  return {
    fetch: fetchImpl,
    now,
    currentCommitSha: async (root) => (
      await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout,
    commitMessage: async (sha, root = process.cwd()) => (
      await runCommand('git', ['show', '-s', '--format=%B', sha], { cwd: root })
    ).stdout,
    verifyRecordedState: async (input) => {
      if (input.recordedStateSha !== input.commitSha) {
        throw new Error('recorded-state-sha must identify checkout HEAD');
      }
      if (input.recordedStateSha === input.deployedCommitSha) return;
      const ancestry = await runCommand(
        'git', ['merge-base', '--is-ancestor', input.deployedCommitSha, input.recordedStateSha],
        { cwd: input.root, allowFailure: true }
      );
      if (ancestry.code !== 0) {
        throw new Error('Recorded state is not a descendant of the deployed commit');
      }
      const message = await runCommand(
        'git', ['show', '-s', '--format=%B', input.recordedStateSha], { cwd: input.root }
      );
      if (deployedShaTrailer(message.stdout) !== input.deployedCommitSha) {
        throw new Error('Recorded state trailer does not match the deployed commit');
      }
      const assignments = assignedIdTrailers(message.stdout);
      const changed = await runCommand('git', [
        'diff', '--name-only', '--no-renames',
        input.deployedCommitSha, input.recordedStateSha
      ], { cwd: input.root });
      const changedPaths = changed.stdout === '' ? [] : changed.stdout.split('\n');
      const expected = new Set(['.gala/publication-state.yml', ...assignments.keys()]);
      if (changedPaths.length !== expected.size
          || changedPaths.some((file) => !expected.has(file))) {
        throw new Error(
          'Recorded state may change only publication state and trailer-bound assigned-ID files'
        );
      }
      for (const [file, id] of assignments) {
        const [deployed, recorded] = await Promise.all([
          runCommand('git', ['show', `${input.deployedCommitSha}:${file}`], {
            cwd: input.root,
            trimOutput: false
          }),
          runCommand('git', ['show', `${input.recordedStateSha}:${file}`], {
            cwd: input.root,
            trimOutput: false
          })
        ]);
        if (removeAssignedId(recorded.stdout, id, file) !== deployed.stdout) {
          throw new Error(`Recorded state changed content other than the assigned ULID in ${file}`);
        }
      }
    },
    refreshEngagementSnapshot: async (input) => {
      const snapshot = await readEngagementSnapshot({
        apiBaseUrl: input.apiBaseUrl,
        siteId: input.siteId,
        siteSecret: input.siteSecret,
        runId: input.runId,
        runAttempt: input.runAttempt,
        emittedAt: now().toISOString(),
        fetchImpl
      });
      const target = path.join(input.root, '.engagement-snapshot.json');
      const next = `${JSON.stringify(snapshot, null, 2)}\n`;
      let current = null;
      try { current = await readFile(target, 'utf8'); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (current === next) return null;
      await atomicJson(target, snapshot);
      return createHash('sha256').update(next).digest('hex');
    },
    validateAndBuild: async (input) => {
      const resolvedAttributionTier = await attributionTier({
        root: input.root, siteId: input.siteId, now: now()
      });
      const generated = await regenerateBuildManifest({
        root: input.root,
        configPath: input.configPath,
        timezone: input.timezone,
        now: () => now().getTime(),
        siteId: input.siteId,
        currentSiteSecret: input.siteSecret,
        previousSiteSecret: input.previousSiteSecret
      });
      for (const result of generated.results) {
        for (const warning of result.warnings) core.warning(`${result.file}: ${warning}`);
        for (const error of result.errors) core.error(`${result.file}: ${error}`);
      }
      const output = path.resolve(input.root, input.outputDirectory);
      const relativeOutput = path.relative(input.root, output);
      if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput) || relativeOutput === '') {
        throw new TypeError('Resolved output directory must be a child of the checkout');
      }
      await rm(output, { recursive: true, force: true });
      const eleventy = path.join(input.root, 'node_modules', '@11ty', 'eleventy', 'cmd.cjs');
      const metadata = await lstat(eleventy);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new TypeError('Eleventy executable must be a regular dependency file');
      }
      await runCommand(process.execPath, [eleventy, `--output=${output}`], {
        cwd: input.root,
        env: {
          ...env,
          GALA_CONFIG_PATH: input.configPath,
          GALA_EVALUATION_DATE: generated.manifest.evaluationDate,
          GALA_BUILD_INSTANT: now().toISOString(),
          GALA_ATTRIBUTION_TIER: resolvedAttributionTier
        }
      });
      await verifyCompiledOutput({
        root: input.root,
        outputDirectory: output,
        manifest: generated.manifest
      });
      const deploymentStage = input.operation === 'acknowledge-deployment'
        ? await readStage(input.root, input.commitSha)
        : null;
      return {
        ...generated,
        skipped: generated.results.filter(({ errors }) => errors.length > 0).map(({ file, errors }) => ({
          source: path.relative(input.root, file).split(path.sep).join('/'), errors
        })),
        skippedCount: generated.results.filter(({ errors }) => errors.length > 0).length,
        currentPageCount: await countHtmlFiles(output),
        floorGuardOverride: deploymentStage?.floorGuardOverride ?? null,
        assignedContentIds: deploymentStage?.assignedContentIds
          ?? generated.manifest.assignedContentIds
          ?? []
      };
    },
    keepalive: async (input) => {
      const timestamp = Number((
        await runCommand('git', ['log', '-1', '--format=%ct'], { cwd: input.root })
      ).stdout);
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('Latest commit timestamp is invalid');
      const daysSinceLastCommit = Math.max(
        0,
        Math.floor((now().getTime() - timestamp * 1000) / 86_400_000)
      );
      if (daysSinceLastCommit < input.keepaliveThresholdDays) {
        return { committed: false, daysSinceLastCommit };
      }
      const branch = env.GITHUB_REF_NAME;
      if (typeof branch !== 'string' || branch === '' || branch.includes(':')) {
        throw new Error('GITHUB_REF_NAME is required for a keepalive push');
      }
      await runCommand('git', ['check-ref-format', '--branch', branch], { cwd: input.root });
      const identity = {
        ...env,
        GIT_AUTHOR_NAME: 'github-actions[bot]',
        GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'github-actions[bot]',
        GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com'
      };
      const commit = await runCommand('git', [
        'commit-tree', `${input.commitSha}^{tree}`, '-p', input.commitSha,
        '-m', 'chore: keep Gala publishing active'
      ], { cwd: input.root, env: identity });
      if (!/^[0-9a-f]{40}$/.test(commit.stdout)) {
        throw new Error('Git returned an invalid keepalive commit SHA');
      }
      await runCommand('git', ['push', 'origin', `${commit.stdout}:${branch}`], { cwd: input.root });
      return { committed: true, daysSinceLastCommit };
    },
    previousPageCount: async (input) => {
      const branch = await runCommand(
        'git',
        ['rev-parse', '--verify', 'refs/remotes/origin/gh-pages'],
        { cwd: input.root, allowFailure: true }
      );
      if (branch.code !== 0) return null;
      const tree = await runCommand(
        'git',
        ['ls-tree', '-r', '--name-only', 'refs/remotes/origin/gh-pages'],
        { cwd: input.root }
      );
      return tree.stdout.split('\n').filter((name) => name.endsWith('.html')).length;
    },
    currentPageCount: async (input) => countHtmlFiles(
      path.resolve(input.root, input.outputDirectory)
    ),
    stageDeployment: async (input, manifest, floorGuardOverride, engagementSnapshotHash = null) => {
      const current = await readPublicationState(input.root, { allowMissing: true });
      const derived = derivePublicationState({
        current,
        manifest,
        deployedOn: manifest.evaluationDate,
        deployedCommitSha: input.commitSha
      });
      // Keep the previous stamp when nothing about the publication changed.
      //
      // Advancing it unconditionally makes the recording commit its own cause: the stamp is the
      // only difference, so a commit is written, and that commit becomes the next run's HEAD,
      // guaranteeing the next run differs too. A daily schedule then produces a commit a day
      // forever on a site nobody is writing to. The stamp names the commit whose content was
      // deployed, and on an unchanged site that is still the older commit.
      const next = samePublications(current, derived)
        ? { ...derived, deployedCommitSha: current.deployedCommitSha }
        : derived;
      await writePublicationState(input.root, next, {
        relativePath: NEXT_PUBLICATION_STATE_PATH
      });
      await atomicJson(path.join(input.root, STAGE_PATH), {
        schemaVersion: 1,
        commitSha: input.commitSha,
        floorGuardOverride,
        engagementSnapshotHash,
        assignedContentIds: manifest.assignedContentIds ?? []
      });
    },
    report: async (report) => {
      summary
        .addHeading('Gala publishing')
        .addTable([
          [{ data: 'Outcome', header: true }, report.outcome],
          ['Skipped variants', String(report.skippedCount)],
          ['Published', String(report.publishedCount)],
          ['Republished', String(report.republishedCount)],
          ['Delisted', String(report.delistedCount)],
          ['Days since last commit', String(report.daysSinceLastCommit)],
          ['Keepalive committed', String(report.keepaliveCommitted)]
        ]);
      if (report.skipped.length > 0) {
        summary
          .addHeading('Skipped post variants', 2)
          .addTable([
            [{ data: 'File', header: true }, { data: 'Reason', header: true }],
            ...report.skipped.flatMap(({ source, errors }) =>
              errors.map((error) => [source, error])
            )
          ]);
      }
      if (report.themeAdvisory != null) {
        summary
          .addHeading('Theme security advisory', 2)
          .addTable([
            [{ data: 'Advisory', header: true }, report.themeAdvisory.id],
            ['Severity', report.themeAdvisory.severity],
            ['Installed version', report.themeAdvisory.installedVersion],
            ['Fixed version', report.themeAdvisory.fixedVersion]
          ])
          .addLink('Advisory details', report.themeAdvisory.url);
      }
      await summary.write();
    },
    warn: (code, error) => core.warning(`${code}: ${error instanceof Error ? error.message : error}`)
  };
}
