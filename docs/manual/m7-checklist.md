# M7 manual checklist (spec §14 M7)

Run on this Mac, from a clean install of the packaged app (version 0.7.0). Record each result as PASS / FAIL / NOT
RUN with a short note. Use synthetic data or Context Off only: no real repositories, and never paste reply text.
Write repository paths as `<repo>`.

| # | Check | Who | Result |
|---|-------|-----|--------|
| 1 | `bash scripts/build-app.sh` ends with `built and verified: … (version 0.7.0, …)` | Owner | Result: |
| 2 | `bash scripts/smoke-bundle.sh` ends with `smoke-bundle: OK` | Owner | Result: |
| 3 | `bash scripts/package-app.sh` ends with `packaged: …` and `app/build/ClaudeGPT-Companion-0.7.0.dmg` exists | Owner | Result: |
| 4 | Clean install: quit any running copy and remove older copies (copies in `app/build` may stay). Open the DMG and drag the app into /Applications | Owner | Result: |
| 5 | First launch from /Applications: the panel opens, Settings › Advanced shows companiond running, and there is no "Node.js … not found" message | Owner | Result: |
| 6 | In Activity Monitor (or `ps -o command= -p <pid>`), companiond's Node is `/Applications/ClaudeGPT Companion.app/Contents/Resources/node/bin/node`, not a Homebrew Node | Owner | Result: |
| 7 | Sign-in state: the earlier ChatGPT sign-in is still there (same App Support folder), or sign in again with "Sign in with ChatGPT" | Owner | Result: |
| 8 | In a synthetic repo (a fresh `git init` folder with one made-up file), set Context to **Off** and ask one question. A reply arrives and the repo tool call is shown | Owner | Result: |
| 9 | Primary acceptance re-run, as in `m5-checklist.md`: `bash scripts/tree-hash.sh <repo>` before and after row 8 gives the same hash | Owner | Result: |
| 10 | Dictate once. The microphone prompt names ClaudeGPT Companion (it may appear again after an ad-hoc rebuild) | Owner | Result: |
| 11 | Only if Jira was set up in M6: it is still configured. One Keychain prompt after the rebuild is expected | Owner | Result: |
| 12 | Optional: the uninstall steps in `docs/install.md` work | Owner | Result: |
| 13 | Optional, Developer ID: follow `docs/signing.md`. `spctl` accepts the app and the DMG as Notarized Developer ID | Owner | Result: |

Every row needs the owner at the Mac. What an agent can check without a person is in `scripts/smoke-bundle.sh`
(signed-out run of the bundle's own Node and companiond, Codex host ready, Seatbelt suites under the bundled Node)
and `scripts/test-packaging.sh`.
