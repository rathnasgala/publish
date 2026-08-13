import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const ncc = require.resolve('@vercel/ncc/dist/ncc/cli.js');
const committed = await readFile(path.join(root, 'dist', 'index.js'));
const temporary = await mkdtemp(path.join(tmpdir(), 'gala-action-bundle-'));

function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

try {
  await execute(process.execPath, [
    ncc, 'build', 'src/index.js', '-o', temporary, '--minify'
  ]);
  const rebuilt = await readFile(path.join(temporary, 'index.js'));
  if (!committed.equals(rebuilt)) {
    throw new Error('Committed dist/index.js differs from a clean lockfile-based rebuild');
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
