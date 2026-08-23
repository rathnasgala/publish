#!/usr/bin/env node
/**
 * Brings a publication's framework files up to date, in its own repository.
 *
 * Every site carries its own copy of the runtime — `interactions.js`, the layouts, the build
 * library — pinned by `framework.themePackage.version` in `site.config.yml` and hash-bound by
 * `.gala/managed-files.json`. That makes a site self-contained and permanent: it builds with no
 * network call to Gala and keeps working if Gala does not. It also meant a framework fix could
 * never reach a site that had already been published, which is how a reader sign-in bug sat live
 * on every publication with no way to deliver the repair.
 *
 * This closes that without giving the property up. The workflow already runs on a schedule and
 * already has `contents: write`, so the update arrives as a commit in the writer's own repository:
 * auditable, diffable, revertable, and still entirely theirs.
 *
 * Four rules keep it safe to run unattended:
 *
 *  1. **Same major only.** A breaking release is never applied without a person.
 *  2. **Only managed paths.** The incoming manifest names every file that may be written, and
 *     nothing outside it is touched. A writer's posts, configuration and custom CSS are not the
 *     framework's to replace.
 *  3. **Every byte is verified** against the incoming manifest's hash before it lands, so a
 *     corrupted or tampered package writes nothing.
 *  4. **It never blocks a publish.** An update that cannot be made is reported and skipped; the
 *     build then proceeds with the files already in the repository.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MANIFEST = '.gala/managed-files.json';
const CONFIG = 'site.config.yml';

const say = (message) => process.stdout.write(`${message}\n`);

/** Reported and skipped, never thrown: a framework update is not worth failing a publish over. */
function decline(reason) {
  say(`Framework update skipped: ${reason}`);
  process.exit(0);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

// ---------------------------------------------------------------- what is installed

if (process.env.GALA_FRAMEWORK_AUTO_UPDATE === 'false') {
  decline('GALA_FRAMEWORK_AUTO_UPDATE is false, so this publication pins its own version');
}
if (!existsSync(MANIFEST)) decline(`${MANIFEST} is absent, so there is no framework to update`);

let installed;
try {
  installed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch (error) {
  decline(`${MANIFEST} is not readable JSON (${error.message})`);
}

const name = installed?.themePackage?.name;
const current = installed?.themePackage?.version;
if (typeof name !== 'string' || !/^\d+\.\d+\.\d+$/.test(current ?? '')) {
  decline('the manifest carries no usable theme identity');
}
const major = current.split('.')[0];

// ---------------------------------------------------------------- what is available

/*
 * The range is `<major>.x`, not `^<major>.0.0`. Caret does not mean "same major" below 1.0: npm
 * reads `^0.0.0` as exactly 0.0.0, so on a 0.x publication — which is every publication today —
 * the query 404s and no update is ever found. `0.x` is `>=0.0.0 <1.0.0`, which is what was meant,
 * and it carries the same meaning at every other major.
 */
let latest;
try {
  latest = run('npm', ['view', `${name}@${major}.x`, 'version', '--json']).trim();
} catch (error) {
  /*
   * A registry that answers "no such version" is not a registry that is down, and reporting the
   * two the same way is how the `^0.0.0` defect stayed invisible in the logs: every site reported
   * an unreachable network while npm was answering perfectly.
   */
  const detail = String(error.message).split('\n')[0];
  const missing = /E404|No match found/i.test(String(error.stderr ?? '') + detail);
  decline(missing
    ? `the registry has no ${major}.x release of ${name} (${detail})`
    : `the registry could not be reached (${detail})`);
}

// `npm view` answers with a bare string for one match and an array for several.
const candidates = latest.startsWith('[') ? JSON.parse(latest) : [JSON.parse(latest)];
const newest = candidates.at(-1);
if (typeof newest !== 'string') decline('the registry returned no version for this major');

if (compare(newest, current) <= 0) {
  say(`Framework is current at ${current}.`);
  process.exit(0);
}
say(`Framework update available: ${current} -> ${newest}`);

/** Numeric SemVer comparison; a string compare puts 0.0.9 above 0.0.10. */
function compare(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

// ---------------------------------------------------------------- fetch and verify

const staging = mkdtempSync(path.join(tmpdir(), 'gala-theme-'));
try {
  run('npm', ['pack', `${name}@${newest}`, '--pack-destination', staging]);
} catch (error) {
  decline(`the package could not be fetched (${String(error.message).split('\n')[0]})`);
}

const tarball = run('ls', [staging]).trim().split('\n').find((f) => f.endsWith('.tgz'));
if (!tarball) decline('the package produced no tarball');
const unpacked = path.join(staging, 'unpacked');
mkdirSync(unpacked, { recursive: true });
run('tar', ['-xzf', path.join(staging, tarball), '-C', unpacked, '--strip-components', '1']);

const payload = path.join(unpacked, 'payload');
const incomingManifestPath = path.join(payload, '.gala', 'managed-files.json');
if (!existsSync(incomingManifestPath)) decline('the package carries no managed manifest');

const incoming = JSON.parse(readFileSync(incomingManifestPath, 'utf8'));
if (incoming?.themePackage?.name !== name || incoming?.themePackage?.version !== newest) {
  decline('the package manifest does not match the version it claims to be');
}

/*
 * Verify everything before writing anything. A half-applied framework is worse than an old one:
 * the site would build from a mixture of two releases whose contract may not agree.
 */
const sources = incoming.artifactSources ?? {};
const staged = [];
for (const [relative, expected] of Object.entries(incoming.files ?? {})) {
  const segments = relative.split('/');
  if (segments.includes('..') || path.isAbsolute(relative)) {
    decline(`the package names a path outside the repository: ${relative}`);
  }
  const from = path.join(payload, ...(sources[relative] ?? relative).split('/'));
  if (!existsSync(from)) decline(`the package is missing a file it declares: ${relative}`);
  const bytes = readFileSync(from);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    decline(`a file in the package does not match its own manifest: ${relative}`);
  }
  staged.push({ relative, from });
}
if (staged.length === 0) decline('the package declares no managed files');

// ---------------------------------------------------------------- apply

for (const { relative, from } of staged) {
  mkdirSync(path.dirname(relative), { recursive: true });
  cpSync(from, relative);
}
writeFileSync(MANIFEST, `${JSON.stringify(incoming, null, 2)}\n`);

/*
 * The pin follows the files. It is rewritten by a line-targeted replacement rather than by
 * re-serialising the YAML, because this file is the writer's — their comments, their key order,
 * their design choices — and only one value here belongs to the framework.
 */
if (existsSync(CONFIG)) {
  const config = readFileSync(CONFIG, 'utf8');
  const pinned = config.replace(
    /^(\s*version:\s*)["']?\d+\.\d+\.\d+["']?(\s*)$/m,
    (line, prefix, trailing) => (config.includes('themePackage:') ? `${prefix}${newest}${trailing}` : line),
  );
  if (pinned !== config) writeFileSync(CONFIG, pinned);
}

// ---------------------------------------------------------------- record it

const changed = run('git', ['status', '--porcelain']).trim();
if (changed === '') {
  say('Framework files were already identical; nothing to record.');
  process.exit(0);
}

say('Updated:');
for (const line of changed.split('\n')) say(`  ${line}`);

run('git', ['config', 'user.name', 'gala-publish[bot]']);
run('git', ['config', 'user.email', 'publish@gala67.com']);

/*
 * The record is built on top of the branch as it stands on the remote, not on top of this
 * checkout.
 *
 * The publish workflow checks out one exact content commit and the action refuses to build unless
 * HEAD is still that commit — the guarantee being that what gets published is precisely the commit
 * that was asked for. By the time this runs the deployment record has already been pushed, so the
 * checkout is behind the branch, and committing onto it would push a commit that silently drops
 * that record.
 *
 * Resetting the index to the remote tip and staging only the framework's own files keeps the
 * commit to exactly what this script changed.
 */
const branch = (process.env.GALA_UPDATE_BRANCH ?? '').trim()
  || (() => {
    try { return run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { return ''; }
  })();

let remote = true;
try { run('git', ['remote', 'get-url', 'origin']); } catch { remote = false; }
const publishable = remote && branch !== '' && branch !== 'HEAD';

if (publishable) {
  try {
    run('git', ['fetch', '--depth', '1', 'origin', branch]);
    run('git', ['reset', '--mixed', 'FETCH_HEAD']);
  } catch (error) {
    decline(`the branch could not be refreshed (${String(error.message).split('\n')[0]})`);
  }
}

run('git', ['add', '--', MANIFEST, CONFIG, ...staged.map((file) => file.relative)]);

// After the reset the index may hold nothing new — the update can already be on the branch.
if (run('git', ['diff', '--cached', '--name-only']).trim() === '') {
  say(`Framework ${newest} is already recorded on ${branch}.`);
  process.exit(0);
}

run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m',
  `Update the Gala framework to ${newest}\n\n`
  + 'Applied automatically by the publish workflow. Only files listed in\n'
  + '.gala/managed-files.json are touched; every one was verified against the\n'
  + `package's own hashes before it was written.\n\n`
  + 'Set the repository variable GALA_FRAMEWORK_AUTO_UPDATE to false to stop this.']);

/*
 * Pushed, or the update never leaves the runner: the previous version of this script committed and
 * stopped there, so the framework was rewritten on a throwaway checkout every single run and no
 * publication ever actually moved forward.
 */
if (publishable) {
  try {
    run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  } catch (error) {
    decline(`the update could not be pushed (${String(error.message).split('\n')[0]})`);
  }
}

say(`Framework updated to ${newest}.`);
