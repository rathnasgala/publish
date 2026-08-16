import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

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

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w' });
}

function validateRelease({ checkBundle = true } = {}) {
  execute(process.execPath, [npmExecutable, '--prefix', 'v1/validation', 'test']);
  execute(process.execPath, [npmExecutable, '--prefix', 'action', 'test']);
  execute(process.execPath, [npmExecutable, '--prefix', 'v1/validation', 'run', 'lint']);
  execute(process.execPath, [npmExecutable, '--prefix', 'action', 'run', 'lint']);
  if (checkBundle) {
    execute(process.execPath, [npmExecutable, 'exec', '--yes', '--package=node@24', '--',
      'node', npmExecutable, '--prefix', 'action', 'run', 'bundle:check']);
  }
}

function installLockedDependencies() {
  execute(process.execPath, [npmExecutable, '--prefix', '.', 'ci', '--ignore-scripts']);
}

const branch = spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8', shell: false });
if (branch.error) throw branch.error;
if (branch.status !== 0) process.exit(branch.status ?? 1);
if (branch.stdout.trim() !== 'main') throw new Error('Publish releases must be created from main');

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
  'dist/index.js'
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
  validateRelease();
} catch (error) {
  for (const [file, bytes] of originalBytes) writeFileSync(file, bytes);
  throw error;
}

const commitMessage = messages[0].replaceAll('%s', version);
execute('git', ['add', '.']);
execute('git', ['commit', '-m', commitMessage]);
execute('git', ['push', 'origin', 'HEAD']);
execute('gh', ['workflow', 'run', 'release-validator.yml', '--repo', 'rathnasgala/publish',
  '--ref', 'main', '-f', `version=${version}`]);

// Publications resolve `publish.yml@v1`, not v${version}. Tagging a release therefore changes
// nothing for any writer until promote-v1 moves that alias, and promotion is a deliberate,
// canary-gated step. v1 sat on v0.0.3 through three releases because nobody was told this.
process.stdout.write([
  '',
  `Released v${version}. No publication uses it yet.`,
  '',
  'Every publication resolves publish.yml@v1. Promote once both canaries have deployed',
  `v${version} and you have their run IDs:`,
  '',
  '  gh run list --repo rathnasgala/smoke01 --workflow publish.yml --limit 5',
  '  gh run list --repo rathnasgala/smoke02 --workflow publish.yml --limit 5',
  '',
  '  gh workflow run promote-v1.yml --repo rathnasgala/publish \\',
  `    -f version=${version} -f smoke01-run-id=<id> -f smoke02-run-id=<id>`,
  '',
  '  gh api repos/rathnasgala/publish/tags --jq \'.[] | select(.name=="v1") | .commit.sha\'',
  '',
].join('\n'));
