# M5 manual checklist (spec §12.3, §12.4, §14 M5)

Run on this Mac with the signed bundle (`bash scripts/build-app.sh`). Record each result as PASS / FAIL / NOT RUN
with a short note. No personal data: write repository paths as `<repo>`, never paste reply or transcript text.
Rows marked **Owner** need the owner at the Mac (speaking, listening, signing in).

| # | Check | Who | Result |
|---|-------|-----|--------|
| 1 | First dictation asks for Microphone, then Speech Recognition; denying either shows the System Settings hint | Owner | NOT RUN — needs the owner at the Mac |
| 2 | Dictation: red mic while recording, live grey text, final text lands in the field and can be edited before Send | Owner | NOT RUN — needs the owner at the Mac |
| 3 | Missing speech assets download with a progress line | Owner | NOT RUN — needs the owner at the Mac |
| 4 | `COMPANION_SPEECH_TESTS=1 swift test --filter "DictationTests\|ReadAloudTests"` (clip transcription, delegate sequence) | Agent | PASS (17 tests in 2 suites, 2026-11-05; `transcribesASaidClip`, `realDelegateSequence`, `writeProducesAudio` ran, audible speech) |
| 5 | Read Aloud is audible; pause, resume and stop act at word boundaries; a new 🔊 stops the old one | Owner | NOT RUN — needs the owner at the Mac |
| 6 | Speed 0.5× and 2× sound slower and faster; voice choice applies; auto-play reads a finished reply; "read code" on/off | Owner | NOT RUN — needs the owner at the Mac |
| 7 | ⌥⌘G toggles the panel; a changed shortcut works; a taken shortcut shows the message | Agent | NOT RUN — needs the owner at the Mac (hotkey press) |
| 8 | Follow window on: Accessibility prompt; the panel stays flush left of Claude while Claude moves and resizes; off: normal window | Agent | NOT RUN — needs the owner at the Mac (permission prompt, window moves) |
| 9 | Accessibility denied: the note explains and the panel stays movable | Agent | NOT RUN — needs the owner at the Mac (permission prompt) |
| 10 | Light and dark appearance | Agent | NOT RUN — needs the owner at the Mac (visual check) |
| 11 | Ask mode: preview lists items; a removed item is absent in "View what was sent"; Cancel sends nothing | Agent | NOT RUN — needs the owner at the Mac (GUI, signed-in chat) |
| 12 | Off sends no Claude context (View what was sent shows only the repository line); Automatic needs the confirmation | Agent | NOT RUN — needs the owner at the Mac (GUI, signed-in chat) |
| 13 | An unapproved repo shows the banner; Approve works; approving the home folder is refused with the plain reason; revoking a repo while a reply runs in it shows "still being stopped" in Settings › Privacy (needs a long-running tool reply; a reply that stops at once shows no notice) | Agent | NOT RUN — needs the owner at the Mac (GUI clicks) |
| 14 | Reply links are not clickable and show their URL; no image loads; clicking `path:line` in a selectable reply reaches the app's handler and opens the editor at the line; a `path:line` to a `.command` or `.app` inside the repo is only revealed in Finder | Agent | NOT RUN — needs the owner at the Mac (GUI clicks) |
| 14b | Security stop: the panel shows the reason and only "acknowledge and restart" clears it; Settings hides the restart buttons meanwhile | Agent | NOT RUN — needs the owner at the Mac (GUI clicks) |
| 14c | Ask mode refuses to send without the sheet (a send from the sheet carries `confirmed: true`); "Send again" after a busy error reuses the prepare | Agent | NOT RUN — needs the owner at the Mac (GUI clicks) |
| 14d | Dictation: stop a long dictation (> 20 s of speech); the last words still arrive (stop waits at most 2 s for final text) | Owner | NOT RUN — needs the owner at the Mac |
| 15 | Quit stops companiond within 5 s (`pgrep -f companiond/src/daemon/main.ts` empty) | Agent | PASS (headless: app quit via osascript, no companiond within 5 s; 2026-11-05) |
| 16 | **Primary acceptance test** (below) | Owner | NOT RUN — needs the owner at the Mac |

## Primary acceptance test (spec §1, §12.4)

1. With the Claude session idle: `bash scripts/tree-hash.sh <repo>` → record as `before`.
2. In Claude Code Desktop select that session. In the companion the header shows its title and `<repo>` with the live branch.
3. Ask: "In simple words, what is Claude working on and which file matters most?" Confirm the preview.
4. The reply describes the right conversation and cites a real file in `<repo>` as `path:line`; uncommitted changes are visible to it.
5. Click 🔊: the reply is read aloud.
6. `bash scripts/tree-hash.sh <repo>` → record as `after`. PASS only if `after` equals `before` and there was no security alert.

| Step | Result |
|------|--------|
| before | |
| right conversation and repository | |
| simple explanation with path:line | |
| read aloud | |
| after (equals before) | |
