#!/usr/bin/env bash
# Installs the pinned official Node.js (app/bundle/node.pin) as <dest>/node/bin/node and <dest>/node/LICENSE (M7, R1).
# The tarball is COMPANION_NODE_TARBALL (a local copy) or a download from nodejs.org, cached in app/build/cache.
# Its SHA-256 is checked against the pin before anything is extracted. Apple silicon only (R2).
set -euo pipefail
dest="${1:-}"
[ -n "$dest" ] || { echo "usage: scripts/fetch-node.sh <dest dir>"; exit 2; }
abs() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac; }
dest="$(abs "$dest")"
tarball_override="${COMPANION_NODE_TARBALL:+$(abs "$COMPANION_NODE_TARBALL")}"
cd "$(git rev-parse --show-toplevel)"

pin() { sed -n "s/^$1=\([0-9A-Za-z.]*\)\$/\1/p" app/bundle/node.pin; }
version="$(pin NODE_VERSION)"
sha="$(pin NODE_SHA256_DARWIN_ARM64)"
[[ "$version" =~ ^24\.[0-9]+\.[0-9]+$ ]] || { echo "fetch-node: node.pin has no Node 24 version"; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "fetch-node: node.pin has no SHA-256"; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "fetch-node: Apple silicon only"; exit 1; }

name="node-v$version-darwin-arm64"
if [ -n "$tarball_override" ]; then
  tarball="$tarball_override"; cached=0
else
  tarball="app/build/cache/$name.tar.gz"; cached=1
  if [ ! -f "$tarball" ]; then
    mkdir -p app/build/cache
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tarball.part" "https://nodejs.org/dist/v$version/$name.tar.gz"
    mv "$tarball.part" "$tarball"
  fi
fi
if ! echo "$sha  $tarball" | shasum -a 256 -c --status; then
  [ "$cached" = 1 ] && rm -f "$tarball"
  echo "fetch-node: checksum mismatch for $name.tar.gz"
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tar -xzf "$tarball" -C "$work" "$name/bin/node" "$name/LICENSE"
got="$("$work/$name/bin/node" --version)"
[ "$got" = "v$version" ] || { echo "fetch-node: the tarball's Node reports $got"; exit 1; }
mkdir -p "$dest/node/bin"
install -m 0755 "$work/$name/bin/node" "$dest/node/bin/node"
install -m 0644 "$work/$name/LICENSE" "$dest/node/LICENSE"
echo "fetch-node: Node v$version installed"
