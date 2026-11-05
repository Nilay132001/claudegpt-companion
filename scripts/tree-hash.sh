#!/usr/bin/env bash
# Read-only fingerprint of a repository for the primary acceptance test (spec §12.4): every file in the working
# tree (tracked, untracked and ignored; .git excluded), symlink targets, the index, HEAD, refs and packed-refs.
# Usage: scripts/tree-hash.sh <repo root>   Prints one SHA-256. Run before and after; the two must match.
set -euo pipefail
root="${1:?usage: scripts/tree-hash.sh <repo root>}"
cd "$root"
export GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 LC_ALL=C
git_dir="$(/usr/bin/git rev-parse --absolute-git-dir)"
common_dir="$(/usr/bin/git rev-parse --path-format=absolute --git-common-dir)"
{
  find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 shasum -a 256
  find . -path ./.git -prune -o -type l -print0 | sort -z | xargs -0 -I{} sh -c 'printf "%s -> %s\n" "$1" "$(readlink "$1")"' _ {}
  shasum -a 256 "$git_dir/index" "$git_dir/HEAD"
  /usr/bin/git for-each-ref --format='%(refname) %(objectname)'
  if [ -f "$common_dir/packed-refs" ]; then shasum -a 256 "$common_dir/packed-refs"; fi
} | shasum -a 256 | cut -d' ' -f1
