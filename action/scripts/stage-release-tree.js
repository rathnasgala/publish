import { cp, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const workspace = path.resolve(import.meta.dirname, '../..');
const destination = process.argv[2] == null ? null : path.resolve(process.argv[2]);

if (destination == null) {
  throw new Error('Usage: node action/scripts/stage-release-tree.js <empty-destination>');
}
async function canonicalProspectivePath(target) {
  const suffix = [];
  let ancestor = target;
  while (true) {
    try {
      const metadata = await lstat(ancestor);
      if (ancestor === target && metadata.isSymbolicLink()) {
        throw new Error('Release destination must not be a symbolic link');
      }
      return path.join(await realpath(ancestor), ...suffix);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

const canonicalWorkspace = await realpath(workspace);
const canonicalDestination = await canonicalProspectivePath(destination);
const workspaceRelative = path.relative(canonicalWorkspace, canonicalDestination);
if (workspaceRelative === ''
    || (!workspaceRelative.startsWith(`..${path.sep}`)
      && workspaceRelative !== '..'
      && !path.isAbsolute(workspaceRelative))) {
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
    filter: (candidate) => {
      const segments = candidate.split(path.sep);
      return !segments.includes('node_modules') && !segments.includes('.git');
    }
  });
}

async function generatedYaml(source, target) {
  const content = await readFile(source, 'utf8');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `# GENERATED DISTRIBUTION COPY - edit the monorepo source, not this file.\n${content}`);
}

async function generatedWorkspaceManifests() {
  const packageJson = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8'));
  packageJson.workspaces = ['action', 'v1/validation'];
  await writeFile(
    path.join(destination, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`
  );
  const packageLock = JSON.parse(await readFile(path.join(workspace, 'package-lock.json'), 'utf8'));
  packageLock.packages[''].workspaces = ['action', 'v1/validation'];
  delete packageLock.packages.cli;
  delete packageLock.packages['node_modules/@rathnasgala/cli'];
  await writeFile(
    path.join(destination, 'package-lock.json'),
    `${JSON.stringify(packageLock, null, 2)}\n`
  );
}

await requireEmptyDirectory(destination);

for (const relative of [
  'action',
  'v1/validation',
  '.github/workflows/action-bundle.yml'
]) {
  await copy(path.join(workspace, relative), path.join(destination, relative));
}
await generatedWorkspaceManifests();

await copy(
  path.join(workspace, 'action/RELEASE_README.md'),
  path.join(destination, 'README.md')
);
await generatedYaml(path.join(workspace, 'action/action.yml'), path.join(destination, 'action.yml'));
await copy(
  path.join(workspace, 'action/dist'),
  path.join(destination, 'dist')
);
await generatedYaml(
  path.join(workspace, 'action/.github/workflows/publish.yml'),
  path.join(destination, '.github/workflows/publish.yml')
);
await generatedYaml(
  path.join(workspace, 'action/.github/workflows/release-validator.yml'),
  path.join(destination, '.github/workflows/release-validator.yml')
);
await generatedYaml(
  path.join(workspace, 'action/.github/workflows/promote-v1.yml'),
  path.join(destination, '.github/workflows/promote-v1.yml')
);

const [sourceAction, releasedAction, sourceBundle, releasedBundle] = await Promise.all([
  readFile(path.join(workspace, 'action/action.yml')),
  readFile(path.join(destination, 'action.yml')),
  readFile(path.join(workspace, 'action/dist/index.js')),
  readFile(path.join(destination, 'dist/index.js'))
]);
const generatedHeader = Buffer.from('# GENERATED DISTRIBUTION COPY - edit the monorepo source, not this file.\n');
if (!releasedAction.subarray(generatedHeader.length).equals(sourceAction)
    || !releasedAction.subarray(0, generatedHeader.length).equals(generatedHeader)
    || !sourceBundle.equals(releasedBundle)) {
  await rm(destination, { recursive: true, force: true });
  throw new Error('Staged runtime bytes differ from the verified action source');
}
