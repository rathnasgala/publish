import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAction } from './orchestrator.js';

export async function runLocalFixture({ root, input, adapters = {} }) {
  const resolvedRoot = path.resolve(root);
  return runAction({ ...input, root: resolvedRoot }, {
    currentCommitSha: async () => input.commitSha,
    verifyRecordedState: async () => {},
    validateAndBuild: async () => JSON.parse(await readFile(
      path.join(resolvedRoot, '.gala', 'build', 'validated-posts.json'),
      'utf8'
    )),
    keepalive: async () => ({ committed: false, daysSinceLastCommit: input.daysSinceLastCommit ?? 0 }),
    commitMessage: async () => '',
    previousPageCount: async () => null,
    currentPageCount: async (_input, manifest) => manifest.posts.length,
    stageDeployment: async () => {},
    report: async () => {},
    warn: () => {},
    now: () => new Date(),
    ...adapters
  });
}
