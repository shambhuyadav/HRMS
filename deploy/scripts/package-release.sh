#!/usr/bin/env bash
# Makes a release tarball from the working tree (on the developer's machine; Git Bash on Windows works). The files are taken as git
# would store them if everything were added now — tracked and new files, not ignored ones (node_modules, .env, .dev-pg), with git's
# line-ending normalisation — through a temporary index, so neither the real index nor any branch changes and nothing is committed.
# Only what runs on the server is included (no docs/, no load/), plus a RELEASE file naming the commit and whether uncommitted
# changes are included. Taking git's form matters for migrations: they are checksummed once applied, so every release must carry the
# same bytes for them whatever the checkout's line endings.
# With --with-web-build the web app is built here (type check + vite build) and its files are included, so the server only installs
# dependencies (install-release.sh skips its own build): for a small server, where the build would not fit in memory.
#   bash deploy/scripts/package-release.sh [--with-web-build] [output.tgz]
set -euo pipefail
WEB_BUILD=no
if [ "${1:-}" = "--with-web-build" ]; then WEB_BUILD=yes; shift; fi
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
STAMP="$(date -u +%Y%m%d%H%M%S)"
OUT="${1:-$ROOT/../hrms-release-$STAMP.tgz}"
PATHS=(package.json package-lock.json tsconfig.json vitest.config.ts apps db deploy)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp "$(git rev-parse --git-path index)" "$TMP/index"
GIT_INDEX_FILE="$TMP/index" git add -A -- "${PATHS[@]}" 2>/dev/null
TREE="$(GIT_INDEX_FILE="$TMP/index" git write-tree)"
# Without the checkout conversion (core.autocrlf would turn the stored LF back into CRLF on the way out).
git -c core.autocrlf=false -c core.eol=lf archive --format=tar -o "$TMP/release.tar" "$TREE" -- "${PATHS[@]}"

# The server runs these on Linux and checksums the migrations: no carriage returns may remain.
mkdir "$TMP/check"
tar --force-local -xf "$TMP/release.tar" -C "$TMP/check" db/migrations deploy
# (Counted in bytes: Git Bash's grep reports carriage returns that are not there. Text files only: fonts and images hold any byte.)
bad="$(find "$TMP/check" -type f ! -name '*.woff2' ! -name '*.woff' ! -name '*.png' ! -name '*.ico' ! -name '*.jpg' \
  | while read -r f; do [ "$(tr -cd '\r' < "$f" | wc -c)" -eq 0 ] || echo "$f"; done)"
[ -z "$bad" ] || { echo "Carriage returns (CRLF) remain in:" >&2; echo "${bad//$TMP\/check\//}" >&2; exit 1; }

dirty="no"
[ -z "$(git status --porcelain -- "${PATHS[@]}")" ] || dirty="yes"
printf 'commit=%s\ntree=%s\nuncommitted_changes=%s\npackaged_at=%s\nweb_prebuilt=%s\n' "$(git rev-parse HEAD)" "$TREE" "$dirty" "$STAMP" "$WEB_BUILD" > "$TMP/RELEASE"
tar --force-local -rf "$TMP/release.tar" -C "$TMP" RELEASE

if [ "$WEB_BUILD" = yes ]; then
  # Built from exactly the packaged files (not the working tree, which may differ in ignored files), with their own dependencies.
  mkdir "$TMP/web"
  tar --force-local -xf "$TMP/release.tar" -C "$TMP/web"
  (cd "$TMP/web" && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run build -w apps/web >/dev/null)
  test -f "$TMP/web/apps/web/dist/index.html"
  tar --force-local -rf "$TMP/release.tar" -C "$TMP/web" apps/web/dist
fi
gzip -9 -c "$TMP/release.tar" > "$OUT"
echo "$OUT: $(tar --force-local -tf "$TMP/release.tar" | wc -l) files, $(du -h "$OUT" | cut -f1); commit $(git rev-parse --short HEAD), tree ${TREE:0:12}, uncommitted changes: $dirty"
