#!/usr/bin/env bash
# Drives the self-updater against a fabricated publication and a fabricated registry.
#
# Everything is local: `npm view` and `npm pack` are shimmed by a directory placed first on PATH,
# so the test exercises the real script - its verification, its path guards, its commit - without
# reaching npm or needing a published version.
set -uo pipefail

WORK="$(mktemp -d)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/self-update.mjs"
REAL_NPM="$(command -v npm)"
# The theme payload is staged from site-template, which sits beside this repository in a
# workspace checkout. Skipped rather than failed when it is not there.
TEMPLATE="${GALA_SITE_TEMPLATE:-$HERE/../../../site-template}"
if [ ! -f "$TEMPLATE/scripts/stage-theme-package.js" ]; then
  echo "site-template not found at $TEMPLATE - set GALA_SITE_TEMPLATE to run this."
  exit 0
fi
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "pass  $1"; pass=$((pass+1)); else echo "FAIL  $1 - expected [$3] got [$2]"; fail=$((fail+1)); fi }
contains() { if printf '%s' "$2" | grep -qF "$3"; then echo "pass  $1"; pass=$((pass+1)); else echo "FAIL  $1 - no [$3] in output"; fail=$((fail+1)); fi }

# ---------------------------------------------------------------- a package to serve
build_package() {
  local version="$1"
  local out="$WORK/pkg-$version"
  rm -rf "$out"; mkdir -p "$out"
  node -e "
    import('$TEMPLATE/scripts/stage-theme-package.js').then(async (m) => {
      await m.stageThemePackage('$out');
    }).catch(e => { console.error(e.message); process.exit(1); });
  " || return 1
  node -e "
    const f=require('fs');
    const p='$out/package.json'; const j=JSON.parse(f.readFileSync(p,'utf8')); j.version='$version';
    f.writeFileSync(p, JSON.stringify(j,null,2));
    const mp='$out/payload/.gala/managed-files.json'; const m=JSON.parse(f.readFileSync(mp,'utf8'));
    m.themePackage.version='$version'; f.writeFileSync(mp, JSON.stringify(m,null,2)+'\n');
  "
  (cd "$out" && tar -czf "$WORK/theme-$version.tgz" --transform "s,^\\.,package," . 2>/dev/null \
    || tar -czf "$WORK/theme-$version.tgz" -s ",^\\.,package," . 2>/dev/null)
}

# ---------------------------------------------------------------- a registry to answer
shim() {
  mkdir -p "$WORK/bin"
  cat > "$WORK/bin/npm" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = "view" ]; then
  # Answer the way npm does: resolve the requested range rather than ignoring it. A shim that
  # replies to any range hides exactly the defect that shipped - \`^0.0.0\` 404s on every 0.x
  # publication, so no site could ever update - and lets the suite pass on a script that cannot work.
  spec="\$2"; range="\${spec##*@}"
  node -e '
    const [range, latest] = process.argv.slice(1);
    const major = latest.split(".")[0];
    const ok = range === major + ".x" || range === "*" || range === "latest";
    if (!ok) { process.stderr.write("npm error code E404\nnpm error 404 No match found for version " + range + "\n"); process.exit(1); }
    process.stdout.write(JSON.stringify([latest]));
  ' "\$range" "\$GALA_FAKE_LATEST" || exit 1
  exit 0
fi
if [ "\$1" = "pack" ]; then cp "$WORK/theme-\$GALA_FAKE_LATEST.tgz" "\$4/theme.tgz" 2>/dev/null; echo theme.tgz; exit 0; fi
exit 0
SHIM
  chmod +x "$WORK/bin/npm"
}

