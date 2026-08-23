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

let latest;
try {
  latest = run('npm', ['view', `${name}@^${major}.0.0`, 'version', '--json']).trim();
} catch (error) {
  decline(`the registry could not be reached (${String(error.message).split('\n')[0]})`);
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
run('git', ['add', '--', MANIFEST, CONFIG, ...staged.map((file) => file.relative)]);
run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m',
  `Update the Gala framework to ${newest}\n\n`
  + 'Applied automatically by the publish workflow. Only files listed in\n'
  + '.gala/managed-files.json are touched; every one was verified against the\n'
  + `package's own hashes before it was written.\n\n`
  + 'Set the repository variable GALA_FRAMEWORK_AUTO_UPDATE to false to stop this.']);

say(`Framework updated to ${newest}.`);
