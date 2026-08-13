import { spawn } from 'node:child_process';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const workspaceRoot = path.resolve(root, '..');
const validatorRoot = path.join(workspaceRoot, 'v1', 'validation');
const committed = await readFile(path.join(root, 'dist', 'index.js'));
const writeBundle = process.argv.slice(2).includes('--write');

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('Action bundle reproducibility must be checked with Node 24');
}

const temporary = await mkdtemp(path.join(tmpdir(), 'gala-action-bundle-'));

function execute(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

try {
  const packRoot = path.join(temporary, 'pack');
  const buildRoot = path.join(temporary, 'build');
  await mkdir(packRoot);
  await mkdir(buildRoot);
  await execute('npm', ['pack', '--pack-destination', packRoot], validatorRoot);
  const archives = (await readdir(packRoot)).filter((entry) => entry.endsWith('.tgz'));
  if (archives.length !== 1) {
    throw new Error(`Expected one validator package archive, found ${archives.length}`);
  }
  await cp(path.join(root, 'src'), path.join(buildRoot, 'src'), { recursive: true });
  const manifestPath = path.join(buildRoot, 'package.json');
  await copyFile(path.join(root, 'package.json'), manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies['@rathnasgala/content-validation'] = `file:${path.join(packRoot, archives[0])}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await execute('npm', ['install', '--ignore-scripts', '--package-lock-only'], buildRoot);
  await execute('npm', ['ci', '--ignore-scripts'], buildRoot);
  await execute('npm', ['run', 'bundle'], buildRoot);
  const rebuilt = await readFile(path.join(buildRoot, 'dist', 'index.js'));
  if (writeBundle) {
    await writeFile(path.join(root, 'dist', 'index.js'), rebuilt);
    await writeFile(path.join(workspaceRoot, 'dist', 'index.js'), rebuilt);
  } else if (!committed.equals(rebuilt)) {
    throw new Error('Committed dist/index.js differs from a clean lockfile-based rebuild');
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
