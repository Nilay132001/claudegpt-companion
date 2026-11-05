# Install guide

How to build ClaudeGPT Companion on your Mac, install it and remove it again. There is no download: you build the
app yourself from this repository. For signing, see [signing.md](signing.md).

## 1. Requirements

To run it:

- A Mac with Apple silicon. Intel Macs are not supported.
- macOS 26 or newer.
- The Xcode command-line tools: `xcode-select --install`. companiond compiles its small relay with `clang` every time
  it starts, and it runs `git` through `xcrun`.
- A ChatGPT plan that includes Codex.

To build it, you also need:

- Full Xcode (Swift 6.2).
- Node 24 or newer. It is only used to run `npm ci` and the scripts. The app ships its own Node.

## 2. Build

Run these from the repository root:

```bash
(cd companiond && npm ci)
bash scripts/build-app.sh
bash scripts/smoke-bundle.sh
bash scripts/package-app.sh
```

What each one prints when it worked:

| Command | Last line |
|---------|-----------|
| `scripts/build-app.sh` | `built and verified: app/build/ClaudeGPT Companion.app (version 0.7.0, identity: -)`. Just before it: `codex: N Mach-O files verified`. |
| `scripts/smoke-bundle.sh` | `smoke-bundle: OK` |
| `scripts/package-app.sh` | `packaged: app/build/ClaudeGPT-Companion-0.7.0.dmg` |

Notes:

- The first build downloads the pinned Node.js 24.22.2 (official nodejs.org, darwin-arm64) and checks its SHA-256
  against `app/bundle/node.pin`. To build offline, put a copy of that tarball somewhere and set
  `COMPANION_NODE_TARBALL` to its absolute path. It is still checked against the pin.
- The `codex:` line means every Mach-O file in the bundled Codex folder carries OpenAI's Developer ID signature and
  the hardened runtime. The build checks this and never re-signs those files.
- The smoke test starts the bundle's own Node and companiond with a throw-away `HOME` under `/tmp`, signed out. It
  needs the Codex host to reach ready, so the pre-start self-check has passed from inside the bundle. Then it runs the
  Seatbelt suites under the bundled Node. It does not sign in and does not send a message.
- The bundle is about 467 MB, mostly Codex and Node.

## 3. Install

1. Quit a running copy of ClaudeGPT Companion.
2. Open `app/build/ClaudeGPT-Companion-0.7.0.dmg`.
3. Drag the app onto Applications. Replace the old copy if asked.
4. Eject the disk image.

Or, without the DMG:

```bash
ditto "app/build/ClaudeGPT Companion.app" "/Applications/ClaudeGPT Companion.app"
```

## 4. First launch

Open the app from Applications. Expect:

- A Dock icon and the panel.
- Settings › Advanced shows companiond running.
- Microphone and Speech Recognition prompts appear only the first time you dictate.
- Accessibility is asked for only if you turn on follow-window.

An ad-hoc build is not notarized. A copy you built on this Mac opens normally. A copy that was downloaded or copied
from another Mac is blocked by Gatekeeper. Build it on the Mac that runs it, or use a Developer ID build (see
[signing.md](signing.md)).

## 5. Sign in

Use "Sign in with ChatGPT" in the app. A browser opens. Codex listens on port 1455 on this Mac only while you sign in.
No API key is involved.

## 6. What stays where

- `~/Library/Application Support/ClaudeGPTCompanion/`: the database, the Codex home, and the relay's `run/` and `bin/`
  folders.
- Keychain: Codex's ChatGPT sign-in, and `ClaudeGPT Companion Jira` if you set up Jira.
- Settings: the UserDefaults domain `local.claudegptcompanion.app`.

Claude Desktop and Claude Code are never changed.

## 7. Update

Rebuild and replace the app, as in sections 2 and 3. After an ad-hoc rebuild macOS may ask again for the microphone
and for Keychain access, because the signature changed. A stable signing identity avoids this: set
`COMPANION_SIGN_IDENTITY` (see [signing.md](signing.md)).

## 8. Uninstall

1. Quit the app.
2. Delete `/Applications/ClaudeGPT Companion.app`.

Optional clean-up of what it left behind.

Deleting the App Support folder also deletes the companion's ChatGPT sign-in state and its local database. This cannot be undone.

```bash
rm -r ~/Library/Application\ Support/ClaudeGPTCompanion
defaults delete local.claudegptcompanion.app
tccutil reset Microphone local.claudegptcompanion.app
tccutil reset SpeechRecognition local.claudegptcompanion.app
tccutil reset Accessibility local.claudegptcompanion.app
```

Then delete the Keychain items in Keychain Access: the ChatGPT sign-in item that Codex made, and `ClaudeGPT Companion
Jira`. Nothing of Claude Desktop or Claude Code was ever changed, so there is nothing to undo there.

## 9. Troubleshooting

| You see | Do this |
|---------|---------|
| "Node.js 24 or newer was not found" | The app's own Node is missing or broken. Rebuild with `scripts/build-app.sh` and reinstall. |
| "The relay did not build" | Install the command-line tools: `xcode-select --install`. |
| "Security check failed" | Read the reason shown in the panel, acknowledge it in the panel to restart, and report it. It means a safety check refused to continue. |
| Jira says it could not be reached, behind a company proxy | A proxy that intercepts TLS with a private root certificate breaks Jira. This is a known limit (see `docs/manual/m6-checklist.md`). |
| macOS says the app is damaged or from an unidentified developer | It was not built on this Mac. See section 4. |
