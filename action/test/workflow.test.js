import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const pushScript = await readFile(new URL('../scripts/push.js', import.meta.url), 'utf8');
const pushScriptPath = fileURLToPath(new URL('../scripts/push.js', import.meta.url));
const rootPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const rootGitignore = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');

test('push validates, increments both release artifacts, commits all files, and dispatches tag creation', () => {
  assert.equal(rootPackage.scripts.push, 'node action/scripts/push.js');
  const install = pushScript.indexOf("[npmExecutable, '--prefix', '.', 'ci', '--ignore-scripts']");
  const firstValidation = pushScript.indexOf('validateRelease();');
  const versionWrite = pushScript.indexOf('validator.version = version');
  const bundle = pushScript.indexOf("'run', 'bundle:write']");
  const secondValidation = pushScript.lastIndexOf('validateRelease();');
  const add = pushScript.indexOf("['add', '.']");
  const commit = pushScript.indexOf("['commit', '-m', commitMessage]");
  const push = pushScript.indexOf("['push', 'origin', 'HEAD']");
  const dispatch = pushScript.indexOf("['workflow', 'run', 'release-validator.yml'");
  assert.ok([install, firstValidation, versionWrite, bundle, secondValidation, add, commit, push, dispatch]
    .every((index) => index >= 0));
  assert.ok(install < firstValidation);
  assert.ok(firstValidation < versionWrite);
  assert.ok(versionWrite < bundle);
  assert.ok(bundle < secondValidation);
  assert.ok(secondValidation < add);
  assert.ok(add < commit);
  assert.ok(commit < push);
  assert.ok(push < dispatch);
  assert.doesNotMatch(pushScript, /git', \['tag'/);
  assert.match(pushScript, /npmExecutable, '--prefix', 'v1\/validation', 'test'/);
  assert.match(pushScript, /'node', npmExecutable, '--prefix', 'action', 'run', 'bundle:check'/);
  assert.doesNotMatch(pushScript, /copyFileSync/);
  assert.match(rootGitignore, /^node_modules\/$/m);
  assert.match(pushScript, /originalBytes/);
  assert.match(pushScript, /catch \(error\)[\s\S]+writeFileSync\(file, bytes\)/);
});

test('push requires exactly one non-empty commit message before changing release state', () => {
  for (const args of [[], [''], ['one', 'two']]) {
    const result = spawnSync(process.execPath, [pushScriptPath, ...args], {
      encoding: 'utf8', shell: false
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: npm run push -- "commit message"/);
  }
});

const source = await readFile(
  new URL('../.github/workflows/publish.yml', import.meta.url),
  'utf8'
);
const release = await readFile(
  new URL('../.github/workflows/release-validator.yml', import.meta.url),
  'utf8'
);

test('reusable workflow exposes the closed public contract with one explicit secret', () => {
  for (const input of [
    'operation', 'mode', 'site-id', 'api-base-url', 'output-directory', 'timezone',
    'config-path', 'floor-guard-percent', 'floor-guard-pages', 'keepalive-threshold-days',
    'floor-guard-override-commit-sha', 'deployed-commit-sha', 'recorded-state-sha'
  ]) {
    assert.match(source, new RegExp(`^      ${input}:`, 'm'));
  }
  for (const output of [
    'outcome', 'published-count', 'republished-count', 'delisted-count', 'skipped-count',
    'days-since-last-commit', 'keepalive-committed', 'floor-guard-overridden',
    'floor-guard-override-reason', 'floor-guard-lost-pages', 'validator-version'
  ]) {
    assert.match(source, new RegExp(`^      ${output}:`, 'm'));
  }
  assert.match(source, /^      site-secret:\n        description:[^\n]+\n        required: true$/m);
  assert.doesNotMatch(source, /secrets:\s*inherit/);
});

test('workflow uses the published bundle and keeps deployment out of the signing action', () => {
  assert.equal((source.match(/uses: rathnasgala\/publish@v1/g) ?? []).length, 2);
  assert.doesNotMatch(source, /uses: \.\//);
  assert.match(source, /Publish the guarded artifact to gh-pages/);
  assert.match(source, /rsync -a --delete --exclude=\/\.git "\$output\/" "\$deploy_root\/"/);
  assert.doesNotMatch(source, /--exclude=\.git\//);
  assert.match(source, /git -C "\$deploy_root" push --force origin HEAD:refs\/heads\/gh-pages/);
  assert.match(source, /operation: acknowledge-deployment\n          mode: build-only/);
  assert.match(source, /ref: \$\{\{ inputs\.operation == 'acknowledge-deployment' && inputs\.recorded-state-sha/);
  assert.match(source, /deployed-commit-sha: \$\{\{ github\.sha \}\}/);
  assert.match(source, /recorded-state-sha: \$\{\{ github\.sha \}\}/);
});

test('state persistence is post-deployment, secret-blind, and preserves caller HEAD', () => {
  const persistence = source.slice(
    source.indexOf('- name: Record successful action-owned deployment'),
    source.indexOf('- name: Publish final run report')
  );
  assert.match(persistence, /steps\.acknowledge\.outcome == 'success'/);
  assert.match(persistence, /git commit-tree/);
  assert.match(persistence, /git push origin "\$commit:refs\/heads\/\$GALA_SOURCE_BRANCH"/);
  assert.match(persistence, /\.gala\/build\/deployment-stage\.json/);
  assert.match(persistence, /assignedContentIds/);
  assert.match(persistence, /createHash\('sha256'\)/);
  assert.match(persistence, /node - "\$stage" > "\$assigned_paths_file"/);
  assert.match(persistence, /mapfile -t assigned_paths < "\$assigned_paths_file"/);
  assert.doesNotMatch(persistence, /mapfile[^\n]+< <\(/);
  assert.match(persistence, /test "\$deployed_blob" = "\$parent_blob"/);
  assert.match(persistence, /git update-index --add --cacheinfo "100644,\$content_blob,\$content_path"/);
  assert.match(persistence, /\[skip ci\]/);
  assert.doesNotMatch(persistence, /site-secret|secrets\./);
  assert.doesNotMatch(persistence, /git (?:checkout|reset)/);
});

test('reporting is unconditional and partial results are not overwritten by a green step', () => {
  assert.match(source, /- name: Publish final run report\n        id: final\n        if: always\(\)/);
  assert.match(source, /SUCCESS\|PARTIAL\|FAILED\|NO_OP\|SKIPPED_STALE/);
  assert.match(source, /steps\.final\.outputs\.skipped-count != '0'/);
  assert.match(source, /exit 1/);
});

test('release publishes or integrity-verifies before atomically tagging the immutable version and v1 channel', () => {
  const publish = release.indexOf('Publish with OIDC provenance');
  const registryBuild = release.indexOf('Rebuild the action against the published validator');
  const tag = release.indexOf('Tag the verified release tree');
  assert.ok(publish > 0 && registryBuild > publish && tag > registryBuild);
  assert.match(release, /npm publish --workspace @rathnasgala\/content-validation --access public --provenance/);
  assert.match(release, /npm pack --workspace @rathnasgala\/content-validation --dry-run --json/);
  assert.match(release, /npm view "@rathnasgala\/content-validation@\$GALA_VERSION" dist\.integrity/);
  assert.match(release, /if \[ "\$published_integrity" != "\$local_integrity" \]/);
  assert.match(release, /Published validator integrity does not match the release tree/);
  assert.match(release, /^    environment: npm-validator-release$/m);
  assert.match(release, /Registry-backed bundle differs from action\/dist\/index\.js/);
  assert.match(release, /Registry-backed bundle differs from dist\/index\.js/);
  assert.match(release, /tail -n \+2 action\.yml \| cmp --silent action\/action\.yml -/);
  assert.match(release, /grep -Fqx '# Gala publish distribution' README\.md/);
  assert.match(release, /git tag -a "v\$GALA_VERSION"/);
  assert.match(release, /git tag -f v1 "\$GITHUB_SHA"/);
  assert.match(release, /git push --atomic origin "refs\/tags\/v\$GALA_VERSION" "\+refs\/tags\/v1"/);
});

test('all release-owned third-party actions are immutable commit pins', () => {
  for (const workflow of [source, release]) {
    assert.doesNotMatch(workflow, /uses: actions\/(?:checkout|setup-node)@v[0-9]+/);
    assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}/);
    assert.match(workflow, /uses: actions\/setup-node@[0-9a-f]{40}/);
  }
});
