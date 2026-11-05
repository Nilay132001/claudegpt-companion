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

# notarize.sh refuses anything but an owner-configured Developer ID run (R4). Never run with real values here.
expect_fail "notarize refuses an ad-hoc identity" "COMPANION_SIGN_IDENTITY" \
  env -u COMPANION_SIGN_IDENTITY -u COMPANION_NOTARY_PROFILE bash scripts/notarize.sh "$work/x.dmg"
expect_fail "notarize needs a notary profile" "COMPANION_NOTARY_PROFILE" \
  env -u COMPANION_NOTARY_PROFILE COMPANION_SIGN_IDENTITY="SYNTHETIC FIXTURE identity" bash scripts/notarize.sh "$work/x.dmg"
expect_fail "notarize needs a DMG" "usage:" \
  env COMPANION_SIGN_IDENTITY="SYNTHETIC FIXTURE identity" COMPANION_NOTARY_PROFILE="synthetic-profile" bash scripts/notarize.sh
expect_fail "notarize needs an existing DMG" "no such DMG" \
  env COMPANION_SIGN_IDENTITY="SYNTHETIC FIXTURE identity" COMPANION_NOTARY_PROFILE="synthetic-profile" bash scripts/notarize.sh "$work/missing.dmg"
# package-app.sh needs a built app.
expect_fail "package-app needs a built app" "build the app first" \
  env COMPANION_APP="$work/none.app" bash scripts/package-app.sh

[ $fail -eq 0 ] && echo "test-packaging: OK"
exit $fail
