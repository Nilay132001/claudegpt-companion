#!/usr/bin/env bash
# Offline checks of the packaging scripts (M7): no network, no build, no credentials. macOS (arm64) only.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# expect_fail <name> <text the output must contain> <command…>: the command must fail and say <text>.
expect_fail() {
  local name="$1" want="$2" out
  shift 2
  if out="$("$@" 2>&1)"; then
    echo "FAIL: $name: it succeeded"; fail=1
  elif ! grep -qF -- "$want" <<<"$out"; then
    echo "FAIL: $name: the output lacks '$want': $out"; fail=1
  else
    echo "ok: $name"
  fi
}

# node.pin holds a Node 24 version and a SHA-256.
grep -qE '^NODE_VERSION=24\.[0-9]+\.[0-9]+$' app/bundle/node.pin || { echo "FAIL: node.pin version"; fail=1; }
grep -qE '^NODE_SHA256_DARWIN_ARM64=[0-9a-f]{64}$' app/bundle/node.pin || { echo "FAIL: node.pin sha256"; fail=1; }

expect_fail "fetch-node needs a destination" "usage:" bash scripts/fetch-node.sh
printf 'SYNTHETIC FIXTURE not a tarball\n' > "$work/fake.tar.gz"
expect_fail "fetch-node rejects a tarball with the wrong checksum" "checksum mismatch" \
  env COMPANION_NODE_TARBALL="$work/fake.tar.gz" bash scripts/fetch-node.sh "$work/out"
[ ! -e "$work/out/node" ] || { echo "FAIL: fetch-node left files after a bad checksum"; fail=1; }

[ $fail -eq 0 ] && echo "test-packaging: OK"
exit $fail
