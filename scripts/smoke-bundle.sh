#!/usr/bin/env bash
# Smoke test of the BUILT bundle (M7): (1) its own Node and companiond start, signed out, with a throw-away HOME, and
# the Codex host passes its self-check; (2) the Seatbelt suites (jail, launch, relay, Jira profile) pass under the
# bundled Node, whose prefix the profiles name. Needs companiond's dev dependencies (npm ci in companiond).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
app="${1:-app/build/ClaudeGPT Companion.app}"
case "$app" in /*) ;; *) app="$PWD/$app" ;; esac
[ -x "$app/Contents/Resources/node/bin/node" ] || { echo "smoke-bundle: no bundled Node; run scripts/build-app.sh"; exit 1; }
node companiond/scripts/bundle-smoke.ts "$app"
(cd companiond && "$app/Contents/Resources/node/bin/node" --test \
  test/jail/*.test.ts test/launch/*.test.ts test/relay/*.test.ts test/jira/jiraProfile.test.ts)
echo "smoke-bundle: OK"
