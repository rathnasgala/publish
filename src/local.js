import path from 'node:path';
import { createHostedAdapters } from './hosted.js';
import { runAction } from './orchestrator.js';

export async function runLocalFixture({ root, input, adapters = {} }) {
  const resolvedRoot = path.resolve(root);
  const now = adapters.now ?? (() => new Date());
  const hosted = createHostedAdapters({ now });
  return runAction({ ...input, root: resolvedRoot }, {
    ...hosted,
    currentCommitSha: async () => input.commitSha,
    verifyRecordedState: async () => {},
    keepalive: async () => ({ committed: false, daysSinceLastCommit: input.daysSinceLastCommit ?? 0 }),
    commitMessage: async () => '',
    previousPageCount: async () => null,
    currentPageCount: async (_input, manifest) => manifest.posts.length,
    stageDeployment: async () => {},
    report: async () => {},
    warn: () => {},
    now,
    ...adapters
  });
}
