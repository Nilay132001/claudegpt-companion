#!/usr/bin/env bash
# Builds "ClaudeGPT Companion.app" (M7): the Swift app, companiond (sources, the relay source, production dependencies
# with the pinned Codex) and the pinned official Node.js, signed inside out.
# Identity: COMPANION_SIGN_IDENTITY (default "-" = ad-hoc). A real identity also gets a secure timestamp (R4).
# Codex keeps OpenAI's own signature and is only checked; Node is re-signed with app/bundle/node.entitlements (R3).
# No notarization here: scripts/notarize.sh (owner only).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
identity="${COMPANION_SIGN_IDENTITY:--}"
out="app/build/ClaudeGPT Companion.app"
[ "$(uname -m)" = arm64 ] || { echo "build-app: Apple silicon only"; exit 1; }
if [ "$identity" = "-" ]; then ts=(--timestamp=none); else ts=(--timestamp); fi

# One version (R6): companiond/package.json, and both Info.plist keys must match it.
version="$(plutil -extract version raw companiond/package.json)"
for key in CFBundleShortVersionString CFBundleVersion; do
  v="$(/usr/libexec/PlistBuddy -c "Print :$key" app/bundle/Info.plist)"
  [ "$v" = "$version" ] || { echo "build-app: Info.plist $key is $v, companiond is $version"; exit 1; }
done

(cd app && swift build -c release --product CompanionApp)
bin_dir="$(cd app && swift build -c release --product CompanionApp --show-bin-path)"

rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
cp "$bin_dir/CompanionApp" "$out/Contents/MacOS/CompanionApp"
cp app/bundle/Info.plist "$out/Contents/Info.plist"
plutil -lint "$out/Contents/Info.plist"

# App icon: the committed .icns always (CFBundleIconFile). Where actool can compile the Icon Composer document
# (Xcode 26 or later), also the Liquid Glass icon in Assets.car (CFBundleIconName), which macOS 26 prefers.
# actool needs an absolute path to the .icon document (a relative one is resolved against the document twice).
cp app/bundle/icon/AppIcon.icns "$out/Contents/Resources/AppIcon.icns"
if xcrun --find actool >/dev/null 2>&1; then
  icon_work="$(mktemp -d)"
  if xcrun actool --compile "$icon_work" --platform macosx --minimum-deployment-target 26.0 --app-icon AppIcon \
      --output-partial-info-plist "$icon_work/partial.plist" "$PWD/app/bundle/icon/AppIcon.icon" >/dev/null 2>&1 \
    && [ -f "$icon_work/Assets.car" ]; then
    cp "$icon_work/Assets.car" "$out/Contents/Resources/Assets.car"
    /usr/libexec/PlistBuddy -c "Add :CFBundleIconName string AppIcon" "$out/Contents/Info.plist"
  else
    echo "build-app: actool could not compile AppIcon.icon; using AppIcon.icns only"
  fi
  rm -rf "$icon_work"
else
  echo "build-app: no actool; using AppIcon.icns only"
fi

