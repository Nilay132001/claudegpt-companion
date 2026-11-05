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
app="app/build/ClaudeGPT Companion.app"
info="$(codesign -d --verbose=2 "$app" 2>&1)"
grep -q "^Authority=Developer ID Application: " <<<"$info" || { echo "notarize: the built app is not Developer ID signed; rebuild with COMPANION_SIGN_IDENTITY"; exit 2; }
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait
xcrun stapler staple "$dmg"
xcrun stapler staple "$app"
spctl -a -vv -t open --context context:primary-signature "$dmg"
spctl -a -vv "$app"
echo "notarized and stapled: $dmg"