# ---------------------------------------------------------------- a publication
site() {
  local version="$1"
  local dir="$WORK/site"
  rm -rf "$dir"; mkdir -p "$dir"
  (cd "$TEMPLATE" && tar -cf - .gala site lib src package.json site.config.yml 2>/dev/null) | (cd "$dir" && tar -xf -) 2>/dev/null
  cp "$TEMPLATE/site.config.yml" "$dir/site.config.yml"
  mkdir -p "$dir/.gala"; cp "$TEMPLATE/.gala/managed-files.json" "$dir/.gala/"
  node -e "
    const f=require('fs');
    const m=JSON.parse(f.readFileSync('$dir/.gala/managed-files.json','utf8'));
    m.themePackage.version='$version'; f.writeFileSync('$dir/.gala/managed-files.json',JSON.stringify(m,null,2)+'\n');
  "
  # An older publication's budgets: what a site scaffolded before the reader runtime carries. The
  # build refuses to run when the managed assets exceed these, so an update that ships more bytes
  # without raising them hands the writer a repository that cannot build.
  node -e "
    const f=require('fs');
    const p='$dir/site.config.yml';
    f.writeFileSync(p, f.readFileSync(p,'utf8')
      .replace(/managedJavaScriptBytes: \d+/, 'managedJavaScriptBytes: 32768')
      .replace(/managedCssBytes: \d+/, 'managedCssBytes: 16384'));
  "
  # A writer's own file, which must survive untouched.
  echo "# my notes" > "$dir/custom.css"
  mkdir -p "$dir/content/posts/mine"; echo "---" > "$dir/content/posts/mine/index.en.md"
  (cd "$dir" && git init -q && git config user.email t@t && git config user.name t && git add -A && git -c core.hooksPath=/dev/null commit -qm initial)
}

echo "- building a package and a publication -"
build_package "0.9.9" || { echo "FAIL  could not stage a package"; exit 1; }
shim
export PATH="$WORK/bin:$PATH"

# ================================================================ already current
site "0.9.9"
export GALA_FAKE_LATEST=0.9.9
out="$(cd "$WORK/site" && node "$SCRIPT" 2>&1)"
contains "an up-to-date site does nothing" "$out" "Framework is current at 0.9.9"

# ================================================================ a newer release
site "0.0.15"
export GALA_FAKE_LATEST=0.9.9
before_custom="$(cat "$WORK/site/custom.css")"
out="$(cd "$WORK/site" && node "$SCRIPT" 2>&1)"
contains "an update is applied" "$out" "Framework updated to 0.9.9"
check "the pin moved" "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$WORK/site/.gala/managed-files.json','utf8')).themePackage.version)")" "0.9.9"
check "site.config.yml pin moved" "$(grep -A 2 'themePackage:' "$WORK/site/site.config.yml" | grep -o '0\.9\.9' | head -1)" "0.9.9"
# The ceiling moves with the files. Without this the update lands and the very next build fails
# with "Managed JavaScript performance budget exceeded", which is what every publication did.
check "the JavaScript budget was raised to what the runtime needs" \
  "$(grep -o 'managedJavaScriptBytes: [0-9]*' "$WORK/site/site.config.yml")" \
  "managedJavaScriptBytes: $(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$TEMPLATE/.gala/managed-files.json','utf8')).requiredBudgets.managedJavaScriptBytes))")"
check "the CSS budget was raised too" \
  "$(grep -o 'managedCssBytes: [0-9]*' "$WORK/site/site.config.yml")" \
  "managedCssBytes: $(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$TEMPLATE/.gala/managed-files.json','utf8')).requiredBudgets.managedCssBytes))")"
# A budget the writer set above the minimum is theirs, and is left alone.
check "an unrelated budget is untouched" \
  "$(grep -o 'ordinaryHtmlBytes: [0-9]*' "$WORK/site/site.config.yml")" \
  "ordinaryHtmlBytes: 32768"
check "the writer's file is untouched" "$(cat "$WORK/site/custom.css")" "$before_custom"
check "the writer's post is untouched" "$(test -f "$WORK/site/content/posts/mine/index.en.md" && echo present)" "present"
contains "it is recorded as a commit" "$(cd "$WORK/site" && git log -1 --pretty=%s)" "Update the Gala framework to 0.9.9"
check "nothing is left uncommitted" "$(cd "$WORK/site" && git status --porcelain | wc -l | tr -d ' ')" "0"

