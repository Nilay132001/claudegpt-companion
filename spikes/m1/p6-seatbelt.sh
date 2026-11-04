#!/usr/bin/env bash
set -euo pipefail
SPIKE="$(cd "$(dirname "$0")" && pwd -P)"
mkdir -p "$SPIKE/.tmp"
ROOT="$(mktemp -d "$SPIKE/.tmp/sb-root-XXXX")"
echo "SYNTHETIC FIXTURE inside" > "$ROOT/inside.txt"
git -C "$ROOT" init -q
NODE="$(node -p 'require("fs").realpathSync(process.execPath)')"  # full realpath: Homebrew's bin/node is a symlink
NODE_PREFIX="$(dirname "$(dirname "$NODE")")"
GIT="$(xcrun -f git)"
DEVDIR="$(xcode-select -p)"
# The outside file must be outside every allowed subpath, so put it in a fresh folder under $TMPDIR.
OUT2="$(mktemp -d)/outside.txt"; echo "SYNTHETIC FIXTURE outside" > "$OUT2"
sandbox-exec -f "$SPIKE/readonly.sb" \
  -D ROOT="$ROOT" -D NODE="$NODE" -D NODE_PREFIX="$NODE_PREFIX" -D GIT="$GIT" -D SPIKE="$SPIKE" -D DEVDIR="$DEVDIR" \
  "$NODE" "$SPIKE/p6-probe-inside.mjs" "$ROOT" "$OUT2" "$GIT"
echo "pwned.txt created: $([ -e "$ROOT/pwned.txt" ] && echo yes || echo no)"
