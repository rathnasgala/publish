#!/usr/bin/env bash
# Drives the self-updater against a fabricated publication and a fabricated registry.
#
# Everything is local: `npm view` and `npm pack` are shimmed by a directory placed first on PATH,
# so the test exercises the real script — its verification, its path guards, its commit — without
# reaching npm or needing a published version.
set -uo pipefail

WORK="$(mktemp -d)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/self-update.mjs"
# The theme payload is staged from site-template, which sits beside this repository in a
# workspace checkout. Skipped rather than failed when it is not there.
TEMPLATE="${GALA_SITE_TEMPLATE:-$HERE/../../../site-template}"
if [ ! -f "$TEMPLATE/scripts/stage-theme-package.js" ]; then
  echo "site-template not found at $TEMPLATE — set GALA_SITE_TEMPLATE to run this."
  exit 0
fi
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "pass  $1"; pass=$((pass+1)); else echo "FAIL  $1 — expected [$3] got [$2]"; fail=$((fail+1)); fi }
contains() { if printf '%s' "$2" | grep -qF "$3"; then echo "pass  $1"; pass=$((pass+1)); else echo "FAIL  $1 — no [$3] in output"; fail=$((fail+1)); fi }

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
if [ "\$1" = "view" ]; then printf '"%s"' "\$GALA_FAKE_LATEST"; exit 0; fi
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
  # A writer's own file, which must survive untouched.
  echo "# my notes" > "$dir/custom.css"
  mkdir -p "$dir/content/posts/mine"; echo "---" > "$dir/content/posts/mine/index.en.md"
  (cd "$dir" && git init -q && git config user.email t@t && git config user.name t && git add -A && git -c core.hooksPath=/dev/null commit -qm initial)
}

echo "— building a package and a publication —"
build_package "9.9.9" || { echo "FAIL  could not stage a package"; exit 1; }
shim
export PATH="$WORK/bin:$PATH"

# ================================================================ already current
site "9.9.9"
export GALA_FAKE_LATEST=9.9.9
out="$(cd "$WORK/site" && node "$SCRIPT" 2>&1)"
contains "an up-to-date site does nothing" "$out" "Framework is current at 9.9.9"

# ================================================================ a newer release
site "0.0.15"
export GALA_FAKE_LATEST=9.9.9
before_custom="$(cat "$WORK/site/custom.css")"
out="$(cd "$WORK/site" && node "$SCRIPT" 2>&1)"
contains "an update is applied" "$out" "Framework updated to 9.9.9"
check "the pin moved" "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$WORK/site/.gala/managed-files.json','utf8')).themePackage.version)")" "9.9.9"
check "site.config.yml pin moved" "$(grep -A 2 'themePackage:' "$WORK/site/site.config.yml" | grep -o '9\.9\.9' | head -1)" "9.9.9"
check "the writer's file is untouched" "$(cat "$WORK/site/custom.css")" "$before_custom"
check "the writer's post is untouched" "$(test -f "$WORK/site/content/posts/mine/index.en.md" && echo present)" "present"
contains "it is recorded as a commit" "$(cd "$WORK/site" && git log -1 --pretty=%s)" "Update the Gala framework to 9.9.9"
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
  const p='$WORK/pkg-9.9.9/payload/src/assets/interactions.js';
  f.writeFileSync(p, f.readFileSync(p,'utf8') + '\n// tampered\n');
"
(cd "$WORK/pkg-9.9.9" && tar -czf "$WORK/theme-9.9.9.tgz" --transform "s,^\\.,package," . 2>/dev/null \
  || tar -czf "$WORK/theme-9.9.9.tgz" -s ",^\\.,package," . 2>/dev/null)
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

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
