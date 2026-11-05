#!/usr/bin/env bash
# Packs the built app into a DMG with an /Applications link (M7, R8). A real COMPANION_SIGN_IDENTITY also signs the DMG.
# COMPANION_APP overrides the app path (tests). Notarization: scripts/notarize.sh (owner only).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
identity="${COMPANION_SIGN_IDENTITY:--}"
app="${COMPANION_APP:-app/build/ClaudeGPT Companion.app}"
[ -d "$app" ] || { echo "package-app: build the app first (scripts/build-app.sh)"; exit 1; }
codesign --verify --deep --strict "$app"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
dmg="app/build/ClaudeGPT-Companion-$version.dmg"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/ClaudeGPT Companion.app"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
for try in 1 2 3; do
  if hdiutil create -quiet -volname "ClaudeGPT Companion" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg"; then break; fi
  [ "$try" = 3 ] && { echo "package-app: hdiutil failed 3 times"; exit 1; }
  sleep 5
done
if [ "$identity" != "-" ]; then codesign --force --timestamp --sign "$identity" "$dmg"; fi
hdiutil verify -quiet "$dmg"
echo "packaged: $dmg"
