# Signing notes

What gets signed, with what, and how the owner makes a notarized build. Nothing here needs a certificate unless it
says so. The default build is ad-hoc signed.

This repository is public. Never write a signing identity, team ID, Apple ID or notary profile name into any file in
it.

## What is signed with what

| Part | Signed with | Notes |
|------|-------------|-------|
| The app | `COMPANION_SIGN_IDENTITY` (default `-`, ad-hoc), hardened runtime | One entitlement: `com.apple.security.device.audio-input` (dictation). |
| The bundled Node.js 24.22.2 | The same identity, hardened runtime | Only two entitlements: `allow-jit` and `allow-unsigned-executable-memory`. The official build also has `get-task-allow`, `disable-library-validation`, `allow-dyld-environment-variables` and `disable-executable-page-protection`. We drop them, so the bundled Node cannot load unsigned libraries, be attached to, or be steered by environment variables. |
| Codex 0.166.0 binaries | OpenAI's Developer ID signature | Never changed. The build checks every Mach-O file in the vendor folder for that signature and the hardened runtime, and fails if one is missing. |
| The relay | Not shipped. Built per user at each daemon start | Compiled by `clang` into the user's App Support folder, ad-hoc signed by the linker. The bundle carries only its source. |
| The DMG | A real identity only | Signed when `COMPANION_SIGN_IDENTITY` is a real identity. An ad-hoc build leaves it unsigned. |

## Default: ad-hoc

With no setting, the build signs ad-hoc (`-`). Effects:

- The signature changes with every rebuild. macOS may ask for the microphone and for Keychain access again after each
  one.
- Gatekeeper blocks a copy that was downloaded or moved to another Mac. A copy built on the Mac that runs it opens
  normally.
- It cannot be notarized.

## A stable local identity

An Apple Development certificate, or a self-made code-signing certificate in your login keychain, gives the app the
same signature on every rebuild:

```bash
COMPANION_SIGN_IDENTITY="<certificate name>" bash scripts/build-app.sh
```

You get fewer microphone and Keychain prompts. The result still cannot be notarized.

## Developer ID and notarization (owner steps)

These steps need your own Apple Developer account. They are not run by any agent or by CI.

1. Have a "Developer ID Application" certificate and its private key in your login keychain.
2. Once, store notary credentials under a profile name of your choice:

   ```bash
   xcrun notarytool store-credentials "<profile name>"
   ```

   It asks for your Apple ID, team and an app-specific password, and keeps them in the keychain. Never put them in the
   repository, an env file or a chat.
3. Build with the identity:

   ```bash
   COMPANION_SIGN_IDENTITY="Developer ID Application: <you>" bash scripts/build-app.sh
   ```

4. Smoke the bundle (it needs no identity):

   ```bash
   bash scripts/smoke-bundle.sh
   ```

5. Package it:

   ```bash
   COMPANION_SIGN_IDENTITY="Developer ID Application: <you>" bash scripts/package-app.sh
   ```

6. Notarize and staple the DMG (and the app):

   ```bash
   COMPANION_SIGN_IDENTITY="Developer ID Application: <you>" \
   COMPANION_NOTARY_PROFILE="<profile name>" \
   bash scripts/notarize.sh app/build/ClaudeGPT-Companion-0.7.0.dmg
   ```

   `scripts/notarize.sh` refuses an ad-hoc build. It reads no credential itself: `notarytool` takes them from your
   keychain profile.
7. Expect `spctl` to say `accepted` and `source=Notarized Developer ID`, for the DMG and for the app.

If notarization fails, fetch the log with the submission id that `notarytool` printed:

```bash
xcrun notarytool log <id> --keychain-profile "<profile name>"
```

Common causes:

- A Mach-O file that is unsigned, signed with a different identity, or signed without the hardened runtime.
- The `get-task-allow` entitlement on any binary. This build does not use it.
- A signature without a secure timestamp. The build adds one when the identity is real.

## Not measured by the agent

By design the agent has no credentials, so these were never run: Developer ID signing, notarization, stapling and
Gatekeeper acceptance. The agent measured the ad-hoc build, the Codex signature checks, the bundle smoke and the DMG.
Notarization is covered only by the owner checklist, row 13 in [manual/m7-checklist.md](manual/m7-checklist.md).
