#!/usr/bin/env bash
# Builds "ClaudeGPT Companion.app" from the Swift package and signs it.
# Identity: COMPANION_SIGN_IDENTITY (default "-" = ad-hoc). No notarization here (M7).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
identity="${COMPANION_SIGN_IDENTITY:--}"
out="app/build/ClaudeGPT Companion.app"

(cd app && swift build -c release --product CompanionApp)
bin_dir="$(cd app && swift build -c release --product CompanionApp --show-bin-path)"

rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
cp "$bin_dir/CompanionApp" "$out/Contents/MacOS/CompanionApp"
cp app/bundle/Info.plist "$out/Contents/Info.plist"
# companiond (M5, ruling 1): sources + production dependencies, run with the user's Node >= 24.
res="$out/Contents/Resources/companiond"
mkdir -p "$res"
cp companiond/package.json companiond/package-lock.json "$res/"
cp -R companiond/src "$res/src"
(cd "$res" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
plutil -lint "$out/Contents/Info.plist"

codesign --force --options runtime --timestamp=none \
  --entitlements app/bundle/CompanionApp.entitlements --sign "$identity" "$out"

# Verification
codesign --verify --strict --verbose=2 "$out"
test -f "$out/Contents/Resources/companiond/src/lineBuffer.ts"
test -d "$out/Contents/Resources/companiond/node_modules/@openai/codex"
test -f "$out/Contents/Resources/companiond/src/daemon/main.ts"
# Capture first, then grep: `codesign | grep -q` can fail under pipefail when grep exits early (SIGPIPE).
ents="$(codesign -d --entitlements - --xml "$out" 2>/dev/null)"
grep -q "com.apple.security.device.audio-input" <<<"$ents"
info="$(codesign -d --verbose=2 "$out" 2>&1)"
grep -q "flags=.*runtime" <<<"$info"
for key in NSMicrophoneUsageDescription NSSpeechRecognitionUsageDescription CFBundleIdentifier LSMinimumSystemVersion; do
  /usr/libexec/PlistBuddy -c "Print :$key" "$out/Contents/Info.plist" >/dev/null
done
echo "built and verified: $out (identity: $identity)"