# companiond: sources, the relay source (built at every daemon start, spec §7.1.9) and production dependencies.
res="$out/Contents/Resources/companiond"
mkdir -p "$res"
cp companiond/package.json companiond/package-lock.json "$res/"
cp -R companiond/src "$res/src"
cp -R companiond/relay "$res/relay"
(cd "$res" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

# Node (R1): the pinned official build, re-signed with only the JIT entitlements (plan fact 2).
bash scripts/fetch-node.sh "$out/Contents/Resources"
node_bin="$out/Contents/Resources/node/bin/node"
codesign --force --options runtime "${ts[@]}" --entitlements app/bundle/node.entitlements --sign "$identity" "$node_bin"

codesign --force --options runtime "${ts[@]}" \
  --entitlements app/bundle/CompanionApp.entitlements --sign "$identity" "$out"

# ---- Verification ----
codesign --verify --deep --strict --verbose=2 "$out"
for f in src/lineBuffer.ts src/daemon/main.ts src/version.ts relay/relay.c package.json; do test -f "$res/$f"; done
test -s "$out/Contents/Resources/AppIcon.icns" || { echo "build-app: no AppIcon.icns"; exit 1; }
for key in NSMicrophoneUsageDescription NSSpeechRecognitionUsageDescription CFBundleIdentifier LSMinimumSystemVersion CFBundleIconFile; do
  /usr/libexec/PlistBuddy -c "Print :$key" "$out/Contents/Info.plist" >/dev/null
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Entitlement keys of a signed file, sorted, one line. Capture first, then parse (no pipes into grep -q under pipefail).
ent_keys() {
  local xml="$work/ents.plist"
  codesign -d --entitlements - --xml "$1" >"$xml" 2>/dev/null || true
  [ -s "$xml" ] || { echo ""; return; }
  plutil -convert json -o - "$xml" | node -e 'process.stdout.write(Object.keys(JSON.parse(require("fs").readFileSync(0,"utf8"))).sort().join(" "))'
}
runtime_flag() { local i; i="$(codesign -d --verbose=2 "$1" 2>&1)"; grep -q "flags=.*runtime" <<<"$i"; }

# The app: hardened runtime, exactly the microphone entitlement, arm64.
runtime_flag "$out" || { echo "build-app: no hardened runtime: the app"; exit 1; }
[ "$(ent_keys "$out")" = "com.apple.security.device.audio-input" ] || { echo "build-app: unexpected app entitlements"; exit 1; }
[ "$(lipo -archs "$out/Contents/MacOS/CompanionApp")" = arm64 ] || { echo "build-app: the app is not arm64-only"; exit 1; }

# Node: the pinned version, hardened runtime, exactly the two JIT entitlements, arm64.
want_node="v$(sed -n 's/^NODE_VERSION=//p' app/bundle/node.pin)"
[ "$("$node_bin" --version)" = "$want_node" ] || { echo "build-app: the bundled Node is not $want_node"; exit 1; }
runtime_flag "$node_bin" || { echo "build-app: no hardened runtime: node/bin/node"; exit 1; }
[ "$(ent_keys "$node_bin")" = "com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory" ] \
  || { echo "build-app: unexpected Node entitlements"; exit 1; }
[ "$(lipo -archs "$node_bin")" = arm64 ] || { echo "build-app: Node is not arm64-only"; exit 1; }

# Codex (R3): the pinned version, OpenAI's own Developer ID signature with the hardened runtime, untouched.
vendor="$res/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin"
[ "$(plutil -extract version raw "$vendor/codex-package.json")" = "0.166.0" ] || { echo "build-app: Codex is not 0.166.0"; exit 1; }
[ ! -e "$res/node_modules/@openai/codex-darwin-x64" ] || { echo "build-app: an x64 Codex was installed"; exit 1; }
checked=0
seen=" "
while IFS= read -r -d '' f; do
  kind="$(file -b "$f")"
  case "$kind" in Mach-O*) ;; *) continue ;; esac
  rel="${f#"$vendor"/}"
  codesign --verify --strict "$f" || { echo "build-app: codex signature invalid: $rel"; exit 1; }
  runtime_flag "$f" || { echo "build-app: no hardened runtime: $rel"; exit 1; }
  auth="$(codesign -d --verbose=2 "$f" 2>&1)"
  grep -q "^Authority=Developer ID Application: " <<<"$auth" || { echo "build-app: $rel is not Developer ID signed"; exit 1; }
  checked=$((checked + 1))
  seen="$seen$rel "
done < <(find "$vendor" -type f -print0)
for b in bin/codex bin/codex-code-mode-host codex-path/rg; do
  case "$seen" in *" $b "*) ;; *) echo "build-app: expected Codex binary not checked: $b"; exit 1 ;; esac
done
echo "codex: $checked Mach-O files verified"
echo "built and verified: $out (version $version, identity: $identity)"
