#!/usr/bin/env bash
# OWNER ONLY (M7, R4). Notarizes and staples the DMG made by scripts/package-app.sh from a Developer ID build.
# Needs: COMPANION_SIGN_IDENTITY = your "Developer ID Application: …" identity (the same one the build used), and
# COMPANION_NOTARY_PROFILE = a profile you made once with `xcrun notarytool store-credentials`. See docs/signing.md.
# Nothing here reads, prints or stores a credential: notarytool takes them from your keychain profile.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
identity="${COMPANION_SIGN_IDENTITY:--}"
profile="${COMPANION_NOTARY_PROFILE:-}"
[ "$identity" != "-" ] || { echo "notarize: needs a Developer ID build; set COMPANION_SIGN_IDENTITY (see docs/signing.md)"; exit 2; }
[ -n "$profile" ] || { echo "notarize: set COMPANION_NOTARY_PROFILE to your notarytool keychain profile (see docs/signing.md)"; exit 2; }
dmg="${1:-}"
[ -n "$dmg" ] || { echo "usage: scripts/notarize.sh <dmg>"; exit 2; }
[ -f "$dmg" ] || { echo "notarize: no such DMG: $dmg"; exit 2; }
[ "$(uname -m)" = arm64 ] || { echo "notarize: Apple silicon only"; exit 1; }
app="app/build/ClaudeGPT Companion.app"
[ -d "$app" ] || { echo "notarize: build the app first (scripts/build-app.sh) with COMPANION_SIGN_IDENTITY"; exit 2; }
info="$(codesign -d --verbose=2 "$app" 2>&1)"
grep -q "^Authority=Developer ID Application: " <<<"$info" || { echo "notarize: the built app is not Developer ID signed; rebuild with COMPANION_SIGN_IDENTITY"; exit 2; }
dmg_info=""
if codesign --verify "$dmg" 2>/dev/null; then dmg_info="$(codesign -d --verbose=2 "$dmg" 2>&1)"; fi
grep -q "^Authority=Developer ID Application: " <<<"$dmg_info" || { echo "notarize: the DMG is not Developer ID signed; run scripts/package-app.sh with COMPANION_SIGN_IDENTITY"; exit 2; }
# The DMG carries the ticket. The app inside it is not stapled; Gatekeeper checks it online on first launch.
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait
xcrun stapler staple "$dmg"
xcrun stapler staple "$app"
spctl -a -vv -t open --context context:primary-signature "$dmg"
spctl -a -vv "$app"
echo "notarized and stapled: $dmg"
