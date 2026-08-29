import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('npm package explains its role and points developers to Gala', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

  assert.match(readme, /@rathnasgala\/content-validation/);
  assert.match(readme, /https:\/\/gala67\.com/);
  assert.match(readme, /npx --yes @rathnasgala\/cli@latest init field-notes/);
});