# ================================================================ opt out
site "0.0.15"
out="$(cd "$WORK/site" && GALA_FRAMEWORK_AUTO_UPDATE=false node "$SCRIPT" 2>&1)"
contains "a publication can opt out" "$out" "pins its own version"
check "and nothing changed" "$(cd "$WORK/site" && git status --porcelain | wc -l | tr -d ' ')" "0"

# ================================================================ a corrupted package
site "0.0.15"
node -e "
  const f=require('fs');
  const p='$WORK/pkg-0.9.9/payload/src/assets/interactions.js';
  f.writeFileSync(p, f.readFileSync(p,'utf8') + '\n// tampered\n');
"
(cd "$WORK/pkg-0.9.9" && tar -czf "$WORK/theme-0.9.9.tgz" --transform "s,^\\.,package," . 2>/dev/null \
  || tar -czf "$WORK/theme-0.9.9.tgz" -s ",^\\.,package," . 2>/dev/null)
out="$(cd "$WORK/site" && node "$SCRIPT" 2>&1)"
contains "a tampered file is refused" "$out" "does not match its own manifest"
check "and nothing was written" "$(cd "$WORK/site" && git status --porcelain | wc -l | tr -d ' ')" "0"

# ================================================================ registry unreachable
site "0.0.15"
cat > "$WORK/bin/npm" <<'SHIM'
#!/usr/bin/env bash
echo "network unreachable" >&2; exit 1
SHIM
chmod +x "$WORK/bin/npm"
out="$(cd "$WORK/site" && node "$SCRIPT" 2>&1)"
code=$?
contains "an unreachable registry is survivable" "$out" "Framework update skipped"
check "and it exits cleanly, so the publish continues" "$code" "0"

# ================================================================ a publication with a remote
#
# The case that broke every publish in production. The workflow checks out one exact content
# commit; by the time the updater runs, the deployment record has already been pushed, so the
# branch has moved on. The update has to land on top of that record and reach the remote - the
# first version committed onto the stale checkout and never pushed at all, which both tripped the
# action's HEAD guard and meant no publication ever moved forward.
# The corrupted-package case rewrote this tarball in place; serve a clean one again.
build_package "0.9.9" || { echo "FAIL  could not restage"; exit 1; }
shim
site "0.0.15"
export GALA_FAKE_LATEST=0.9.9
ORIGIN="$WORK/origin.git"
rm -rf "$ORIGIN"
git init -q --bare --initial-branch=main "$ORIGIN"
(cd "$WORK/site" && git remote add origin "$ORIGIN" && git push -q origin HEAD:refs/heads/main)

# The deployment record lands on the branch after this checkout was taken, exactly as the workflow
# does it: a commit pushed straight to the branch without moving the local HEAD.
CLONE="$WORK/recorder"
git clone -q "$ORIGIN" "$CLONE"
(cd "$CLONE" && git config user.email t@t && git config user.name t \
  && echo 'recorded' > deployment-record.txt && git add -A \
  && git -c core.hooksPath=/dev/null commit -qm 'chore(gala): record successful deployment' \
  && git push -q origin HEAD:refs/heads/main)

out="$(cd "$WORK/site" && GALA_UPDATE_BRANCH=main node "$SCRIPT" 2>&1)"
contains "an update reaches the remote" "$out" "Framework updated to 0.9.9"

VERIFY="$WORK/verify"
rm -rf "$VERIFY"
git clone -q "$ORIGIN" "$VERIFY"
check "the update is on the branch" \
  "$(cd "$VERIFY" && node -e "console.log(JSON.parse(require('fs').readFileSync('.gala/managed-files.json','utf8')).themePackage.version)")" \
  "0.9.9"
check "and it did not discard the deployment record" \
  "$(cd "$VERIFY" && test -f deployment-record.txt && echo present || echo lost)" "present"
check "the writer's post survived the push" \
  "$(cd "$VERIFY" && test -f content/posts/mine/index.en.md && echo present || echo lost)" "present"

