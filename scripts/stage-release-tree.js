import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const workspace = path.resolve(import.meta.dirname, '../..');
const destination = process.argv[2] == null ? null : path.resolve(process.argv[2]);

if (destination == null) {
  throw new Error('Usage: node action/scripts/stage-release-tree.js <empty-destination>');
}
if (destination === workspace || destination.startsWith(`${workspace}${path.sep}`)) {
  throw new Error('Release destination must be outside the source workspace');
}

async function requireEmptyDirectory(directory) {
  try {
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) throw new Error('Release destination is not a directory');
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
    if (entries.length !== 0) throw new Error('Release destination must be empty');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true });
  }
}

async function copy(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    dereference: false,
    filter: (candidate) => !candidate.split(path.sep).includes('node_modules')
  });
}

await requireEmptyDirectory(destination);

for (const relative of [
  'package.json',
  'package-lock.json',
  'action',
  'v1/validation',
  '.github/workflows/action-bundle.yml'
]) {
  await copy(path.join(workspace, relative), path.join(destination, relative));
}

await copy(
  path.join(workspace, 'action/action.yml'),
  path.join(destination, 'action.yml')
);
await copy(
  path.join(workspace, 'action/dist'),
  path.join(destination, 'dist')
);
await copy(
  path.join(workspace, 'action/.github/workflows/publish.yml'),
  path.join(destination, '.github/workflows/publish.yml')
);
await copy(
  path.join(workspace, 'action/.github/workflows/release-validator.yml'),
  path.join(destination, '.github/workflows/release-validator.yml')
);

const [sourceAction, releasedAction, sourceBundle, releasedBundle] = await Promise.all([
  readFile(path.join(workspace, 'action/action.yml')),
  readFile(path.join(destination, 'action.yml')),
  readFile(path.join(workspace, 'action/dist/index.js')),
  readFile(path.join(destination, 'dist/index.js'))
]);
if (!sourceAction.equals(releasedAction) || !sourceBundle.equals(releasedBundle)) {
  await rm(destination, { recursive: true, force: true });
  throw new Error('Staged runtime bytes differ from the verified action source');
}
