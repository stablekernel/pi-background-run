#!/usr/bin/env bash
# One-time bootstrap publish for v0.1.0 (Option A):
#   1. publish pi-background-run@0.1.0 (unscoped primary)
#   2. publish @stablekernel/pi-background-run@0.1.0 (scoped alias, same tarball)
#   3. restore package.json and verify both on the registry
#
# Run from your own terminal: each publish triggers the browser passkey challenge.
# Safe to re-run: each publish is skipped if that name/version is already on the
# registry (handles a partial publish where E409 aborted before the alias step),
# and package.json is always restored via trap.
set -euo pipefail
cd "$(dirname "$0")/.."

PKG_JSON=package.json
BACKUP=package.json.bootstrap-backup

# --- preconditions -----------------------------------------------------------
# --porcelain sees staged AND unstaged changes; `git diff --quiet` alone misses
# staged work, which would let a half-committed state publish.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "❌ working tree dirty (staged or unstaged) — commit first"
  exit 1
fi
cp "$PKG_JSON" "$BACKUP"
restore() { mv -f "$BACKUP" "$PKG_JSON"; }
trap restore EXIT

VERSION=$(node -p "require('./$PKG_JSON').version")

if npm view "pi-background-run@${VERSION}" version >/dev/null 2>&1; then
  echo "⏭  pi-background-run@${VERSION} already published — skipping"
else
  echo "▶ Publishing pi-background-run@${VERSION} (primary)…"
  npm publish --access public
fi

if npm view "@stablekernel/pi-background-run@${VERSION}" version >/dev/null 2>&1; then
  echo "⏭  @stablekernel/pi-background-run@${VERSION} already published — skipping"
else
  echo "▶ Publishing @stablekernel/pi-background-run@${VERSION} (alias)…"
  node -e "const p=require('./$PKG_JSON'); p.name='@stablekernel/pi-background-run'; require('fs').writeFileSync('$PKG_JSON', JSON.stringify(p,null,2)+'\n')"
  npm publish --access public
fi
restore
trap - EXIT

# --- verify -------------------------------------------------------------------
echo "▶ Verifying registry…"
npm view "pi-background-run@${VERSION}" version
npm view "@stablekernel/pi-background-run@${VERSION}" version
echo "✅ Both packages published at ${VERSION}."
echo "Next: configure trusted publishers (Settings → Trusted Publisher on each package),"
echo "then all future releases go through release.yml (first CI release: v0.2.0)."