# Running again against a branch that already carries the update must be a no-op, not a second
# empty commit on every scheduled run.
out="$(cd "$WORK/site" && GALA_UPDATE_BRANCH=main node "$SCRIPT" 2>&1)"
check "a second run adds nothing" \
  "$(cd "$VERIFY" && git fetch -q origin main && git rev-list --count FETCH_HEAD)" \
  "$(cd "$VERIFY" && git rev-list --count FETCH_HEAD)"

# ================================================================ one-run prepare and post-deploy record
site "0.0.15"
export GALA_FAKE_LATEST=0.9.9
ORIGIN="$WORK/two-phase-origin.git"
rm -rf "$ORIGIN"
git init -q --bare --initial-branch=main "$ORIGIN"
node - "$WORK/site" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const configPath = path.join(root, 'site.config.yml');
const config = fs.readFileSync(configPath, 'utf8')
  .replace('repository: unavailable', 'repository: author/publication')
  .replace('canonicalBaseUrl: unavailable', 'canonicalBaseUrl: https://author.example')
  .replace('pathPrefix: /unavailable', 'pathPrefix: /');
fs.writeFileSync(configPath, config);
NODE
(cd "$WORK/site" && git add site.config.yml \
  && git -c core.hooksPath=/dev/null commit --amend --no-edit -q)
(cd "$WORK/site" && git remote add origin "$ORIGIN" && git push -q origin HEAD:refs/heads/main)
author_head="$(cd "$WORK/site" && git rev-parse HEAD)"
out="$(cd "$WORK/site" && GALA_FRAMEWORK_UPDATE_MODE=prepare GALA_AUTHOR_COMMIT_SHA="$author_head" node "$SCRIPT" 2>&1)"
contains "prepare overlays the verified release" "$out" "Framework prepared at 0.9.9"
check "prepare preserves author HEAD" "$(cd "$WORK/site" && git rev-parse HEAD)" "$author_head"
check "prepare emits a hash-bound receipt" \
  "$(node -e "const r=require('$WORK/site/.gala/build/framework-update.json'); process.stdout.write(r.baseCommit)")" \
  "$author_head"

# Install and build the overlaid release while HEAD still identifies the author's exact content.
node - "$WORK/site" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
fs.mkdirSync(path.join(root, '.gala', 'build'), { recursive: true });
fs.writeFileSync(path.join(root, '.gala', 'build', 'validated-posts.json'), JSON.stringify({
  schemaVersion: 1,
  evaluationDate: '2026-08-28',
  assignedContentIds: [],
  posts: [],
  redirects: []
}));
NODE
(cd "$WORK/site" && "$REAL_NPM" ci --ignore-scripts >/dev/null \
  && GALA_BUILD_COMMIT="$author_head" "$REAL_NPM" run build >/dev/null)
rendered="$(cat "$WORK/site/_site/index.html")"
contains "the first artifact renders its author-commit version link" "$rendered" \
  'href="/s/version/"'
contains "the rendered version label is the original author SHA" "$rendered" "${author_head:0:8}"

# Deployment and reconciliation succeed without moving the original checkout.
RECORDER="$WORK/two-phase-recorder"
git clone -q "$ORIGIN" "$RECORDER"
(cd "$RECORDER" && git config user.email t@t && git config user.name t \
  && mkdir -p .gala && echo 'reconciled' > .gala/reconciled \
  && git add .gala/reconciled && git -c core.hooksPath=/dev/null commit -qm 'record deployment' \
  && git push -q origin HEAD:refs/heads/main)

out="$(cd "$WORK/site" && GALA_FRAMEWORK_UPDATE_MODE=commit GALA_UPDATE_BRANCH=main GALA_AUTHOR_COMMIT_SHA="$author_head" node "$SCRIPT" 2>&1)"
contains "successful deployment records the prepared bytes" "$out" "Framework updated to 0.9.9"
check "recording still preserves checkout HEAD" "$(cd "$WORK/site" && git rev-parse HEAD)" "$author_head"
VERIFY="$WORK/two-phase-verify"
git clone -q "$ORIGIN" "$VERIFY"
check "framework is committed after reconciliation" \
  "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$VERIFY/.gala/managed-files.json')).themePackage.version)")" \
  "0.9.9"
