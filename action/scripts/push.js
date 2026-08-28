import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const REPOSITORY = 'rathnasgala/publish';
const GENERATED_HEADER = '# GENERATED DISTRIBUTION COPY — edit the monorepo source, not this file.\n';
const DISTRIBUTION_FILES = [
  ['action/action.yml', 'action.yml', true],
  ['action/.github/workflows/publish.yml', '.github/workflows/publish.yml', true],
  ['action/.github/workflows/release-validator.yml', '.github/workflows/release-validator.yml', true],
  ['action/.github/workflows/promote-v1.yml', '.github/workflows/promote-v1.yml', true],
  ['action/RELEASE_README.md', 'README.md', false],
  ['action/dist/index.js', 'dist/index.js', false],
  ['action/dist/package.json', 'dist/package.json', false],
];

const messages = process.argv.slice(2);
if (messages.length !== 1 || messages[0].trim() === '') {
  throw new Error('Usage: npm run push -- "commit message"');
}

const npmExecutable = process.env.npm_execpath;
if (npmExecutable == null || npmExecutable.trim() === '') {
  throw new Error('npm run push must be invoked through npm');
}

function execute(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? 1}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} exited with ${result.status ?? 1}`);
  }
  return result.stdout.trim();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w' });
}

function validateRelease({ checkBundle = true, checkDistribution = true } = {}) {
  execute(process.execPath, [npmExecutable, '--prefix', 'v1/validation', 'test']);
  execute(process.execPath, [npmExecutable, '--prefix', 'action', 'test']);
  execute(process.execPath, [npmExecutable, '--prefix', 'v1/validation', 'run', 'lint']);
  execute(process.execPath, [npmExecutable, '--prefix', 'action', 'run', 'lint']);
  if (checkBundle) {
    execute(process.execPath, [npmExecutable, 'exec', '--yes', '--package=node@24', '--',
      'node', npmExecutable, '--prefix', 'action', 'run', 'bundle:check']);
  }
  if (checkDistribution) {
    for (const [source, destination, generated] of DISTRIBUTION_FILES) {
      const expected = `${generated ? GENERATED_HEADER : ''}${readFileSync(source, 'utf8')}`;
      if (readFileSync(destination, 'utf8') !== expected) {
        throw new Error(`Generated distribution file is stale: ${destination}`);
      }
    }
  }
}

function synchronizeDistribution() {
  for (const [source, destination, generated] of DISTRIBUTION_FILES) {
    const content = `${generated ? GENERATED_HEADER : ''}${readFileSync(source, 'utf8')}`;
    writeFileSync(destination, content);
  }
}

async function waitForReleaseRun(commitSha) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const runId = capture('gh', ['run', 'list', '--repo', REPOSITORY,
      '--workflow', 'release-validator.yml', '--event', 'workflow_dispatch',
      '--commit', commitSha, '--limit', '1', '--json', 'databaseId',
      '--jq', '.[0].databaseId']);
    if (/^[1-9][0-9]*$/.test(runId)) return runId;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Release workflow did not appear for commit ${commitSha}`);
}

function verifyReleasedRefs(version, releaseCommitSha) {
  const immutableCommit = capture('gh', ['api',
    `repos/${REPOSITORY}/commits/v${version}`, '--jq', '.sha']);
  if (immutableCommit !== releaseCommitSha) {
    throw new Error(`Released v${version} does not resolve to commit ${releaseCommitSha}`);
  }
  const channelCommit = capture('gh', ['api', `repos/${REPOSITORY}/commits/v1`, '--jq', '.sha']);
  if (channelCommit !== releaseCommitSha) {
    throw new Error(`Released v1 does not resolve to commit ${releaseCommitSha}`);
  }
}

function installLockedDependencies() {
  execute(process.execPath, [npmExecutable, '--prefix', '.', 'ci', '--ignore-scripts']);
}

const branch = spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8', shell: false });
if (branch.error) throw branch.error;
if (branch.status !== 0) process.exit(branch.status ?? 1);
if (branch.stdout.trim() !== 'main') throw new Error('Publish releases must be created from main');

synchronizeDistribution();
installLockedDependencies();
validateRelease({ checkBundle: false });

const validatorPath = 'v1/validation/package.json';
const actionPath = 'action/package.json';
const validator = readJson(validatorPath);
const action = readJson(actionPath);
if (validator.version !== action.version
    || action.dependencies?.['@rathnasgala/content-validation'] !== validator.version) {
  throw new Error('Validator, action, and bundled validator dependency versions must match');
}
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(validator.version);
if (match == null) throw new Error('Release version must be canonical SemVer');
const version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
const generatedPaths = [
  validatorPath,
  actionPath,
  'package-lock.json',
  'action/dist/index.js',
  'dist/index.js',
  'dist/package.json',
  'action.yml',
  '.github/workflows/publish.yml',
  '.github/workflows/release-validator.yml',
  '.github/workflows/promote-v1.yml',
  'README.md'
];
const originalBytes = new Map(generatedPaths.map((file) => [file, readFileSync(file)]));

try {
  validator.version = version;
  action.version = version;
  action.dependencies['@rathnasgala/content-validation'] = version;
  writeJson(validatorPath, validator);
  writeJson(actionPath, action);

  execute(process.execPath, [npmExecutable, '--prefix', '.', 'install',
    '--package-lock-only', '--ignore-scripts']);
  execute(process.execPath, [npmExecutable, 'exec', '--yes', '--package=node@24', '--',
    'node', npmExecutable, '--prefix', 'action', 'run', 'bundle:write']);
  synchronizeDistribution();
  validateRelease();
} catch (error) {
  for (const [file, bytes] of originalBytes) writeFileSync(file, bytes);
  throw error;
}

const commitMessage = messages[0].replaceAll('%s', version);
execute('git', ['add', '.']);
execute('git', ['commit', '-m', commitMessage]);
execute('git', ['push', 'origin', 'HEAD']);
const releaseCommitSha = capture('git', ['rev-parse', 'HEAD']);
execute('gh', ['workflow', 'run', 'release-validator.yml', '--repo', 'rathnasgala/publish',
  '--ref', 'main', '-f', `version=${version}`]);
const releaseRunId = await waitForReleaseRun(releaseCommitSha);
execute('gh', ['run', 'watch', releaseRunId, '--repo', REPOSITORY, '--exit-status']);
verifyReleasedRefs(version, releaseCommitSha);
process.stdout.write(`Released v${version}; v1 now resolves to ${releaseCommitSha}.\n`);