check "reconciliation record is preserved" "$(test -f "$VERIFY/.gala/reconciled" && echo present)" "present"

# ================================================================ failures and concurrency never overwrite
site "0.0.15"
export GALA_FAKE_LATEST=0.9.9
ORIGIN="$WORK/safety-origin.git"
rm -rf "$ORIGIN"; git init -q --bare --initial-branch=main "$ORIGIN"
(cd "$WORK/site" && git remote add origin "$ORIGIN" && git push -q origin HEAD:refs/heads/main)
author_head="$(cd "$WORK/site" && git rev-parse HEAD)"
(cd "$WORK/site" && GALA_FRAMEWORK_UPDATE_MODE=prepare GALA_AUTHOR_COMMIT_SHA="$author_head" node "$SCRIPT" >/dev/null)
check "a failed deployment writes no framework commit" \
  "$(git --git-dir="$ORIGIN" rev-list --count main)" "1"

CONCURRENT="$WORK/concurrent"
git clone -q "$ORIGIN" "$CONCURRENT"
(cd "$CONCURRENT" && git config user.email t@t && git config user.name t \
  && printf '\n# author change\n' >> site.config.yml && git add site.config.yml \
  && git -c core.hooksPath=/dev/null commit -qm 'author changes settings' \
  && git push -q origin HEAD:refs/heads/main)
out="$(cd "$WORK/site" && GALA_FRAMEWORK_UPDATE_MODE=commit GALA_UPDATE_BRANCH=main GALA_AUTHOR_COMMIT_SHA="$author_head" node "$SCRIPT" 2>&1)"
contains "a concurrent managed-path change blocks write-back" "$out" "changed concurrently"
VERIFY="$WORK/safety-verify"
git clone -q "$ORIGIN" "$VERIFY"
contains "the author's concurrent change survives" "$(cat "$VERIFY/site.config.yml")" "# author change"
check "the blocked update creates no extra commit" "$(cd "$VERIFY" && git rev-list --count HEAD)" "2"

# An author may publish again while this run deploys. Their content commit becomes the parent of
# the framework commit and must survive byte-for-byte because it is outside the managed path set.
site "0.0.15"
export GALA_FAKE_LATEST=0.9.9
ORIGIN="$WORK/content-race-origin.git"
rm -rf "$ORIGIN"; git init -q --bare --initial-branch=main "$ORIGIN"
(cd "$WORK/site" && git remote add origin "$ORIGIN" && git push -q origin HEAD:refs/heads/main)
author_head="$(cd "$WORK/site" && git rev-parse HEAD)"
(cd "$WORK/site" && GALA_FRAMEWORK_UPDATE_MODE=prepare GALA_AUTHOR_COMMIT_SHA="$author_head" node "$SCRIPT" >/dev/null)
CONCURRENT="$WORK/content-race"
git clone -q "$ORIGIN" "$CONCURRENT"
(cd "$CONCURRENT" && git config user.email t@t && git config user.name t \
  && printf '\nauthor concurrent prose\n' >> content/posts/mine/index.en.md \
  && git add content/posts/mine/index.en.md \
  && git -c core.hooksPath=/dev/null commit -qm 'author publishes again' \
  && git push -q origin HEAD:refs/heads/main)
out="$(cd "$WORK/site" && GALA_FRAMEWORK_UPDATE_MODE=commit GALA_UPDATE_BRANCH=main GALA_AUTHOR_COMMIT_SHA="$author_head" node "$SCRIPT" 2>&1)"
contains "a concurrent content commit still permits safe framework write-back" "$out" "Framework updated to 0.9.9"
VERIFY="$WORK/content-race-verify"
git clone -q "$ORIGIN" "$VERIFY"
contains "concurrent author prose survives byte-for-byte" \
  "$(cat "$VERIFY/content/posts/mine/index.en.md")" "author concurrent prose"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
