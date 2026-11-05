# M5 — SwiftUI App + Speech (first usable release) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The native macOS sidebar the owner actually uses: a panel left of Claude Code Desktop that talks to `companiond`, shows the selected Claude session, asks GPT with a preview the user confirms, renders the reply safely, reads it aloud, and takes dictation — and passes the primary acceptance test.

**Architecture:** Two SwiftPM targets. `CompanionCore` holds everything testable: the JSON-RPC codec and client for the M4b daemon API, Codable mirrors of its types, the daemon process launcher, the chat reducer, `AppModel` (`@Observable`, `@MainActor`), reply Markdown sanitising and `path:line` links, Read Aloud and dictation controllers, panel geometry and hotkey parsing. `CompanionApp` is the thin AppKit/SwiftUI shell: the `NSPanel`, Carbon hotkey, Accessibility follower, views and settings. The app never reads Claude's files: every session, transcript and repository fact comes from `companiond` over stdio.

**Tech Stack:** Swift 6.2 (Swift 6 language mode), SwiftUI + AppKit on macOS 26, Swift Testing (`swift test`), `Speech` (`SpeechAnalyzer` + `SpeechTranscriber`), `AVFoundation` (`AVSpeechSynthesizer`, `AVAudioEngine`), `ApplicationServices` (AX), Carbon `RegisterEventHotKey`. `companiond` (Node ≥ 24, M4b) as the child process.

**Spec:** `docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md` v3.4 — §1 (acceptance test), §2, §3 (SwiftUI shell row), §4, §5, §6.2, §6.3, §7.4–§7.8, §8, §9, §12.3, §12.4, §14 (M5 row), §15 D2. Depends on **M4b** (`docs/superpowers/plans/2026-11-04-m4b-context-daemon.md`, "Interfaces produced for M5", Task 8's bundle). Read both before any task.

**Review status:** reviewed twice (2026-11-05) against the spec, the M4b plan and the M4b part 2 branch; all Critical and Important findings and the minors are applied. Reconciled with merged M4b (PR #10) and spec v3.4, with a scoped review of that change. Not yet implemented.

## Global Constraints

- **Platform:** `LSMinimumSystemVersion` 26.0, `platforms: [.macOS(.v26)]`, `swift-tools-version: 6.2` (Swift 6 strict concurrency). Tests use Swift Testing (`import Testing`, `@Test`, `#expect`), run with `cd app && swift test`.
- **No change to Claude Desktop or Claude Code configuration.** The app writes nothing under `~/.claude`, Claude's Application Support or any project, installs nothing into Claude, and never injects into Claude's process. Claude's window geometry is read only through public APIs: `CGWindowListCopyWindowInfo` bounds (no permission) and, when the user turns on "Follow Claude window", `AXUIElement` frame reads (spec §7.7, §8, D2).
- **The app reads no Claude files at all.** It never opens `~/.claude/**`, `~/.claude/sessions/*.key`, `messagingSocketPath`, Claude's records or any credential; everything comes from `companiond`. A source-rule test enforces the banned strings (Task 1).
- **No credential logging or copying.** No `print`, `NSLog` or `debugPrint` in `app/Sources`. `os.Logger` only with fixed short codes, never message bodies, transcript text, paths or tokens. The daemon's stderr is discarded (`FileHandle.nullDevice`).
- **Never send complete raw transcripts automatically.** The app only ever calls `chat.send` with a `prepareId` from `chat.prepare` in the same flow. Ask (default) → the preview sheet must be confirmed; Off → send at once (the daemon includes no transcript); Automatic → only after the user picked it in a confirmation dialog. Cancelling a preview sends nothing.
- **Show `REDACTION_NOTICE`** — "Redaction reduces risk; it does not guarantee every secret is removed." — in the preview sheet, the Automatic confirmation, and Settings › Privacy. The text comes from `privacy.get.redactionNotice`; `RedactionNotice.text` is the fallback and is tested equal to the spec sentence.
- **Untrusted text stays text.** Transcript items, preview items, sent context, session titles, paths, branch names and daemon messages are shown with `Text(String)` (verbatim). Never `LocalizedStringKey(...)` or `AttributedString(markdown:)` on them. GPT replies go only through `ReplyMarkdown`, which removes every link and image and adds only `path:line` links inside the bound root (spec §7.1.9 (vi-a): the companion must not auto-load remote images).
- **No unapproved code writes.** The app has no file-writing code for repositories. Opening `path:line` hands a file URL to the user's editor; the app itself writes nothing.
- **No API keys.** Sign-in is `auth.login` → open the returned `https` URL in the user's browser.
- **Public repo hygiene:** no personal data, no `/Users/<name>/` paths, no transcripts, no Claude session ids in committed files; fixtures are synthetic and carry `SYNTHETIC FIXTURE`. No license file. `bash scripts/check-repo.sh` before every commit.
- **Signing identity** comes from `COMPANION_SIGN_IDENTITY` (default ad-hoc `-`). No signing secrets in the repo; no notarization (M7).
- **File edits go through the editor tools,** never Bash heredocs, redirects or `tee`.
- **If the aiptf-guard PreToolUse hook blocks a command, STOP** and report the exact command and message. Never retry it in another form.
- **Commit trailer**, copied literally: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Branch** `feat/m5-swiftui-app`, cut from `main`. M4b part 2 is on `main` (PR #10), so the daemon integration test (Task 4) runs from the start; Tasks 1–12 otherwise build and test against fakes. Task 13 re-checks the contract against whatever `main` holds then and runs the app against the real daemon.

## Daemon API (reconciled with merged M4b)

**Reconciled 2026-11-05 with `main` after M4b part 2 merged (PR #10, a1947ea):** checked against the merged `companiond/src/daemon/protocol.ts` (`METHODS`, `EVENTS`, `ErrorCodes`, `SECURITY_FAILED_PREFIX`), `handlers.ts` (`buildHandlers`, `wirePrepared`, `wireEvents`, `toDaemonError`), `main.ts`, `chat/chatService.ts` (`Prepared`), `store/store.ts` (`UI_KEY`), the merged M4b plan's "Interfaces produced for M5" and spec v3.4 §7.5 / §8 "What the daemon gives the UI". Every name, param, result, notification and error code below matches the merged code. The app relies on exactly these and nothing else. Task 13 re-runs the same diff before implementation starts, in case `main` moved again.

**Transport.** The app spawns `node --disable-warning=ExperimentalWarning <companiond>/src/daemon/main.ts`. JSON-RPC 2.0, one JSON object per line (UTF-8, `\n`); requests on stdin, responses and notifications on stdout; stderr is diagnostics only. The app sends no notifications. First call `daemon.hello`. Closing stdin shuts the daemon down. `result` may be `null` (`sessions.worktree`).

**Errors** `{ code, message, data? }`, `message` user-presentable: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal; `1001` securityCheckFailed, `1002` hostNotReady, `1003` repoRefused, `1004` prepareExpired, `1005` turnBusy, `1006` approvalRefused (`data: { reason: "not_absolute" | "missing" | "home_or_root" | "repo_refused" | "not_toplevel" }`), `1007` unknownSession, `1008` emptyQuestion, `1009` hostBusy (capacity: show the message, try again later; the host stays ready), `1010` prepareStale (the sharing mode changed since `chat.prepare`, or an approval was revoked while the send was in progress: prepare again and re-confirm; an added approval never makes a prepare stale), `1011` confirmRequired (an Ask-mode send, or an unknown prepare while the mode is Ask, without `confirmed: true`; the prepare stays usable). Any other code: show `message`. `host.restart` answers `1001` while the host is in a security stop.

**Retry rule (M4b).** A `prepareId` is used up only when its turn starts. After `1009`, `1005` or `1002` the same `prepareId` can be sent again until it expires; after `1004` or `1010` call `chat.prepare` again; after `1011` prepare again and show the sheet. **Security stop:** `HostState {state:"failed", detail}` with `detail` starting `"Security check failed"` stays until the owner presses Acknowledge, which alone sends `host.acknowledgeSecurityStop`; `host.restart` does not clear it.

**Methods used** (params → result):

| Method | Params | Result |
|---|---|---|
| `daemon.hello` | `{ protocolVersion: 1 }` | `{ protocolVersion: 1, daemonVersion: string }` |
| `daemon.shutdown` | `{}` | `{}` |
| `host.status` / `host.restart` | `{}` | `HostState` (`host.restart`: `1001` during a security stop) |
| `host.acknowledgeSecurityStop` | `{}` | `HostState` (invalidRequest if there is no security stop) |
| `auth.status` | `{}` | `AuthState` |
| `auth.login` | `{}` | `{ authUrl: string }` (https) |
| `sessions.snapshot` / `sessions.refresh` | `{}` | `SessionsSnapshot` |
| `sessions.pin` | `{ sessionId: string \| null }` | `Selection` |
| `sessions.picker` | `{ query?: string, includeArchived?: boolean }` | `{ busy, idle, recent, older: SessionSummary[] }` |
| `sessions.sync` | `{ sessionId }` | `SyncStatus` |
| `sessions.worktree` | `{ sessionId }` | `WorktreeResolution \| null` |
| `privacy.get` | `{}` | `{ sharingMode, approvals: ApprovedRoot[], redactionNotice }` |
| `privacy.setSharingMode` | `{ mode: "off" \| "ask" \| "automatic" }` | `{ sharingMode }` |
| `privacy.approve` | `{ root, includeWorktrees: boolean }` | `ApprovedRoot` |
| `privacy.revoke` | `{ root }` | `{ revoked: boolean, pendingClose: number }` (answers after the threads on roots no longer approved are closed; `pendingClose` = those still finishing a reply; if any is still open after 30 s and the host is ready, the daemon restarts Codex. Spec §8: the app shows it) |
| `chat.prepare` | `{ sessionId, question }` (question ≤ 20 000 UTF-16 units) | `Prepared` |
| `chat.send` | `{ prepareId, removeItemIds: string[], confirmed: boolean }` | `{ threadId, turnId }` |
| `chat.interrupt` | `{ sessionId }` | `{}` |
| `chat.sent` | `{ sessionId }` | `SentRecord[]` |
| `settings.get` | `{ key }` | `{ value: string \| null }` |
| `settings.set` | `{ key, value: string }` | `{}` |

Settings keys must match the Store's `^ui\.[a-z0-9_.]{1,64}$` (lowercase only; `companiond/src/store/store.ts`), else `-32602`. `sessions.picker.query` ≤ 200 UTF-16 units.

**Notifications used:** `host.changed` `HostState`; `auth.changed` `AuthState`; `sessions.changed` `SessionsSnapshot`; `session.transcript` `{ sessionId, kind: "append" | "reset" | "missing", dropped, stats: SyncStats }`; `session.worktree` `{ sessionId, resolution, change: RepoChange | null }`; `session.syncError` `{ message }`; `chat.delta` `{ sessionId | null, threadId, turnId, itemId, text }` (agent-message text only, M4a `item/agentMessage/delta`); `chat.item` `{ sessionId | null, threadId, turnId, phase: "started" | "completed", item: { id, type, server, tool, status } }`; `chat.turnCompleted` `{ sessionId | null, threadId, turnId, status, error | null }` (status `"completed"`, `"interrupted"`, `"failed"`, or `"abandoned"` = Codex restarted before the reply finished; delta, item and even turnCompleted can arrive before the `chat.send` response); `chat.threadReplaced` `{ sessionId, threadId, reason: "resume_refused" }` (the conversation continues in a new thread without GPT's earlier history: tell the user); `security.alert` `{ sessionId | null, threadId | null, turnId | null, kind: "guard" | "server_request" | "process", detail }`. Unknown methods are ignored.

**Types** (fields the app decodes; extra fields are ignored):
- `HostState`: `{state:"stopped"} | {state:"starting"} | {state:"ready", warnings: string[]} | {state:"failed", detail}`.
- `AuthState`: `{state:"signed_in", planType: string|null} | {state:"signed_out"} | {state:"unsupported", mode}`.
- `SessionSummary` (M3): `sessionId, cliSessionId?, title, status: "busy"|"idle"|"recent"|"inactive", isArchived, lastFocusedAt?, lastActivityAt?, recordCwd?, recordBranch?, resolvedRoot?, source, transcriptMissing?`.
- `Selection` (M3): `sessionId?, via: "pin"|"focus"|"none", focusedSessionId?, focusLabel, focusMovedTo?, pinnedMissing`.
- `SessionsSnapshot`: `sessions, selection, desktopRecordsError?, refreshedAt`.
- `SyncStats`: `records, malformedLines, unknownRecords, droppedEvents` (+ tail stats; missing ones default to 0). `SyncStatus`: `state: "live"|"missing"|"not_tracked", stats?, lastPollAt?`.
- `WorktreeResolution` (M3): `{kind:"resolved", root, branch?, isLinkedWorktree, …} | {kind:"unavailable", reason, detail, candidate?, root?, …}`. `RepoChange`: `from?, to?, banner, contextNote`.
- `ApprovedRoot`: `root, commonDir, includeWorktrees, approvedAt`.
- `RepoLine`: `state: "bound"|"unavailable"|"none", root?, branch?, detail?`. `PreviewItem`: `id, kind, label, text, redactions`. `ContextPreview` (wire preview): `items, notes, omitted, bytes`. `Prepared`: `prepareId, sessionId, mode, preview?, needsConfirm, repo, repoNote?, sessionTitle?` (`needsConfirm` is true for every Ask prepare; `sessionTitle` and `repoNote` are null in Off; the preview sheet shows `sessionTitle` because it is sent). `SentRecord`: `sessionId, threadId, turnId, contextBlock, question, sentAt`.

**Reconciliation results (formerly "Needed from M4b").** Nothing is left as an assumption, and M5 needs no companiond change:
- **N1 — abandoned turns: in merged code.** `wireEvents.reportAbandoned` sends `chat.turnCompleted` with `status: "abandoned"` and `error: "Codex restarted before this reply finished. Ask again."` after `host.changed`, `auth.changed` and process alerts; the reducer shows it as a failed reply. The app does not guess from `host.changed` (ruling 15).
- **N2 — `HostBusyError`: in merged code** (`toDaemonError` → `1009`). Like `1005` and `1002`, the reply bubble offers "Send again" with the same `prepareId`.
- **N3 — prepare lifetime: 10 min** (merged plan text); the app handles `1004` and `1010` by preparing again, whatever the lifetime.
- **N3b — confirmation flag: in merged code** (`chat.send` reads `confirmed` with default `false`; `1011` when the prepare needs it, or when the daemon does not know the prepare and the mode is Ask). The app sends `confirmed: true` only from the preview sheet's Send button. On `1011` it prepares again and shows the sheet; spec v3.4 allows confirming the same prepare too, and re-preparing is the simpler of the two allowed paths.
- **N4 — daemon inside the bundle: not an API item.** `discoverToolchain` takes `codeDir` from the daemon's own location (`…/ClaudeGPT Companion.app/Contents/Resources/companiond`, a path with a space; `sbString` allows it). Task 13 Step 4 measures a bound tool call from the bundle.
- **N5 — chat history: not needed by M5.** There is no method for a thread's past turns and M5 does not need one: the chat shows this run's turns (ruling 4), and the spec (§7.5, M4b) says earlier turns stay in the Codex thread. A history method is a later milestone's choice.
- **N6 — revoke `pendingClose`: added to the app in this reconciliation.** Spec v3.4 §8 says "Revoke shows `pendingClose` threads still finishing". Tasks 2, 3, 7 and 11 now decode it and show it in Settings › Privacy.

## Rulings made while planning (each with what it costs if wrong)

1. **companiond runs from the bundle with the user's Node ≥ 24.** `scripts/build-app.sh` copies `companiond/src`, `package.json` and `package-lock.json` into `Contents/Resources/companiond` and runs `npm ci --omit=dev --ignore-scripts` there. Node itself is found at `COMPANION_NODE`, the Advanced setting, `/opt/homebrew/bin/node` or `/usr/local/bin/node` and must report ≥ v24. Bundling Node is M7. *If wrong:* a Mac without Node 24 shows "Node.js 24 or newer was not found"; M7 fixes it by bundling.
2. **A regular app with a titled `NSPanel` at normal window level** (Dock icon, menu bar, ⌘, Settings, ⌘Q). *If wrong:* switching to an accessory app is a one-line activation-policy change plus a menu-bar item.
3. **Links in GPT replies are not clickable.** A Markdown link shows as `text (url)`; images are dropped; only `path:line` inside the bound root becomes a link, opened in the editor. *If wrong:* the user copies a URL by hand.
4. **Chat history lasts for the app run** (no daemon history method, N5). *If wrong:* the chat is empty after a restart; the Codex thread still has it.
5. **Choosing a session in the picker pins it.** The "Claude focus moved to X — switch?" chip's Switch goes back to following focus (`sessions.pin(null)`). *If wrong:* one extra click to unpin.
6. **UI settings live in the daemon Store as `ui.*` keys**, except the Node path, which is in `UserDefaults` because it is needed before the daemon runs. *If wrong:* two places for settings; harmless.
7. **Minimal daemon environment:** `PATH=/usr/bin:/bin:/usr/sbin:/sbin` plus `HOME`, `USER`, `LOGNAME`, `TMPDIR` and `COMPANIOND_CODEX` when it is set (only tests and development set it; the daemon reads only `off`). No other variables (API keys in the app's environment never reach the daemon). *If wrong:* a variable Codex needs is missing; the host reports `failed` with a reason and the fix is one key.
8. **The approval sheet's "include this repo's worktrees" is on by default,** because every Claude Desktop session runs in its own worktree (spec §7.5, F5). *If wrong:* sibling worktrees of the same repo are readable; the toggle says so before the click.
9. **Dictation asks for Microphone and Speech Recognition on first use** (spec §7.8). *If wrong:* one extra permission prompt.
10. **Speech tests that need downloaded assets or an audio device are opt-in** (`COMPANION_SPEECH_TESTS=1`, run locally in Task 14). CI runs every other test, including the `AVSpeechSynthesizer.write` test when voices exist. *If wrong:* a dictation regression shows up only in the local run.
11. **The daemon integration test turns itself on** when `companiond/src/daemon/main.ts` exists and Node ≥ 24 is found (CI's app job installs Node 24). *If wrong:* it silently skips on a Mac without Node; the checklist run still covers it.
12. **Editor:** default "Automatic" = VS Code's `vscode://file/<path>:<line>` if VS Code is installed, else the system default app for the file. Cursor, Xcode (`xed --line`) and "System default" are choices. *If wrong:* the user changes one setting.
13. **"Explain Claude's last message"** sends the fixed question "Explain Claude's last message simply." through the normal prepare flow (the preview still applies). *If wrong:* a wording change.
14. **Choosing Automatic needs a confirmation dialog** that shows the notice. *If wrong:* one extra click.
15. **Replies end only on the daemon's word** (`chat.turnCompleted`, including `"abandoned"`), except when the daemon process itself disconnects, which marks running replies "companiond stopped." *If wrong:* a reply whose end the daemon never reports keeps spinning until Stop or a daemon restart.16. **First placement:** at the left edge of the screen that holds Claude's window (from `CGWindowListCopyWindowInfo` bounds), full visible height, width from settings (default 360, clamped 280–640). *If wrong:* the user drags the panel once.
17. **Bundle version 0.5.0.**
18. **Security stops need an explicit Acknowledge** (`host.acknowledgeSecurityStop`); the panel hides "Try again" for that state and Settings hides "Restart Codex" and "Restart companiond" while it lasts, so within a run a restart cannot be used to skip reading it. The latch lives in companiond's memory (M4b), so quitting the app or a daemon that dies clears it; a dead daemon may then be restarted from the panel (otherwise the user is locked out). Persisting an unacknowledged stop across relaunches is left to M7. *If wrong:* one extra click after a security stop; or, the other way, a relaunch skips the acknowledgement.
19. **Links in replies open only safe files.** A `path:line` link opens only a regular, non-package file whose type is not executable, an app, a bundle, a package, a shell script, HTML or an internet location; "Default app for the file" opens text and source files only, anything else is revealed in Finder. *If wrong:* the user opens such a file by hand.
20. **"Explain Claude's last message" is hidden in Off mode** (Off sends no Claude context, so GPT could not see the message). *If wrong:* one less button in Off.
21. **Settings keys are lowercase** (`ui.speech.autoplay`, `ui.speech.read_code`, …) because the Store accepts only `^ui\.[a-z0-9_.]{1,64}$`. *If wrong:* none; a test checks every key against that pattern.

## Spec changes this plan makes

Task 14 writes these into the spec.

1. **§8 replies:** links are not clickable and show their URL; images are never loaded; only `path:line` references inside the bound root open in the editor.
2. **§8 chat history:** the chat shows the turns of the current run; earlier turns stay in the Codex thread (until a daemon history method exists).
3. **§8 window:** a regular app (Dock icon) whose panel is a titled `NSPanel` at normal level; first placement at the left edge of Claude's screen.
4. **§9 / §2:** the app runs `companiond` from `Contents/Resources/companiond` with the user's Node ≥ 24 (found as in ruling 1). Bundling Node is M7.
5. **§7.8:** the daemon gets a minimal environment and its stderr is discarded; the app logs fixed codes only.

## File structure

```
app/Package.swift                                   (unchanged targets; new files are picked up by folder)
app/Sources/CompanionCore/
  Daemon/JSONValue.swift          JSON value type used for params and raw results
  Daemon/RPCCodec.swift           request encoding, line decoding (response / notification)
  Daemon/DaemonModels.swift       Codable mirrors of the M4b types, error codes, DaemonEvent
  Daemon/DaemonAPI.swift          the DaemonAPI protocol + Connection
  Daemon/DaemonClient.swift       actor: ids, pending calls, events stream; DaemonAPI conformance
  Daemon/LineTransport.swift      LineTransport protocol, LineSplitter, ProcessTransport
  Daemon/DaemonLocator.swift      Node and companiond discovery, launch spec, live connector
  Chat/Conversation.swift         per-session chat reducer (deltas, early events, status)
  Model/AppModel.swift            @Observable app state and actions
  Model/AppModel+Display.swift    header, banner and gate text (pure, tested)
  Model/UISettings.swift          ui.* keys, defaults, parsing, EditorChoice
  Text/RedactionNotice.swift      the spec sentence (fallback)
  Text/FileReferences.swift       path:line detection, containment, editor URLs
  Text/ReplyMarkdown.swift        reply blocks + sanitised inline AttributedString
  Speech/ReadAloud.swift          ReadAloudController, SpeechSynthesizing, AVSpeechAdapter
  Speech/Dictation.swift          DictationController, DictationEngine, permissions
  Speech/SpeechAnalyzerEngine.swift  SpeechAnalyzer + SpeechTranscriber engine, file transcription
  Window/PanelGeometry.swift      width clamp, docking math, AX/CG → AppKit coordinates
  Window/HotkeySpec.swift         shortcut parsing, display, Carbon codes
  SpeechText.swift                (exists, M0) markdown → speech text
app/Sources/CompanionApp/
  CompanionApp.swift              (modify) @main, Settings scene, commands
  AppDelegate.swift               lifecycle, wiring, wake, quit
  WindowCoordinator.swift         panel placement, follow, hotkey, width
  SidePanel.swift                 NSPanel subclass
  ClaudeWindowFollower.swift      AX observer + CGWindowList bounds
  HotkeyCenter.swift              RegisterEventHotKey
  FileOpener.swift                path:line → editor
  Views/SidebarView.swift  Views/HeaderView.swift  Views/PickerView.swift  Views/BannerStack.swift
  Views/ChatView.swift  Views/ReplyView.swift  Views/InputBar.swift  Views/PreviewSheet.swift
  Views/SentSheet.swift  Views/ApproveSheet.swift  Views/CenterMessage.swift  Views/SettingsView.swift
app/Tests/CompanionCoreTests/
  SourceRulesTests.swift  RPCCodecTests.swift  DaemonModelsTests.swift  DaemonClientTests.swift
  DaemonLocatorTests.swift  DaemonIntegrationTests.swift  ConversationTests.swift  AppModelTests.swift
  FakeDaemon.swift  ReplyMarkdownTests.swift  FileReferencesTests.swift  ReadAloudTests.swift
  DictationTests.swift  PanelGeometryTests.swift  HotkeySpecTests.swift  UISettingsTests.swift
  SpeechTextTests.swift (exists)
app/bundle/Info.plist             (modify) version 0.5.0
scripts/build-app.sh              (modify) stage companiond into the bundle
scripts/tree-hash.sh              acceptance-test fingerprint of a repo (read-only)
.github/workflows/tests.yml       (modify) Node 24 + npm ci in the app job
docs/manual/m5-checklist.md       mic/playback checklist + acceptance record
```

---

### Task 1: JSON value, RPC codec and source rules

**Files:**
- Create: `app/Sources/CompanionCore/Daemon/JSONValue.swift`, `app/Sources/CompanionCore/Daemon/RPCCodec.swift`, `app/Sources/CompanionCore/Text/RedactionNotice.swift`
- Test: `app/Tests/CompanionCoreTests/RPCCodecTests.swift`, `app/Tests/CompanionCoreTests/SourceRulesTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `enum JSONValue: Codable, Sendable, Equatable` (`null, bool, number(Double), string, array, object`) with `subscript(key: String) -> JSONValue?` and `var stringValue: String?`; `struct RPCErrorBody: Error, Decodable, Sendable, Equatable { code: Int; message: String; data: JSONValue? }`; `enum Incoming: Sendable, Equatable { case response(id: Int, result: Result<JSONValue, RPCErrorBody>); case notification(method: String, params: JSONValue); case orphanError(RPCErrorBody) }`; `enum RPCCodec { static func encodeRequest<P: Encodable>(id: Int, method: String, params: P) throws -> Data; static func decode(line: Data) throws -> Incoming; static func value<T: Decodable>(_ v: JSONValue, as: T.Type) throws -> T }`; `enum RedactionNotice { static let text: String }`.

- [ ] **Step 1: Write the failing tests** — `app/Tests/CompanionCoreTests/RPCCodecTests.swift`:

```swift
import Foundation
import Testing
@testable import CompanionCore

@Suite struct RPCCodecTests {
    private func line(_ s: String) -> Data { Data(s.utf8) }

    @Test func encodesOneLineRequest() throws {
        let data = try RPCCodec.encodeRequest(id: 7, method: "chat.prepare",
            params: JSONValue.object(["sessionId": .string("s1"), "question": .string("why?\nreally")]))
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.hasSuffix("\n"))
        #expect(text.dropLast().contains("\n") == false)
        let back = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(back["jsonrpc"] == .string("2.0"))
        #expect(back["id"] == .number(7))
        #expect(back["method"] == .string("chat.prepare"))
        #expect(back["params"]?["question"] == .string("why?\nreally"))
    }

    @Test func decodesResultIncludingNull() throws {
        #expect(try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0","id":1,"result":{"a":1}}"#))
            == .response(id: 1, result: .success(.object(["a": .number(1)]))))
        #expect(try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0","id":2,"result":null}"#))
            == .response(id: 2, result: .success(.null)))
    }

    @Test func decodesErrorsWithData() throws {
        let m = try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0","id":3,"error":{"code":1006,"message":"no","data":{"reason":"missing"}}}"#))
        guard case let .response(3, .failure(e)) = m else { Issue.record("not an error response"); return }
        #expect(e.code == 1006)
        #expect(e.data?["reason"]?.stringValue == "missing")
        #expect(try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}"#))
            == .orphanError(RPCErrorBody(code: -32700, message: "Parse error", data: nil)))
    }

    @Test func decodesNotifications() throws {
        #expect(try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0","method":"host.changed","params":{"state":"starting"}}"#))
            == .notification(method: "host.changed", params: .object(["state": .string("starting")])))
    }

    @Test func rejectsGarbage() {
        #expect(throws: (any Error).self) { try RPCCodec.decode(line: line("{nope")) }
        #expect(throws: (any Error).self) { try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0"}"#)) }
        #expect(throws: (any Error).self) { try RPCCodec.decode(line: line(#"[1,2]"#)) }
    }

    @Test func typedValues() throws {
        struct P: Decodable, Equatable { let x: Int; let y: String? }
        #expect(try RPCCodec.value(.object(["x": .number(2), "y": .null]), as: P.self) == P(x: 2, y: nil))
        #expect(try RPCCodec.value(.null, as: P?.self) == nil)
    }

    @Test func redactionNoticeIsTheSpecSentence() {
        #expect(RedactionNotice.text == "Redaction reduces risk; it does not guarantee every secret is removed.")
    }
}
```

`app/Tests/CompanionCoreTests/SourceRulesTests.swift`:

```swift
import Foundation
import Testing

/// Fitness rules over app/Sources (Global Constraints). Cheap, and they catch the dangerous regressions.
@Suite struct SourceRulesTests {
    static let sourcesDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "Sources")

    static func swiftFiles() -> [(name: String, text: String)] {
        let e = FileManager.default.enumerator(at: sourcesDir, includingPropertiesForKeys: nil)
        var out: [(name: String, text: String)] = []
        while let u = e?.nextObject() as? URL {
            if u.pathExtension == "swift", let t = try? String(contentsOf: u, encoding: .utf8) {
                out.append((name: u.lastPathComponent, text: t))
            }
        }
        return out
    }

    @Test func sourcesExist() { #expect(Self.swiftFiles().count >= 2) }

    @Test func neverTouchesClaudeDataOrCredentials() {
        let banned = ["/.claude", ".claude/", "claude-code-sessions", "messagingSocketPath", ".key\"",
                      "Application Support/Claude", "SecItem", "kSecClass", "auth.json"]
        for f in Self.swiftFiles() {
            for b in banned { #expect(!f.text.contains(b), "\(f.name) contains \(b)") }
        }
    }

    @Test func noConsoleLogging() {
        for f in Self.swiftFiles() {
            for b in ["print(", "NSLog(", "debugPrint(", "dump("] { #expect(!f.text.contains(b), "\(f.name) contains \(b)") }
        }
    }

    @Test func untrustedTextIsNeverParsed() {
        for f in Self.swiftFiles() {
            #expect(!f.text.contains("LocalizedStringKey("), "\(f.name) builds a LocalizedStringKey")
            if f.name != "ReplyMarkdown.swift" {
                #expect(!f.text.contains("AttributedString(markdown"), "\(f.name) parses markdown")
            }
        }
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app && swift test --filter "RPCCodecTests|SourceRulesTests"`
Expected: build FAIL — `cannot find 'RPCCodec' in scope` (and `JSONValue`, `RedactionNotice`).

- [ ] **Step 3: Implement** — `app/Sources/CompanionCore/Daemon/JSONValue.swift`:

```swift
import Foundation

/// A JSON value. Used for request params and for raw results before they are decoded into a model type.
public enum JSONValue: Sendable, Equatable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }
}
```

`app/Sources/CompanionCore/Daemon/RPCCodec.swift`:

```swift
import Foundation

public struct RPCErrorBody: Error, Decodable, Sendable, Equatable {
    public let code: Int
    public let message: String
    public let data: JSONValue?
    public init(code: Int, message: String, data: JSONValue?) {
        self.code = code
        self.message = message
        self.data = data
    }
}

public enum Incoming: Sendable, Equatable {
    case response(id: Int, result: Result<JSONValue, RPCErrorBody>)
    case notification(method: String, params: JSONValue)
    /// An error with `id: null` (the daemon could not read our line).
    case orphanError(RPCErrorBody)
}

public enum RPCCodecError: Error, Equatable { case notAMessage }

/// JSON-RPC 2.0, one object per line (M4b "Daemon API"). The app only sends requests.
public enum RPCCodec {
    private struct Request<P: Encodable>: Encodable {
        let jsonrpc = "2.0"
        let id: Int
        let method: String
        let params: P
    }

    private struct Envelope: Decodable {
        let id: JSONValue?
        let method: String?
        let params: JSONValue?
        let hasResult: Bool
        let result: JSONValue?
        let error: RPCErrorBody?

        enum K: String, CodingKey { case jsonrpc, id, method, params, result, error }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            guard try c.decodeIfPresent(String.self, forKey: .jsonrpc) == "2.0" else { throw RPCCodecError.notAMessage }
            id = try c.decodeIfPresent(JSONValue.self, forKey: .id)
            method = try c.decodeIfPresent(String.self, forKey: .method)
            params = try c.decodeIfPresent(JSONValue.self, forKey: .params)
            hasResult = c.contains(.result)
            if hasResult {
                result = try c.decode(JSONValue.self, forKey: .result)
            } else {
                result = nil
            }
            error = try c.decodeIfPresent(RPCErrorBody.self, forKey: .error)
        }
    }

    public static func encodeRequest<P: Encodable>(id: Int, method: String, params: P) throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try e.encode(Request(id: id, method: method, params: params))
        data.append(0x0A)
        return data
    }

    public static func decode(line: Data) throws -> Incoming {
        let env = try JSONDecoder().decode(Envelope.self, from: line)
        if let method = env.method, env.id == nil {
            return .notification(method: method, params: env.params ?? .null)
        }
        if let err = env.error {
            if case .number(let n)? = env.id { return .response(id: Int(n), result: .failure(err)) }
            return .orphanError(err)
        }
        if env.hasResult, case .number(let n)? = env.id {
            return .response(id: Int(n), result: .success(env.result ?? .null))
        }
        throw RPCCodecError.notAMessage
    }

    public static func value<T: Decodable>(_ v: JSONValue, as type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(v))
    }
}
```

`app/Sources/CompanionCore/Text/RedactionNotice.swift`:

```swift
/// Spec §7.4 / M4b REDACTION_NOTICE. The UI shows `privacy.get.redactionNotice`; this is the fallback.
public enum RedactionNotice {
    public static let text = "Redaction reduces risk; it does not guarantee every secret is removed."
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && swift test --filter "RPCCodecTests|SourceRulesTests"`
Expected: PASS. (`untrustedTextIsNeverParsed` and `noConsoleLogging` pass because `SpeechText.swift` and `CompanionApp.swift` use neither.)

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore/Daemon app/Sources/CompanionCore/Text/RedactionNotice.swift app/Tests/CompanionCoreTests/RPCCodecTests.swift app/Tests/CompanionCoreTests/SourceRulesTests.swift
git commit -m "feat(app): add the JSON-RPC codec and source rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Daemon models

**Files:**
- Create: `app/Sources/CompanionCore/Daemon/DaemonModels.swift`
- Test: `app/Tests/CompanionCoreTests/DaemonModelsTests.swift`

**Interfaces:**
- Consumes: Task 1 (`JSONValue`, `RPCCodec.value`).
- Produces (all `Sendable, Equatable`, decodable from the shapes in "Daemon API (reconciled with merged M4b)"): `enum DaemonErrorCode` (static `Int`s), `struct DaemonError: Error { code; message; data; var reason: String?; static let stopped }`, `HelloResult`, `enum HostState { stopped, starting, ready(warnings:), failed(detail:); var isReady }`, `enum AuthState { signedIn(planType:), signedOut, unsupported(mode:) }`, `enum SharingMode: String, CaseIterable { off, ask, automatic; var title }`, `enum SessionStatus: String { busy, idle, recent, inactive }`, `SessionSummary: Identifiable`, `Selection`, `SessionsSnapshot`, `PickerGroups`, `SyncStats`, `SyncStatus`, `enum WorktreeResolution { resolved(root:branch:isLinkedWorktree:), unavailable(reason:detail:root:candidate:) }`, `RepoChange`, `ApprovedRoot`, `PrivacyState`, `RepoLine`, `PreviewItem: Identifiable`, `ContextPreview`, `Prepared`, `SendResult`, `SentRecord`, `ItemSummary`, `ChatDelta`, `ChatItemEvent`, `TurnCompleted`, `ThreadReplaced`, `SecurityAlert: Identifiable`, `TranscriptInfo`, `WorktreeEvent`, `RevokeResult { revoked; pendingClose }`, `enum DaemonEvent { hostChanged, authChanged, sessionsChanged, sessionTranscript, sessionWorktree, syncError(String), chatDelta, chatItem, turnCompleted, threadReplaced, securityAlert, disconnected, unknown(String); static func decode(method:params:) -> DaemonEvent }`; `let daemonProtocolVersion = 1`; `DaemonErrorCode.retryable`, `.prepareAgain`, `.securityStopPrefix`; `Prepared.sessionTitle`.

- [ ] **Step 1: Write the failing test** — `app/Tests/CompanionCoreTests/DaemonModelsTests.swift`:

```swift
import Foundation
import Testing
@testable import CompanionCore

/// Shapes copied from the M4b plan ("Interfaces produced for M5", Task 6 tests). SYNTHETIC FIXTURE values only.
@Suite struct DaemonModelsTests {
    private func json(_ s: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }

    @Test func hostAndAuthStates() throws {
        #expect(try RPCCodec.value(json(#"{"state":"ready","warnings":["w"]}"#), as: HostState.self) == .ready(warnings: ["w"]))
        #expect(try RPCCodec.value(json(#"{"state":"failed","detail":"Chat is off (COMPANIOND_CODEX=off)."}"#), as: HostState.self)
            == .failed(detail: "Chat is off (COMPANIOND_CODEX=off)."))
        #expect(try RPCCodec.value(json(#"{"state":"weird"}"#), as: HostState.self) == .failed(detail: "Unknown Codex state: weird"))
        #expect(try RPCCodec.value(json(#"{"state":"signed_in","planType":null}"#), as: AuthState.self) == .signedIn(planType: nil))
        #expect(try RPCCodec.value(json(#"{"state":"unsupported","mode":"apikey"}"#), as: AuthState.self) == .unsupported(mode: "apikey"))
    }

    static let snapshotJSON = #"""
    {"sessions":[{"sessionId":"s1","cliSessionId":"c1","title":"SYNTHETIC FIXTURE fix login","status":"busy","isArchived":false,
      "lastFocusedAt":10,"lastActivityAt":11,"recordCwd":"/r","recordBranch":"main","resolvedRoot":"/r","source":"desktop",
      "transcriptPath":"/t.jsonl","transcriptMissing":null},
     {"sessionId":"s2","cliSessionId":null,"title":"SYNTHETIC FIXTURE two","status":"strange","isArchived":true,
      "lastFocusedAt":null,"lastActivityAt":null,"recordCwd":null,"recordBranch":null,"resolvedRoot":null,"source":"transcript_only",
      "transcriptPath":null,"transcriptMissing":"not_found"}],
     "selection":{"sessionId":"s1","via":"focus","focusedSessionId":"s1","focusLabel":"Claude focus (from Claude's records)",
      "focusMovedTo":null,"pinnedMissing":false},
     "desktopRecordsError":null,"refreshedAt":12}
    """#

    @Test func snapshotDecodes() throws {
        let s = try RPCCodec.value(json(Self.snapshotJSON), as: SessionsSnapshot.self)
        #expect(s.sessions.map(\.id) == ["s1", "s2"])
        #expect(s.sessions[0].status == .busy)
        #expect(s.sessions[1].status == .inactive) // unknown status tolerated
        #expect(s.selection.via == "focus")
        #expect(s.selection.focusLabel == "Claude focus (from Claude's records)")
    }

    @Test func worktreeResolutions() throws {
        #expect(try RPCCodec.value(json(#"{"kind":"resolved","root":"/r","gitDir":"/r/.git","gitCommonDir":"/r/.git","isLinkedWorktree":false,"branch":"main","candidate":"/r","candidateSource":"transcript"}"#), as: WorktreeResolution.self)
            == .resolved(root: "/r", branch: "main", isLinkedWorktree: false))
        #expect(try RPCCodec.value(json(#"{"kind":"unavailable","reason":"not_approved","detail":"not approved","candidate":"/r","candidateSource":"transcript","root":"/r","gitCommonDir":"/r/.git"}"#), as: WorktreeResolution.self)
            == .unavailable(reason: "not_approved", detail: "not approved", root: "/r", candidate: "/r"))
        #expect(try RPCCodec.value(.null, as: WorktreeResolution?.self) == nil)
    }

    @Test func preparedAndSent() throws {
        let p = try RPCCodec.value(json(#"""
        {"prepareId":"p1","sessionId":"s1","mode":"ask","needsConfirm":true,"repoNote":null,"sessionTitle":"SYNTHETIC FIXTURE title",
         "repo":{"state":"bound","root":"/r","branch":"main","detail":null},
         "preview":{"items":[{"id":"item-1","kind":"user","label":"You","text":"SYNTHETIC FIXTURE first","redactions":1}],
           "notes":["Cursor reset"],"omitted":2,"bytes":120,"cursorAfter":"u2","subagents":[]}}
        """#), as: Prepared.self)
        #expect(p.needsConfirm)
        #expect(p.mode == .ask)
        #expect(p.preview?.items.first?.redactions == 1)
        #expect(p.preview?.omitted == 2)
        #expect(p.sessionTitle == "SYNTHETIC FIXTURE title")
        let off = try RPCCodec.value(json(#"{"prepareId":"p2","sessionId":"s1","mode":"off","needsConfirm":false,"repoNote":null,"sessionTitle":null,"repo":{"state":"none","root":null,"branch":null,"detail":null},"preview":null}"#), as: Prepared.self)
        #expect(off.preview == nil)
        #expect(off.sessionTitle == nil)
        #expect(try RPCCodec.value(json(#"{"revoked":true,"pendingClose":2}"#), as: RevokeResult.self) == RevokeResult(revoked: true, pendingClose: 2))
        let sent = try RPCCodec.value(json(#"[{"sessionId":"s1","threadId":"t1","turnId":"u1","contextBlock":"<untrusted_data>x</untrusted_data>","question":"q","sentAt":5}]"#), as: [SentRecord].self)
        #expect(sent.first?.turnId == "u1")
    }

    @Test func syncStatsTolerateMissingCounters() throws {
        let s = try RPCCodec.value(json(#"{"state":"live","stats":{"records":4,"malformedLines":1},"lastPollAt":3}"#), as: SyncStatus.self)
        #expect(s.stats?.records == 4)
        #expect(s.stats?.malformedLines == 1)
        #expect(s.stats?.droppedEvents == 0)
    }

    @Test func eventsDecode() throws {
        #expect(DaemonEvent.decode(method: "chat.delta", params: try json(#"{"sessionId":"s1","threadId":"t","turnId":"u","itemId":"i","text":"Hi"}"#))
            == .chatDelta(ChatDelta(sessionId: "s1", threadId: "t", turnId: "u", itemId: "i", text: "Hi")))
        #expect(DaemonEvent.decode(method: "chat.turnCompleted", params: try json(#"{"sessionId":null,"threadId":"t","turnId":"u","status":"completed","error":null}"#))
            == .turnCompleted(TurnCompleted(sessionId: nil, threadId: "t", turnId: "u", status: "completed", error: nil)))
        #expect(DaemonEvent.decode(method: "security.alert", params: try json(#"{"sessionId":"s1","threadId":"t","turnId":"u","kind":"guard","detail":"Codex started a commandExecution item"}"#))
            == .securityAlert(SecurityAlert(sessionId: "s1", threadId: "t", turnId: "u", kind: "guard", detail: "Codex started a commandExecution item")))
        if case .sessionWorktree(let w) = DaemonEvent.decode(method: "session.worktree", params: try json(#"{"sessionId":"s1","resolution":{"kind":"resolved","root":"/r","branch":null,"isLinkedWorktree":true},"change":{"from":"/a","to":"/r","banner":"Claude is now in /r (main)","contextNote":"Repository changed from /a to /r"}}"#)) {
            #expect(w.change?.banner == "Claude is now in /r (main)")
        } else { Issue.record("session.worktree did not decode") }
        #expect(DaemonEvent.decode(method: "chat.threadReplaced", params: try json(#"{"sessionId":"s1","threadId":"t2","reason":"resume_refused"}"#))
            == .threadReplaced(ThreadReplaced(sessionId: "s1", threadId: "t2", reason: "resume_refused")))
        #expect(DaemonEvent.decode(method: "host.changed", params: .string("bad")) == .unknown("host.changed"))
        #expect(DaemonEvent.decode(method: "something.new", params: .null) == .unknown("something.new"))
    }

    @Test func errorReason() {
        let e = DaemonError(code: DaemonErrorCode.approvalRefused, message: "no", data: .object(["reason": .string("home_or_root")]))
        #expect(e.reason == "home_or_root")
        #expect(DaemonError.stopped.code == DaemonErrorCode.stopped)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && swift test --filter DaemonModelsTests`
Expected: build FAIL — `cannot find 'HostState' in scope`.

- [ ] **Step 3: Implement** — `app/Sources/CompanionCore/Daemon/DaemonModels.swift`:

```swift
import Foundation

// Codable mirrors of the M4b daemon API ("Daemon API" section of the M5 plan). Extra fields are ignored.

public let daemonProtocolVersion = 1

public enum DaemonErrorCode {
    public static let parseError = -32700
    public static let invalidRequest = -32600
    public static let methodNotFound = -32601
    public static let invalidParams = -32602
    public static let internalError = -32603
    public static let securityCheckFailed = 1001
    public static let hostNotReady = 1002
    public static let repoRefused = 1003
    public static let prepareExpired = 1004
    public static let turnBusy = 1005
    public static let approvalRefused = 1006
    public static let unknownSession = 1007
    public static let emptyQuestion = 1008
    public static let hostBusy = 1009
    public static let prepareStale = 1010
    public static let confirmRequired = 1011
    /// After these the same prepareId may be sent again (M4b retry rule).
    public static let retryable: Set<Int> = [hostNotReady, turnBusy, hostBusy]
    /// After these the app prepares again and re-previews.
    public static let prepareAgain: Set<Int> = [prepareExpired, prepareStale, confirmRequired]
    public static let securityStopPrefix = "Security check failed"
    /// App side: the daemon process or its pipe is gone.
    public static let stopped = -1
}

public struct DaemonError: Error, Sendable, Equatable {
    public let code: Int
    public let message: String
    public let data: JSONValue?
    public init(code: Int, message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
    public var reason: String? { data?["reason"]?.stringValue }
    public static let stopped = DaemonError(code: DaemonErrorCode.stopped, message: "companiond stopped.")
}

public struct HelloResult: Decodable, Sendable, Equatable {
    public let protocolVersion: Int
    public let daemonVersion: String
}

public enum HostState: Decodable, Sendable, Equatable {
    case stopped, starting, ready(warnings: [String]), failed(detail: String)
    private enum K: String, CodingKey { case state, warnings, detail }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .state) {
        case "stopped": self = .stopped
        case "starting": self = .starting
        case "ready": self = .ready(warnings: try c.decodeIfPresent([String].self, forKey: .warnings) ?? [])
        case "failed": self = .failed(detail: try c.decodeIfPresent(String.self, forKey: .detail) ?? "Codex failed.")
        case let other: self = .failed(detail: "Unknown Codex state: \(other)")
        }
    }
    public var isReady: Bool { if case .ready = self { true } else { false } }
}

public enum AuthState: Decodable, Sendable, Equatable {
    case signedIn(planType: String?), signedOut, unsupported(mode: String)
    private enum K: String, CodingKey { case state, planType, mode }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .state) {
        case "signed_in": self = .signedIn(planType: try c.decodeIfPresent(String.self, forKey: .planType))
        case "signed_out": self = .signedOut
        default: self = .unsupported(mode: try c.decodeIfPresent(String.self, forKey: .mode) ?? "unknown")
        }
    }
}

public enum SharingMode: String, Codable, Sendable, CaseIterable {
    case off, ask, automatic
    public var title: String {
        switch self {
        case .off: "Off"
        case .ask: "Ask each time"
        case .automatic: "Automatic"
        }
    }
}

public enum SessionStatus: String, Decodable, Sendable {
    case busy, idle, recent, inactive
    public init(from decoder: any Decoder) throws {
        self = SessionStatus(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .inactive
    }
}

public struct SessionSummary: Decodable, Sendable, Equatable, Identifiable {
    public let sessionId: String
    public let cliSessionId: String?
    public let title: String
    public let status: SessionStatus
    public let isArchived: Bool
    public let lastFocusedAt: Double?
    public let lastActivityAt: Double?
    public let recordCwd: String?
    public let recordBranch: String?
    public let resolvedRoot: String?
    public let source: String
    public let transcriptMissing: String?
    public var id: String { sessionId }
}

public struct Selection: Decodable, Sendable, Equatable {
    public let sessionId: String?
    public let via: String
    public let focusedSessionId: String?
    public let focusLabel: String
    public let focusMovedTo: String?
    public let pinnedMissing: Bool
}

public struct SessionsSnapshot: Decodable, Sendable, Equatable {
    public let sessions: [SessionSummary]
    public let selection: Selection
    public let desktopRecordsError: String?
    public let refreshedAt: Double
}

public struct PickerGroups: Decodable, Sendable, Equatable {
    public let busy: [SessionSummary]
    public let idle: [SessionSummary]
    public let recent: [SessionSummary]
    public let older: [SessionSummary]
}

public struct SyncStats: Decodable, Sendable, Equatable {
    public let records: Int
    public let malformedLines: Int
    public let unknownRecords: Int
    public let droppedEvents: Int
    private enum K: String, CodingKey { case records, malformedLines, unknownRecords, droppedEvents }
    public init(records: Int, malformedLines: Int, unknownRecords: Int, droppedEvents: Int) {
        self.records = records
        self.malformedLines = malformedLines
        self.unknownRecords = unknownRecords
        self.droppedEvents = droppedEvents
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        records = try c.decodeIfPresent(Int.self, forKey: .records) ?? 0
        malformedLines = try c.decodeIfPresent(Int.self, forKey: .malformedLines) ?? 0
        unknownRecords = try c.decodeIfPresent(Int.self, forKey: .unknownRecords) ?? 0
        droppedEvents = try c.decodeIfPresent(Int.self, forKey: .droppedEvents) ?? 0
    }
}

public struct SyncStatus: Decodable, Sendable, Equatable {
    public let state: String
    public let stats: SyncStats?
    public let lastPollAt: Double?
    public init(state: String, stats: SyncStats?, lastPollAt: Double?) {
        self.state = state
        self.stats = stats
        self.lastPollAt = lastPollAt
    }
}

public enum WorktreeResolution: Decodable, Sendable, Equatable {
    case resolved(root: String, branch: String?, isLinkedWorktree: Bool)
    case unavailable(reason: String, detail: String, root: String?, candidate: String?)
    private enum K: String, CodingKey { case kind, root, branch, isLinkedWorktree, reason, detail, candidate }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        if try c.decode(String.self, forKey: .kind) == "resolved" {
            self = .resolved(root: try c.decode(String.self, forKey: .root),
                             branch: try c.decodeIfPresent(String.self, forKey: .branch),
                             isLinkedWorktree: try c.decodeIfPresent(Bool.self, forKey: .isLinkedWorktree) ?? false)
        } else {
            self = .unavailable(reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "unknown",
                                detail: try c.decodeIfPresent(String.self, forKey: .detail) ?? "Repository unavailable.",
                                root: try c.decodeIfPresent(String.self, forKey: .root),
                                candidate: try c.decodeIfPresent(String.self, forKey: .candidate))
        }
    }
}

public struct RepoChange: Decodable, Sendable, Equatable {
    public let from: String?
    public let to: String?
    public let banner: String
    public let contextNote: String
}

public struct ApprovedRoot: Decodable, Sendable, Equatable, Identifiable {
    public let root: String
    public let commonDir: String
    public let includeWorktrees: Bool
    public let approvedAt: Double
    public var id: String { root }
}

/// privacy.revoke's answer. pendingClose = threads on the revoked root still finishing a reply (spec §7.5, §8).
public struct RevokeResult: Decodable, Sendable, Equatable {
    public let revoked: Bool
    public let pendingClose: Int
    public init(revoked: Bool, pendingClose: Int) {
        self.revoked = revoked
        self.pendingClose = pendingClose
    }
}

public struct PrivacyState: Decodable, Sendable, Equatable {
    public let sharingMode: SharingMode
    public let approvals: [ApprovedRoot]
    public let redactionNotice: String
}

public struct RepoLine: Decodable, Sendable, Equatable {
    public let state: String
    public let root: String?
    public let branch: String?
    public let detail: String?
}

public struct PreviewItem: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    public let label: String
    public let text: String
    public let redactions: Int
}

public struct ContextPreview: Decodable, Sendable, Equatable {
    public let items: [PreviewItem]
    public let notes: [String]
    public let omitted: Int
    public let bytes: Int
}

public struct Prepared: Decodable, Sendable, Equatable {
    public let prepareId: String
    public let sessionId: String
    public let mode: SharingMode
    public let preview: ContextPreview?
    public let needsConfirm: Bool
    public let repo: RepoLine
    public let repoNote: String?
    /// Sent with the context in Ask and Automatic; null in Off. The preview sheet shows it.
    public let sessionTitle: String?
}

public struct SendResult: Decodable, Sendable, Equatable {
    public let threadId: String
    public let turnId: String
}

public struct SentRecord: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let threadId: String
    public let turnId: String
    public let contextBlock: String
    public let question: String
    public let sentAt: Double
}

public struct ItemSummary: Decodable, Sendable, Equatable {
    public let id: String
    public let type: String
    public let server: String?
    public let tool: String?
    public let status: String?
}

public struct ChatDelta: Decodable, Sendable, Equatable {
    public let sessionId: String?
    public let threadId: String
    public let turnId: String
    public let itemId: String
    public let text: String
}

public struct ChatItemEvent: Decodable, Sendable, Equatable {
    public let sessionId: String?
    public let threadId: String
    public let turnId: String
    public let phase: String
    public let item: ItemSummary
}

public struct TurnCompleted: Decodable, Sendable, Equatable {
    public let sessionId: String?
    public let threadId: String
    public let turnId: String
    public let status: String
    public let error: String?
}

public struct SecurityAlert: Decodable, Sendable, Equatable, Identifiable {
    public let sessionId: String?
    public let threadId: String?
    public let turnId: String?
    public let kind: String
    public let detail: String
    public var id: String { "\(kind)|\(turnId ?? "-")|\(detail)" }
}

public struct TranscriptInfo: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let kind: String
    public let dropped: Int
    public let stats: SyncStats
}

public struct WorktreeEvent: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let resolution: WorktreeResolution
    public let change: RepoChange?
}

public struct ThreadReplaced: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let threadId: String
    public let reason: String
}

public enum DaemonEvent: Sendable, Equatable {
    case hostChanged(HostState)
    case authChanged(AuthState)
    case sessionsChanged(SessionsSnapshot)
    case sessionTranscript(TranscriptInfo)
    case sessionWorktree(WorktreeEvent)
    case syncError(String)
    case chatDelta(ChatDelta)
    case chatItem(ChatItemEvent)
    case turnCompleted(TurnCompleted)
    case threadReplaced(ThreadReplaced)
    case securityAlert(SecurityAlert)
    /// App side: the daemon's stdout closed.
    case disconnected
    case unknown(String)

    private struct Message: Decodable { let message: String }

    public static func decode(method: String, params: JSONValue) -> DaemonEvent {
        func v<T: Decodable>(_ t: T.Type) -> T? { try? RPCCodec.value(params, as: t) }
        let e: DaemonEvent? = switch method {
        case "host.changed": v(HostState.self).map { .hostChanged($0) }
        case "auth.changed": v(AuthState.self).map { .authChanged($0) }
        case "sessions.changed": v(SessionsSnapshot.self).map { .sessionsChanged($0) }
        case "session.transcript": v(TranscriptInfo.self).map { .sessionTranscript($0) }
        case "session.worktree": v(WorktreeEvent.self).map { .sessionWorktree($0) }
        case "session.syncError": v(Message.self).map { .syncError($0.message) }
        case "chat.delta": v(ChatDelta.self).map { .chatDelta($0) }
        case "chat.item": v(ChatItemEvent.self).map { .chatItem($0) }
        case "chat.turnCompleted": v(TurnCompleted.self).map { .turnCompleted($0) }
        case "chat.threadReplaced": v(ThreadReplaced.self).map { .threadReplaced($0) }
        case "security.alert": v(SecurityAlert.self).map { .securityAlert($0) }
        default: nil
        }
        return e ?? .unknown(method)
    }
}
```

- [ ] **Step 4: Run the test**

Run: `cd app && swift test --filter DaemonModelsTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore/Daemon/DaemonModels.swift app/Tests/CompanionCoreTests/DaemonModelsTests.swift
git commit -m "feat(app): mirror the daemon API types" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Daemon client (actor) and the `DaemonAPI` protocol

**Files:**
- Create: `app/Sources/CompanionCore/Daemon/LineTransport.swift` (protocol and `LineSplitter` only; `ProcessTransport` is added in Task 4), `app/Sources/CompanionCore/Daemon/DaemonAPI.swift`, `app/Sources/CompanionCore/Daemon/DaemonClient.swift`
- Test: `app/Tests/CompanionCoreTests/DaemonClientTests.swift`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `protocol LineTransport: Sendable { var lines: AsyncThrowingStream<Data, any Error> { get }; func send(_ line: Data) async throws; func close() async }`
  - `struct LineSplitter { static let maxLineBytes = 16 MiB; mutating func push(_ chunk: Data) throws -> [Data] }`
  - `protocol DaemonAPI: Sendable` — one `async throws` method per row of the "Methods used" table (names below; `chatSend(prepareId:removeItemIds:confirmed:)`, `hostAcknowledgeSecurityStop()`); `enum DaemonLimits { questionUTF16 = 20_000; queryUTF16 = 200; static func clip(_:utf16:) }`; `struct Connection: Sendable { api: any DaemonAPI; events: AsyncStream<DaemonEvent>; close: @Sendable () async -> Void }`; `typealias Connector = @Sendable () async throws -> Connection`
  - `actor DaemonClient: DaemonAPI { init(transport:); func start(); nonisolated let events: AsyncStream<DaemonEvent>; func close() async }`

- [ ] **Step 1: Write the failing test** — `app/Tests/CompanionCoreTests/DaemonClientTests.swift`:

```swift
import Foundation
import Synchronization
import Testing
@testable import CompanionCore

/// In-memory transport: records what the client wrote; the test pushes daemon lines.
final class MemoryTransport: LineTransport {
    let lines: AsyncThrowingStream<Data, any Error>
    private let input: AsyncThrowingStream<Data, any Error>.Continuation
    private let written = Mutex<[JSONValue]>([])
    private let closed = Mutex(false)

    init() {
        let (s, c) = AsyncThrowingStream.makeStream(of: Data.self)
        lines = s
        input = c
    }
    func send(_ line: Data) async throws {
        if closed.withLock({ $0 }) { throw DaemonError.stopped }
        let v = try JSONDecoder().decode(JSONValue.self, from: line)
        written.withLock { $0.append(v) }
    }
    func close() async { closed.withLock { $0 = true }; input.finish() }

    func push(_ s: String) { input.yield(Data(s.utf8)) }
    func end() { input.finish() }
    var requests: [JSONValue] { written.withLock { $0 } }

    /// Waits until the client has written n requests.
    func waitForRequests(_ n: Int) async throws {
        for _ in 0..<200 where requests.count < n { try await Task.sleep(for: .milliseconds(5)) }
        #expect(requests.count >= n)
    }
}

@Suite struct DaemonClientTests {
    @Test func correlatesResponsesByIdOutOfOrder() async throws {
        let t = MemoryTransport()
        let client = DaemonClient(transport: t)
        await client.start()
        async let host = client.hostStatus()
        async let privacy = client.privacyGet()
        try await t.waitForRequests(2)
        let ids = t.requests.compactMap { r -> (String, Int)? in
            guard case .string(let m)? = r["method"], case .number(let n)? = r["id"] else { return nil }
            return (m, Int(n))
        }
        let byMethod = Dictionary(uniqueKeysWithValues: ids)
        t.push(#"{"jsonrpc":"2.0","id":\#(byMethod["privacy.get"]!),"result":{"sharingMode":"ask","approvals":[],"redactionNotice":"Redaction reduces risk; it does not guarantee every secret is removed."}}"#)
        t.push(#"{"jsonrpc":"2.0","id":\#(byMethod["host.status"]!),"result":{"state":"starting"}}"#)
        #expect(try await host == .starting)
        #expect(try await privacy.sharingMode == .ask)
    }

    @Test func sendsTheExactParams() async throws {
        let t = MemoryTransport()
        let client = DaemonClient(transport: t)
        await client.start()
        async let r = client.chatSend(prepareId: "p1", removeItemIds: ["item-2"], confirmed: true)
        try await t.waitForRequests(1)
        let req = t.requests[0]
        #expect(req["method"] == .string("chat.send"))
        #expect(req["params"] == .object(["prepareId": .string("p1"), "removeItemIds": .array([.string("item-2")]), "confirmed": .bool(true)]))
        t.push(#"{"jsonrpc":"2.0","id":1,"result":{"threadId":"t1","turnId":"u1"}}"#)
        #expect(try await r == SendResult(threadId: "t1", turnId: "u1"))

        async let pin = client.sessionsPin(nil)
        try await t.waitForRequests(2)
        #expect(t.requests[1]["params"] == .object(["sessionId": .null]))
        t.push(#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":null,"via":"none","focusedSessionId":null,"focusLabel":"Claude focus (from Claude's records)","focusMovedTo":null,"pinnedMissing":false}}"#)
        #expect(try await pin.via == "none")
    }

    @Test func mapsErrors() async throws {
        let t = MemoryTransport()
        let client = DaemonClient(transport: t)
        await client.start()
        let r = Task { try await client.privacyApprove(root: "/", includeWorktrees: true) }
        try await t.waitForRequests(1)
        t.push(#"{"jsonrpc":"2.0","id":1,"error":{"code":1006,"message":"Your home folder or / cannot be approved.","data":{"reason":"home_or_root"}}}"#)
        await #expect(throws: DaemonError(code: 1006, message: "Your home folder or / cannot be approved.", data: .object(["reason": .string("home_or_root")]))) { try await r.value }
    }

    @Test func notificationsBecomeEventsAndEndOfStreamFailsPendingCalls() async throws {
        let t = MemoryTransport()
        let client = DaemonClient(transport: t)
        await client.start()
        let pending = Task { try await client.hostStatus() }
        try await t.waitForRequests(1)
        t.push(#"{"jsonrpc":"2.0","method":"host.changed","params":{"state":"ready","warnings":[]}}"#)
        t.push("not json at all")
        t.end()
        await #expect(throws: DaemonError.stopped) { try await pending.value }
        var got: [DaemonEvent] = []
        for await e in client.events { got.append(e) }
        #expect(got == [.hostChanged(.ready(warnings: [])), .disconnected])
        await #expect(throws: DaemonError.stopped) { try await client.hostStatus() }
    }

    @Test func refusesANonHttpsSignInLink() async throws {
        let t = MemoryTransport()
        let client = DaemonClient(transport: t)
        await client.start()
        let url = Task { try await client.authLogin() }
        try await t.waitForRequests(1)
        t.push(#"{"jsonrpc":"2.0","id":1,"result":{"authUrl":"http://example.invalid/login"}}"#)
        await #expect(throws: DaemonError.self) { try await url.value }
    }

    @Test func clipsByUTF16Units() {
        #expect(DaemonLimits.clip("abc", utf16: 5) == "abc")
        #expect(DaemonLimits.clip("😀😀😀", utf16: 5) == "😀😀") // each emoji is 2 UTF-16 units
        #expect(DaemonLimits.clip(String(repeating: "x", count: 300), utf16: DaemonLimits.queryUTF16).utf16.count == 200)
    }

    @Test func lineSplitterHandlesPartsAndCaps() throws {
        var s = LineSplitter()
        #expect(try s.push(Data("{\"a\":".utf8)).isEmpty)
        #expect(try s.push(Data("1}\n\n{\"b\":2}\n{\"c\"".utf8)).map { String(decoding: $0, as: UTF8.self) } == ["{\"a\":1}", "{\"b\":2}"])
        #expect(try s.push(Data(":3}\n".utf8)).map { String(decoding: $0, as: UTF8.self) } == ["{\"c\":3}"])
        var big = LineSplitter()
        #expect(throws: LineSplitter.Failure.lineTooLong) { try big.push(Data(count: LineSplitter.maxLineBytes + 1)) }
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && swift test --filter DaemonClientTests`
Expected: build FAIL — `cannot find type 'LineTransport' in scope`.

- [ ] **Step 3: Implement** — `app/Sources/CompanionCore/Daemon/LineTransport.swift`:

```swift
import Foundation

/// A newline-delimited message pipe to companiond. `lines` yields complete lines without the "\n".
public protocol LineTransport: Sendable {
    var lines: AsyncThrowingStream<Data, any Error> { get }
    func send(_ line: Data) async throws
    func close() async
}

/// Splits a byte stream into lines. Bytes after the last "\n" wait for the next chunk.
public struct LineSplitter: Sendable {
    public static let maxLineBytes = 16 * 1024 * 1024
    public enum Failure: Error, Equatable { case lineTooLong }
    private var buffer = Data()
    public init() {}

    public mutating func push(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        var out: [Data] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if !line.isEmpty { out.append(line) }
        }
        if buffer.count > Self.maxLineBytes {
            buffer.removeAll()
            throw Failure.lineTooLong
        }
        return out
    }
}
```

`app/Sources/CompanionCore/Daemon/DaemonAPI.swift`:

```swift
import Foundation

/// The M4b daemon methods the app uses ("Daemon API" section of the M5 plan). DaemonClient is the real one; tests fake it.
public protocol DaemonAPI: Sendable {
    func hello() async throws -> HelloResult
    func shutdown() async throws
    func hostStatus() async throws -> HostState
    func hostRestart() async throws -> HostState
    func hostAcknowledgeSecurityStop() async throws -> HostState
    func authStatus() async throws -> AuthState
    func authLogin() async throws -> URL
    func sessionsSnapshot() async throws -> SessionsSnapshot
    func sessionsRefresh() async throws -> SessionsSnapshot
    func sessionsPin(_ sessionId: String?) async throws -> Selection
    func sessionsPicker(query: String?, includeArchived: Bool) async throws -> PickerGroups
    func sessionsSync(_ sessionId: String) async throws -> SyncStatus
    func sessionsWorktree(_ sessionId: String) async throws -> WorktreeResolution?
    func privacyGet() async throws -> PrivacyState
    func privacySetSharingMode(_ mode: SharingMode) async throws -> SharingMode
    func privacyApprove(root: String, includeWorktrees: Bool) async throws -> ApprovedRoot
    func privacyRevoke(root: String) async throws -> RevokeResult
    func chatPrepare(sessionId: String, question: String) async throws -> Prepared
    /// `confirmed` is true only when the user pressed Send in the preview sheet (M4b: Ask mode refuses otherwise, 1011).
    func chatSend(prepareId: String, removeItemIds: [String], confirmed: Bool) async throws -> SendResult
    func chatInterrupt(sessionId: String) async throws
    func chatSent(sessionId: String) async throws -> [SentRecord]
    func settingsGet(_ key: String) async throws -> String?
    func settingsSet(_ key: String, _ value: String) async throws
}

/// Daemon input limits (M4b handlers): strings are capped in UTF-16 units.
public enum DaemonLimits {
    public static let questionUTF16 = 20_000
    public static let queryUTF16 = 200
    public static func clip(_ s: String, utf16 max: Int) -> String {
        guard s.utf16.count > max else { return s }
        var out = ""
        for ch in s {
            if out.utf16.count + String(ch).utf16.count > max { break }
            out.append(ch)
        }
        return out
    }
}

public struct Connection: Sendable {
    public let api: any DaemonAPI
    public let events: AsyncStream<DaemonEvent>
    public let close: @Sendable () async -> Void
    public init(api: any DaemonAPI, events: AsyncStream<DaemonEvent>, close: @escaping @Sendable () async -> Void) {
        self.api = api
        self.events = events
        self.close = close
    }
}

public typealias Connector = @Sendable () async throws -> Connection
```

`app/Sources/CompanionCore/Daemon/DaemonClient.swift`:

```swift
import Foundation

/// JSON-RPC client for companiond. One instance per daemon process.
public actor DaemonClient {
    private let transport: any LineTransport
    private var nextId = 0
    private var pending: [Int: CheckedContinuation<JSONValue, any Error>] = [:]
    private var stopped = false
    private var reader: Task<Void, Never>?
    public nonisolated let events: AsyncStream<DaemonEvent>
    private let sink: AsyncStream<DaemonEvent>.Continuation

    public init(transport: any LineTransport) {
        self.transport = transport
        let (s, c) = AsyncStream.makeStream(of: DaemonEvent.self)
        events = s
        sink = c
    }

    public func start() {
        guard reader == nil else { return }
        reader = Task { await self.readLoop() }
    }

    public func close() async {
        await transport.close()
    }

    private func readLoop() async {
        do {
            for try await line in transport.lines { receive(line) }
        } catch {}
        finish()
    }

    private func receive(_ line: Data) {
        guard let msg = try? RPCCodec.decode(line: line) else { return } // not protocol: ignore
        switch msg {
        case let .response(id, result):
            guard let c = pending.removeValue(forKey: id) else { return }
            switch result {
            case .success(let v): c.resume(returning: v)
            case .failure(let e): c.resume(throwing: DaemonError(code: e.code, message: e.message, data: e.data))
            }
        case let .notification(method, params):
            sink.yield(DaemonEvent.decode(method: method, params: params))
        case .orphanError:
            break
        }
    }

    private func finish() {
        stopped = true
        let all = pending
        pending = [:]
        for c in all.values { c.resume(throwing: DaemonError.stopped) }
        sink.yield(.disconnected)
        sink.finish()
    }

    private func write(_ line: Data, id: Int) async {
        do { try await transport.send(line) } catch { pending.removeValue(forKey: id)?.resume(throwing: DaemonError.stopped) }
    }

    func call<R: Decodable & Sendable>(_ method: String, _ params: JSONValue = .object([:]), as type: R.Type) async throws -> R {
        if stopped { throw DaemonError.stopped }
        nextId += 1
        let id = nextId
        let line = try RPCCodec.encodeRequest(id: id, method: method, params: params)
        let value = try await withCheckedThrowingContinuation { (c: CheckedContinuation<JSONValue, any Error>) in
            pending[id] = c
            Task { await self.write(line, id: id) }
        }
        return try RPCCodec.value(value, as: R.self)
    }
}

private struct Empty: Decodable, Sendable {}
private struct AuthLink: Decodable, Sendable { let authUrl: String }
private struct ModeResult: Decodable, Sendable { let sharingMode: SharingMode }
private struct SettingValue: Decodable, Sendable { let value: String? }

extension DaemonClient: DaemonAPI {
    public func hello() async throws -> HelloResult {
        try await call("daemon.hello", .object(["protocolVersion": .number(Double(daemonProtocolVersion))]), as: HelloResult.self)
    }
    public func shutdown() async throws { _ = try await call("daemon.shutdown", as: Empty.self) }
    public func hostStatus() async throws -> HostState { try await call("host.status", as: HostState.self) }
    public func hostRestart() async throws -> HostState { try await call("host.restart", as: HostState.self) }
    public func hostAcknowledgeSecurityStop() async throws -> HostState {
        try await call("host.acknowledgeSecurityStop", as: HostState.self)
    }
    public func authStatus() async throws -> AuthState { try await call("auth.status", as: AuthState.self) }
    public func authLogin() async throws -> URL {
        let link = try await call("auth.login", as: AuthLink.self)
        guard let url = URL(string: link.authUrl), url.scheme == "https" else {
            throw DaemonError(code: DaemonErrorCode.internalError, message: "The sign-in link was not an https link.")
        }
        return url
    }
    public func sessionsSnapshot() async throws -> SessionsSnapshot { try await call("sessions.snapshot", as: SessionsSnapshot.self) }
    public func sessionsRefresh() async throws -> SessionsSnapshot { try await call("sessions.refresh", as: SessionsSnapshot.self) }
    public func sessionsPin(_ sessionId: String?) async throws -> Selection {
        try await call("sessions.pin", .object(["sessionId": sessionId.map(JSONValue.string) ?? .null]), as: Selection.self)
    }
    public func sessionsPicker(query: String?, includeArchived: Bool) async throws -> PickerGroups {
        var p: [String: JSONValue] = ["includeArchived": .bool(includeArchived)]
        if let query, !query.isEmpty { p["query"] = .string(DaemonLimits.clip(query, utf16: DaemonLimits.queryUTF16)) }
        return try await call("sessions.picker", .object(p), as: PickerGroups.self)
    }
    public func sessionsSync(_ sessionId: String) async throws -> SyncStatus {
        try await call("sessions.sync", .object(["sessionId": .string(sessionId)]), as: SyncStatus.self)
    }
    public func sessionsWorktree(_ sessionId: String) async throws -> WorktreeResolution? {
        try await call("sessions.worktree", .object(["sessionId": .string(sessionId)]), as: WorktreeResolution?.self)
    }
    public func privacyGet() async throws -> PrivacyState { try await call("privacy.get", as: PrivacyState.self) }
    public func privacySetSharingMode(_ mode: SharingMode) async throws -> SharingMode {
        try await call("privacy.setSharingMode", .object(["mode": .string(mode.rawValue)]), as: ModeResult.self).sharingMode
    }
    public func privacyApprove(root: String, includeWorktrees: Bool) async throws -> ApprovedRoot {
        try await call("privacy.approve", .object(["root": .string(root), "includeWorktrees": .bool(includeWorktrees)]), as: ApprovedRoot.self)
    }
    public func privacyRevoke(root: String) async throws -> RevokeResult {
        try await call("privacy.revoke", .object(["root": .string(root)]), as: RevokeResult.self)
    }
    public func chatPrepare(sessionId: String, question: String) async throws -> Prepared {
        try await call("chat.prepare", .object(["sessionId": .string(sessionId), "question": .string(question)]), as: Prepared.self)
    }
    public func chatSend(prepareId: String, removeItemIds: [String], confirmed: Bool) async throws -> SendResult {
        try await call("chat.send", .object(["prepareId": .string(prepareId), "removeItemIds": .array(removeItemIds.map(JSONValue.string)),
                                             "confirmed": .bool(confirmed)]), as: SendResult.self)
    }
    public func chatInterrupt(sessionId: String) async throws {
        _ = try await call("chat.interrupt", .object(["sessionId": .string(sessionId)]), as: Empty.self)
    }
    public func chatSent(sessionId: String) async throws -> [SentRecord] {
        try await call("chat.sent", .object(["sessionId": .string(sessionId)]), as: [SentRecord].self)
    }
    public func settingsGet(_ key: String) async throws -> String? {
        try await call("settings.get", .object(["key": .string(key)]), as: SettingValue.self).value
    }
    public func settingsSet(_ key: String, _ value: String) async throws {
        _ = try await call("settings.set", .object(["key": .string(key), "value": .string(value)]), as: Empty.self)
    }
}
```

Note: in Swift 6.2 the closure given to `withCheckedThrowingContinuation` runs on the caller's isolation (`isolation: #isolation`), so writing `pending[id]` inside it is actor-isolated. Do not move it into a detached task.

- [ ] **Step 4: Run the test**

Run: `cd app && swift test --filter DaemonClientTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore/Daemon app/Tests/CompanionCoreTests/DaemonClientTests.swift
git commit -m "feat(app): add the companiond JSON-RPC client" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Launching companiond (Node discovery, process transport, bundle staging)

**Files:**
- Create: `app/Sources/CompanionCore/Daemon/DaemonLocator.swift`
- Modify: `app/Sources/CompanionCore/Daemon/LineTransport.swift` (add `ProcessTransport`), `scripts/build-app.sh`, `app/bundle/Info.plist` (version 0.5.0), `.github/workflows/tests.yml` (app job)
- Test: `app/Tests/CompanionCoreTests/DaemonLocatorTests.swift`, `app/Tests/CompanionCoreTests/DaemonIntegrationTests.swift`

**Interfaces:**
- Consumes: Task 3 (`LineTransport`, `LineSplitter`, `DaemonClient`, `Connection`, `Connector`).
- Produces: `struct DaemonLaunch: Equatable, Sendable { executable; arguments; environment; currentDirectory }`; `enum DaemonLaunchError: Error, LocalizedError, Equatable { nodeNotFound, daemonNotFound }`; `enum DaemonLocator { static let minimumNodeMajor = 24; static func nodeCandidates(env:configured:) -> [String]; static func nodeMajor(_:) -> Int?; static func findNode(candidates:isExecutable:version:) -> Result<String, DaemonLaunchError>; static func daemonDirectory(env:resourceURL:fileExists:) -> Result<String, DaemonLaunchError>; static func launch(node:daemonDir:env:) -> DaemonLaunch; static func live(env:configuredNode:resourceURL:) -> Connector }`; `final class ProcessTransport: LineTransport { init(launch:) throws }`.

- [ ] **Step 1: Write the failing tests** — `app/Tests/CompanionCoreTests/DaemonLocatorTests.swift`:

```swift
import Foundation
import Testing
@testable import CompanionCore

@Suite struct DaemonLocatorTests {
    @Test func nodeCandidatesInOrder() {
        #expect(DaemonLocator.nodeCandidates(env: ["COMPANION_NODE": "/x/node"], configured: "/y/node")
            == ["/x/node", "/y/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"])
        #expect(DaemonLocator.nodeCandidates(env: [:], configured: "") == ["/opt/homebrew/bin/node", "/usr/local/bin/node"])
    }

    @Test func parsesNodeVersions() {
        #expect(DaemonLocator.nodeMajor("v24.3.0\n") == 24)
        #expect(DaemonLocator.nodeMajor("v26.7.0") == 26)
        #expect(DaemonLocator.nodeMajor("24.3.0") == nil)
        #expect(DaemonLocator.nodeMajor("") == nil)
    }

    @Test func picksTheFirstNewEnoughNode() {
        let versions = ["/a": "v22.1.0", "/b": "v24.0.0", "/c": "v26.0.0"]
        let r = DaemonLocator.findNode(candidates: ["/missing", "/a", "/b", "/c"], isExecutable: { versions[$0] != nil }, version: { versions[$0] })
        #expect(r == .success("/b"))
        #expect(DaemonLocator.findNode(candidates: ["/a"], isExecutable: { _ in true }, version: { versions[$0] })
            == .failure(.nodeNotFound))
    }

    @Test func findsTheDaemonFolder() {
        let have: Set<String> = ["/dev/companiond/src/daemon/main.ts", "/App.app/Contents/Resources/companiond/src/daemon/main.ts"]
        #expect(DaemonLocator.daemonDirectory(env: ["COMPANIOND_DIR": "/dev/companiond"], resourceURL: URL(fileURLWithPath: "/App.app/Contents/Resources"), fileExists: have.contains)
            == .success("/dev/companiond"))
        #expect(DaemonLocator.daemonDirectory(env: [:], resourceURL: URL(fileURLWithPath: "/App.app/Contents/Resources"), fileExists: have.contains)
            == .success("/App.app/Contents/Resources/companiond"))
        #expect(DaemonLocator.daemonDirectory(env: [:], resourceURL: nil, fileExists: have.contains) == .failure(.daemonNotFound))
    }

    @Test func launchPassesOnlyTheMinimalEnvironment() {
        let env = ["HOME": "/h", "USER": "u", "LOGNAME": "u", "TMPDIR": "/t/", "PATH": "/evil", "OPENAI_API_KEY": "SYNTHETIC FIXTURE not-a-key", "COMPANIOND_CODEX": "off"]
        let l = DaemonLocator.launch(node: "/n/node", daemonDir: "/d", env: env)
        #expect(l.executable == "/n/node")
        #expect(l.arguments == ["--disable-warning=ExperimentalWarning", "/d/src/daemon/main.ts"])
        #expect(l.environment == ["HOME": "/h", "USER": "u", "LOGNAME": "u", "TMPDIR": "/t/", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "COMPANIOND_CODEX": "off"])
        #expect(l.currentDirectory == "/d")
    }
}
```

`app/Tests/CompanionCoreTests/DaemonIntegrationTests.swift`:

```swift
import Foundation
import Testing
@testable import CompanionCore

/// Spawns the real companiond (M4b Task 7) with chat off and a fresh HOME, like M4b's main.test.ts.
/// Turns itself on when the daemon entry point exists and Node >= 24 is found (ruling 11).
enum DaemonITest {
    static let companiond = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "companiond").path
    static let node: String? = try? DaemonLocator.findNode(
        candidates: DaemonLocator.nodeCandidates(env: ProcessInfo.processInfo.environment, configured: nil),
        isExecutable: FileManager.default.isExecutableFile(atPath:),
        version: DaemonLocator.runVersion).get()
    static var available: Bool {
        node != nil && FileManager.default.fileExists(atPath: companiond + "/src/daemon/main.ts")
            && FileManager.default.fileExists(atPath: companiond + "/node_modules")
    }
}

@Suite(.serialized) struct DaemonIntegrationTests {
    @Test(.enabled(if: DaemonITest.available), .timeLimit(.minutes(1)))
    func answersOverStdioThenShutsDown() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "companion-itest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let env = ["HOME": home.path, "COMPANIOND_CODEX": "off", "TMPDIR": FileManager.default.temporaryDirectory.path]
        let launch = DaemonLocator.launch(node: DaemonITest.node!, daemonDir: DaemonITest.companiond, env: env)
        let client = DaemonClient(transport: try ProcessTransport(launch: launch))
        await client.start()

        #expect(try await client.hello().protocolVersion == 1)
        #expect(try await client.hostStatus() == .failed(detail: "Chat is off (COMPANIOND_CODEX=off)."))
        #expect(try await client.sessionsRefresh().desktopRecordsError == "Claude Desktop sessions not found")
        #expect(try await client.privacyGet().sharingMode == .ask)
        #expect(try await client.privacyGet().redactionNotice == RedactionNotice.text)
        try await client.settingsSet("ui.speech.rate", "1.5")
        #expect(try await client.settingsGet("ui.speech.rate") == "1.5")
        await #expect(throws: DaemonError.self) { try await client.settingsSet("ui.speech.autoPlay", "true") } // Store keys are lowercase
        try await client.shutdown()
        var sawDisconnect = false
        for await e in client.events where e == .disconnected { sawDisconnect = true }
        #expect(sawDisconnect)
        let support = home.appending(path: "Library/Application Support/ClaudeGPTCompanion").path
        let mode = try FileManager.default.attributesOfItem(atPath: support)[.posixPermissions] as? Int
        #expect(mode == 0o700)
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app && swift test --filter "DaemonLocatorTests|DaemonIntegrationTests"`
Expected: build FAIL — `cannot find 'DaemonLocator' in scope`.

- [ ] **Step 3: Implement** — append to `app/Sources/CompanionCore/Daemon/LineTransport.swift`:

```swift
/// companiond as a child process: stdin/stdout pipes, stderr discarded (Global Constraints, ruling 7).
public final class ProcessTransport: LineTransport, @unchecked Sendable {
    // @unchecked: `splitter` is touched only under `lock`; Process and the pipes are thread-safe for this use.
    public let lines: AsyncThrowingStream<Data, any Error>
    private let continuation: AsyncThrowingStream<Data, any Error>.Continuation
    private let process = Process()
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let writeQueue = DispatchQueue(label: "companion.daemon.stdin")
    private let lock = NSLock()
    private var splitter = LineSplitter()

    public init(launch: DaemonLaunch) throws {
        signal(SIGPIPE, SIG_IGN) // a write to a dead daemon must fail, not kill the app
        let (s, c) = AsyncThrowingStream.makeStream(of: Data.self)
        lines = s
        continuation = c
        process.executableURL = URL(fileURLWithPath: launch.executable)
        process.arguments = launch.arguments
        process.environment = launch.environment
        process.currentDirectoryURL = URL(fileURLWithPath: launch.currentDirectory, isDirectory: true)
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                c.finish()
                return
            }
            self?.consume(chunk)
        }
        try process.run()
    }

    private func consume(_ chunk: Data) {
        lock.lock()
        defer { lock.unlock() }
        do {
            for line in try splitter.push(chunk) { continuation.yield(line) }
        } catch {
            continuation.finish(throwing: error)
        }
    }

    public func send(_ line: Data) async throws {
        let handle = stdinPipe.fileHandleForWriting
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
            writeQueue.async {
                do {
                    try handle.write(contentsOf: line)
                    c.resume()
                } catch {
                    c.resume(throwing: error)
                }
            }
        }
    }

    /// Closing stdin shuts companiond down (M4b). Wait up to 3 s, then terminate.
    public func close() async {
        try? stdinPipe.fileHandleForWriting.close()
        for _ in 0..<30 where process.isRunning { try? await Task.sleep(for: .milliseconds(100)) }
        if process.isRunning { process.terminate() }
    }
}
```

`app/Sources/CompanionCore/Daemon/DaemonLocator.swift`:

```swift
import Foundation

public struct DaemonLaunch: Equatable, Sendable {
    public let executable: String
    public let arguments: [String]
    public let environment: [String: String]
    public let currentDirectory: String
}

public enum DaemonLaunchError: Error, LocalizedError, Equatable {
    case nodeNotFound, daemonNotFound
    public var errorDescription: String? {
        switch self {
        case .nodeNotFound: "Node.js 24 or newer was not found. Install it (brew install node) or set its path in Settings › Advanced."
        case .daemonNotFound: "companiond was not found in the app bundle. Rebuild the app with scripts/build-app.sh, or set COMPANIOND_DIR."
        }
    }
}

/// Finds Node and companiond and builds the child-process launch (ruling 1, ruling 7).
public enum DaemonLocator {
    public static let minimumNodeMajor = 24
    static let passedEnv = ["HOME", "USER", "LOGNAME", "TMPDIR", "COMPANIOND_CODEX"]

    public static func nodeCandidates(env: [String: String], configured: String?) -> [String] {
        var out: [String] = []
        if let p = env["COMPANION_NODE"], !p.isEmpty { out.append(p) }
        if let p = configured, !p.isEmpty { out.append(p) }
        out += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return out
    }

    public static func nodeMajor(_ versionOutput: String) -> Int? {
        let t = versionOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("v"), let first = t.dropFirst().split(separator: ".").first else { return nil }
        return Int(first)
    }

    public static func findNode(candidates: [String], isExecutable: (String) -> Bool, version: (String) -> String?) -> Result<String, DaemonLaunchError> {
        for c in candidates where isExecutable(c) {
            if let v = version(c), let major = nodeMajor(v), major >= minimumNodeMajor { return .success(c) }
        }
        return .failure(.nodeNotFound)
    }

    /// `node --version`, at most 5 s. The path is one of our own candidates, never user text from a page.
    public static func runVersion(_ node: String) -> String? {
        let p = Process()
        let out = Pipe()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["--version"]
        p.environment = ["PATH": "/usr/bin:/bin"]
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(5)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate(); return nil }
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
    }

    public static func daemonDirectory(env: [String: String], resourceURL: URL?, fileExists: (String) -> Bool) -> Result<String, DaemonLaunchError> {
        var dirs: [String] = []
        if let d = env["COMPANIOND_DIR"], !d.isEmpty { dirs.append(d) }
        if let r = resourceURL { dirs.append(r.appending(path: "companiond").path) }
        for d in dirs where fileExists(d + "/src/daemon/main.ts") { return .success(d) }
        return .failure(.daemonNotFound)
    }

    public static func launch(node: String, daemonDir: String, env: [String: String]) -> DaemonLaunch {
        var e = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        for k in passedEnv { if let v = env[k] { e[k] = v } }
        return DaemonLaunch(executable: node,
                            arguments: ["--disable-warning=ExperimentalWarning", daemonDir + "/src/daemon/main.ts"],
                            environment: e, currentDirectory: daemonDir)
    }

    /// The production connector. `configuredNode` is read at every (re)connect.
    public static func live(env: [String: String], configuredNode: @escaping @Sendable () -> String?, resourceURL: URL?) -> Connector {
        return {
            let node = try findNode(candidates: nodeCandidates(env: env, configured: configuredNode()),
                                    isExecutable: FileManager.default.isExecutableFile(atPath:), version: runVersion).get()
            let dir = try daemonDirectory(env: env, resourceURL: resourceURL, fileExists: FileManager.default.fileExists(atPath:)).get()
            let client = DaemonClient(transport: try ProcessTransport(launch: launch(node: node, daemonDir: dir, env: env)))
            await client.start()
            return Connection(api: client, events: client.events, close: { await client.close() })
        }
    }
}
```

- [ ] **Step 4: Stage companiond into the bundle** — in `scripts/build-app.sh`, after the line `cp app/bundle/Info.plist "$out/Contents/Info.plist"` and before `plutil -lint`, insert:

```bash
# companiond (M5, ruling 1): sources + production dependencies, run with the user's Node >= 24.
res="$out/Contents/Resources/companiond"
mkdir -p "$res"
cp companiond/package.json companiond/package-lock.json "$res/"
cp -R companiond/src "$res/src"
(cd "$res" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
```

and in the `# Verification` block, after `codesign --verify --strict --verbose=2 "$out"`, insert:

```bash
test -f "$out/Contents/Resources/companiond/src/lineBuffer.ts"
test -d "$out/Contents/Resources/companiond/node_modules/@openai/codex"
```

and, since M4b part 2 is merged, the entry point too:

```bash
test -f "$out/Contents/Resources/companiond/src/daemon/main.ts"
```

In `app/bundle/Info.plist` change `<key>CFBundleShortVersionString</key><string>0.4.0</string>` to `<key>CFBundleShortVersionString</key><string>0.5.0</string>` (ruling 17).

In `.github/workflows/tests.yml`, `app` job, before `- run: swift test` insert:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Install companiond (daemon integration test, bundle staging)
        working-directory: companiond
        run: npm ci
      - name: Point the daemon integration test at this Node
        run: echo "COMPANION_NODE=$(command -v node)" >> "$GITHUB_ENV"
```

`actions/setup-node` installs into the tool cache, not `/opt/homebrew/bin`, so without `COMPANION_NODE` the integration test would skip or use the runner image's Node.

- [ ] **Step 5: Run the tests and the bundle build**

Run: `cd app && swift test --filter "DaemonLocatorTests|DaemonIntegrationTests" && cd .. && bash scripts/build-app.sh`
Expected: `DaemonLocatorTests` PASS. `DaemonIntegrationTests` PASS (run `cd companiond && npm ci` first; on a Mac without Node ≥ 24 it is reported as skipped). `build-app.sh` ends with `built and verified: app/build/ClaudeGPT Companion.app (identity: -)`.
If `codesign --verify --strict` refuses the bundle because of the Codex binary under `Contents/Resources` (nested code), STOP: record the exact message in the shared notes and send it to the orchestrator; do not re-sign OpenAI's binary. Until ruled, development runs with `COMPANIOND_DIR=<repo>/companiond`.

- [ ] **Step 6: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore/Daemon app/Tests/CompanionCoreTests/DaemonLocatorTests.swift app/Tests/CompanionCoreTests/DaemonIntegrationTests.swift scripts/build-app.sh app/bundle/Info.plist .github/workflows/tests.yml
git commit -m "feat(app): launch companiond from the bundle with the user's Node" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Conversation reducer

One Claude session's chat for this run. Deltas can arrive before `chat.send` answers (CodexHost emits as it goes; the merged M4b interface notes that `turn/completed` can even come first), so events for a turn the reducer does not know yet are buffered and replayed when the turn is attached.

**Files:**
- Create: `app/Sources/CompanionCore/Chat/Conversation.swift`
- Test: `app/Tests/CompanionCoreTests/ConversationTests.swift`

**Interfaces:**
- Consumes: Task 2 (`ItemSummary`).
- Produces: `struct PendingSend { prepareId; removeItemIds; confirmed }`; `struct ChatMessage: Identifiable, Equatable, Sendable { id: UUID; role: Role (.user/.assistant); text; status: Status (.sending/.streaming/.done/.interrupted/.failed(String)); threadId; turnId; activity: String?; retry: PendingSend?; var isRunning }`; `enum TurnEvent { delta(turnId:itemId:text:), item(turnId:phase:item:), completed(turnId:status:error:) }`; `struct Conversation { static earlyTurnCap, earlyEventCap; messages; isRunning; mutating begin(question:) -> UUID; attach(_:threadId:turnId:); fail(_:message:retry:); discard(_:); apply(_:); stopRunning(reason:); message(forTurn:) -> ChatMessage?; owns(turnId:) -> Bool; question(before:) -> String? }`. A `"abandoned"` (or any non-completed, non-interrupted) status becomes `.failed(error)`.

- [ ] **Step 1: Write the failing test** — `app/Tests/CompanionCoreTests/ConversationTests.swift`:

```swift
import Foundation
import Testing
@testable import CompanionCore

@Suite struct ConversationTests {
    @Test func streamsDeltasIntoTheReply() {
        var c = Conversation()
        let id = c.begin(question: "What broke?")
        #expect(c.messages.map(\.role) == [.user, .assistant])
        #expect(c.messages[1].status == .sending)
        c.attach(id, threadId: "t", turnId: "u1")
        c.apply(.delta(turnId: "u1", itemId: "i1", text: "Hel"))
        c.apply(.delta(turnId: "u1", itemId: "i1", text: "lo"))
        c.apply(.delta(turnId: "u1", itemId: "i2", text: "Second part"))
        #expect(c.messages[1].text == "Hello\n\nSecond part")
        #expect(c.messages[1].status == .streaming)
        #expect(c.isRunning)
        c.apply(.completed(turnId: "u1", status: "completed", error: nil))
        #expect(c.messages[1].status == .done)
        #expect(!c.isRunning)
    }

    @Test func eventsBeforeAttachAreReplayed() {
        var c = Conversation()
        let id = c.begin(question: "q")
        c.apply(.delta(turnId: "u9", itemId: "i", text: "early"))
        c.apply(.completed(turnId: "u9", status: "completed", error: nil))
        #expect(c.messages[1].text == "")
        c.attach(id, threadId: "t", turnId: "u9")
        #expect(c.messages[1].text == "early")
        #expect(c.messages[1].status == .done)
    }

    @Test func toolActivityAndFinalStatuses() {
        var c = Conversation()
        let a = c.begin(question: "q")
        c.attach(a, threadId: "t", turnId: "u1")
        let tool = ItemSummary(id: "x", type: "mcpToolCall", server: "companion-readonly", tool: "read_file", status: nil)
        c.apply(.item(turnId: "u1", phase: "started", item: tool))
        #expect(c.messages[1].activity == "Reading the repository…")
        c.apply(.item(turnId: "u1", phase: "completed", item: tool))
        #expect(c.messages[1].activity == nil)
        c.apply(.completed(turnId: "u1", status: "interrupted", error: nil))
        #expect(c.messages[1].status == .interrupted)

        let b = c.begin(question: "q2")
        c.attach(b, threadId: "t", turnId: "u2")
        c.apply(.completed(turnId: "u2", status: "failed", error: "usage limit"))
        #expect(c.messages[3].status == .failed("usage limit"))
        let d = c.begin(question: "q3")
        c.attach(d, threadId: "t", turnId: "u3")
        c.apply(.completed(turnId: "u3", status: "abandoned", error: "Codex restarted before this reply finished. Ask again."))
        #expect(c.messages[5].status == .failed("Codex restarted before this reply finished. Ask again."))
        c.apply(.delta(turnId: "u2", itemId: "late", text: "ignored"))
        #expect(c.messages[3].text == "")
    }

    @Test func sameItemIdInTwoTurnsDoesNotMix() {
        var c = Conversation()
        let a = c.begin(question: "q1")
        c.attach(a, threadId: "t", turnId: "u1")
        c.apply(.delta(turnId: "u1", itemId: "msg", text: "first"))
        let b = c.begin(question: "q2")
        c.attach(b, threadId: "t", turnId: "u2")
        c.apply(.delta(turnId: "u2", itemId: "msg", text: "second"))
        #expect(c.messages[1].text == "first")
        #expect(c.messages[3].text == "second")
    }

    @Test func failDiscardAndStop() {
        var c = Conversation()
        let a = c.begin(question: "one")
        let retry = PendingSend(prepareId: "p1", removeItemIds: [], confirmed: true)
        c.fail(a, message: "GPT is still answering.", retry: retry)
        #expect(c.messages[1].status == .failed("GPT is still answering."))
        #expect(c.messages[1].retry == retry)
        #expect(c.question(before: a) == "one")
        let b = c.begin(question: "two")
        c.discard(b)
        #expect(c.messages.count == 2)
        let d = c.begin(question: "three")
        c.attach(d, threadId: "t", turnId: "u3")
        c.stopRunning(reason: "Codex restarted. Ask again.")
        #expect(c.messages[3].status == .failed("Codex restarted. Ask again."))
        #expect(c.owns(turnId: "u3"))
        #expect(c.message(forTurn: "u3")?.id == d)
    }

    @Test func earlyBufferIsBounded() {
        var c = Conversation()
        for t in 0..<50 { c.apply(.delta(turnId: "t\(t)", itemId: "i", text: "x")) }
        for _ in 0..<5_000 { c.apply(.delta(turnId: "t49", itemId: "i", text: "x")) }
        let id = c.begin(question: "q")
        c.attach(id, threadId: "t", turnId: "t49")
        #expect(c.messages[1].text.count == Conversation.earlyEventCap)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && swift test --filter ConversationTests`
Expected: build FAIL — `cannot find 'Conversation' in scope`.

- [ ] **Step 3: Implement** — `app/Sources/CompanionCore/Chat/Conversation.swift`:

```swift
import Foundation

/// What chat.send needs to send a prepared message (again).
public struct PendingSend: Equatable, Sendable {
    public let prepareId: String
    public let removeItemIds: [String]
    public let confirmed: Bool
    public init(prepareId: String, removeItemIds: [String], confirmed: Bool) {
        self.prepareId = prepareId
        self.removeItemIds = removeItemIds
        self.confirmed = confirmed
    }
}

public struct ChatMessage: Identifiable, Equatable, Sendable {
    public enum Role: Sendable, Equatable { case user, assistant }
    public enum Status: Sendable, Equatable { case sending, streaming, done, interrupted, failed(String) }
    public let id: UUID
    public let role: Role
    public var text: String
    public var status: Status
    public var threadId: String?
    public var turnId: String?
    /// "Reading the repository…" while a companion-readonly tool call runs.
    public var activity: String?
    /// Set after hostBusy / turnBusy / hostNotReady: the same prepareId may be sent again ("Send again").
    public var retry: PendingSend?
    public var isRunning: Bool { role == .assistant && (status == .sending || status == .streaming) }
}

public enum TurnEvent: Sendable, Equatable {
    case delta(turnId: String, itemId: String, text: String)
    case item(turnId: String, phase: String, item: ItemSummary)
    case completed(turnId: String, status: String, error: String?)
    var turnId: String {
        switch self {
        case .delta(let t, _, _), .item(let t, _, _), .completed(let t, _, _): t
        }
    }
}

/// One Claude session's chat for this app run (ruling 4).
public struct Conversation: Equatable, Sendable {
    public static let earlyTurnCap = 8
    public static let earlyEventCap = 2_000

    public private(set) var messages: [ChatMessage] = []
    private var turnToMessage: [String: UUID] = [:]
    private var itemOrder: [String: [String]] = [:]
    private var itemText: [String: String] = [:]
    private var early: [String: [TurnEvent]] = [:]
    private var earlyOrder: [String] = []

    public init() {}

    public var isRunning: Bool { messages.contains { $0.isRunning } }

    @discardableResult
    public mutating func begin(question: String) -> UUID {
        messages.append(ChatMessage(id: UUID(), role: .user, text: question, status: .done))
        let id = UUID()
        messages.append(ChatMessage(id: id, role: .assistant, text: "", status: .sending))
        return id
    }

    public mutating func attach(_ id: UUID, threadId: String, turnId: String) {
        guard let i = index(id) else { return }
        messages[i].threadId = threadId
        messages[i].turnId = turnId
        if messages[i].status == .sending { messages[i].status = .streaming }
        turnToMessage[turnId] = id
        earlyOrder.removeAll { $0 == turnId }
        for e in early.removeValue(forKey: turnId) ?? [] { apply(e) }
    }

    public mutating func fail(_ id: UUID, message: String, retry: PendingSend? = nil) {
        guard let i = index(id) else { return }
        messages[i].status = .failed(message)
        messages[i].activity = nil
        messages[i].retry = retry
    }

    /// The user's question right before an assistant message.
    public func question(before id: UUID) -> String? {
        guard let i = index(id), i > 0, messages[i - 1].role == .user else { return nil }
        return messages[i - 1].text
    }

    /// Removes an assistant placeholder and the question before it (a send that never started).
    public mutating func discard(_ id: UUID) {
        guard let i = index(id) else { return }
        messages.remove(at: i)
        if i > 0, messages[i - 1].role == .user { messages.remove(at: i - 1) }
    }

    public mutating func apply(_ e: TurnEvent) {
        guard let id = turnToMessage[e.turnId], let i = index(id) else {
            buffer(e)
            return
        }
        guard messages[i].isRunning else { return } // late events after the end are dropped
        switch e {
        case let .delta(turnId, itemId, text):
            if !(itemOrder[turnId]?.contains(itemId) ?? false) { itemOrder[turnId, default: []].append(itemId) }
            itemText[turnId + "\u{0}" + itemId, default: ""] += text
            messages[i].text = (itemOrder[turnId] ?? []).compactMap { itemText[turnId + "\u{0}" + $0] }.joined(separator: "\n\n")
            messages[i].status = .streaming
        case let .item(_, phase, item):
            if item.type == "mcpToolCall" { messages[i].activity = phase == "started" ? "Reading the repository…" : nil }
        case let .completed(_, status, error):
            messages[i].activity = nil
            messages[i].status = switch status {
            case "completed": .done
            case "interrupted": .interrupted
            default: .failed(error ?? "The reply stopped (\(status)).")
            }
        }
    }

    public mutating func stopRunning(reason: String) {
        for i in messages.indices where messages[i].isRunning {
            messages[i].status = .failed(reason)
            messages[i].activity = nil
        }
    }

    public func owns(turnId: String) -> Bool { turnToMessage[turnId] != nil }

    public func message(forTurn turnId: String) -> ChatMessage? {
        turnToMessage[turnId].flatMap { id in messages.first { $0.id == id } }
    }

    private func index(_ id: UUID) -> Int? { messages.firstIndex { $0.id == id } }

    private mutating func buffer(_ e: TurnEvent) {
        let t = e.turnId
        if early[t] == nil {
            if earlyOrder.count >= Self.earlyTurnCap, let oldest = earlyOrder.first {
                earlyOrder.removeFirst()
                early[oldest] = nil
            }
            earlyOrder.append(t)
        }
        var list = early[t] ?? []
        guard list.count < Self.earlyEventCap else { return }
        list.append(e)
        early[t] = list
    }
}
```

- [ ] **Step 4: Run the test**

Run: `cd app && swift test --filter ConversationTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore/Chat app/Tests/CompanionCoreTests/ConversationTests.swift
git commit -m "feat(app): add the chat reducer with early-event buffering" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: UI settings, hotkey spec and panel geometry (pure)

**Files:**
- Create: `app/Sources/CompanionCore/Model/UISettings.swift`, `app/Sources/CompanionCore/Window/HotkeySpec.swift`, `app/Sources/CompanionCore/Window/PanelGeometry.swift`
- Test: `app/Tests/CompanionCoreTests/UISettingsTests.swift`, `app/Tests/CompanionCoreTests/HotkeySpecTests.swift`, `app/Tests/CompanionCoreTests/PanelGeometryTests.swift`; modify `app/Tests/CompanionCoreTests/DaemonIntegrationTests.swift` (every key round-trips)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `enum EditorChoice: String, CaseIterable, Sendable { auto, vscode, cursor, xcode, system; var title }`
  - `enum UIKey { speechRate = "ui.speech.rate", voice = "ui.speech.voice", autoPlay = "ui.speech.autoplay", readCode = "ui.speech.read_code", follow = "ui.window.follow", width = "ui.window.width", hotkey = "ui.hotkey", editor = "ui.editor"; static let all }`
  - `struct UISettings: Equatable, Sendable { speechRate = 1.0; voiceIdentifier: String? = nil; autoPlay = false; readCode = false; followClaude = false; panelWidth = 360; hotkey = .default; editor = .auto; static func load(_ get: @Sendable (String) async throws -> String?) async -> UISettings; var values: [String: String]; func changes(from:) -> [(key: String, value: String)] }`
  - `struct HotkeySpec: Equatable, Sendable { key; control; option; shift; command; static let default (⌥⌘G); init?(string:); var string; var display; var isValid; var carbonModifiers: UInt32; var carbonKeyCode: UInt32? }`
  - `enum PanelGeometry { minWidth 280, maxWidth 640, defaultWidth 360; clampWidth(_:); dockedFrame(width:claudeFrame:visibleFrame:) -> CGRect; appKitRect(fromTopLeft:primaryScreenHeight:) -> CGRect }`

- [ ] **Step 1: Write the failing tests** — `app/Tests/CompanionCoreTests/UISettingsTests.swift`:

```swift
import Testing
@testable import CompanionCore

@Suite struct UISettingsTests {
    @Test func defaults() {
        let s = UISettings()
        #expect(s.speechRate == 1.0 && s.voiceIdentifier == nil && !s.autoPlay && !s.readCode && !s.followClaude)
        #expect(s.panelWidth == 360 && s.hotkey == .default && s.editor == .auto)
    }

    @Test func loadsAndClampsStoredValues() async {
        let stored = ["ui.speech.rate": "3", "ui.speech.voice": "com.apple.voice.x", "ui.speech.autoplay": "true",
                      "ui.window.width": "100", "ui.hotkey": "ctrl+opt+K", "ui.editor": "cursor", "ui.window.follow": "nonsense"]
        let s = await UISettings.load { stored[$0] }
        #expect(s.speechRate == 2.0)
        #expect(s.voiceIdentifier == "com.apple.voice.x")
        #expect(s.autoPlay)
        #expect(s.panelWidth == 280)
        #expect(s.hotkey == HotkeySpec(key: "K", control: true, option: true))
        #expect(s.editor == .cursor)
        #expect(!s.followClaude)
    }

    @Test func aFailingStoreGivesDefaults() async {
        struct Boom: Error {}
        #expect(await UISettings.load { _ in throw Boom() } == UISettings())
    }

    @Test func changesListOnlyWhatDiffers() {
        var s = UISettings()
        let old = s
        s.speechRate = 1.5
        s.voiceIdentifier = nil
        s.hotkey = HotkeySpec(key: "J", command: true)
        #expect(s.changes(from: old).map(\.key) == ["ui.hotkey", "ui.speech.rate"])
        #expect(s.values["ui.speech.voice"] == "")
    }

    @Test func everyKeyIsAcceptedByTheStore() {
        // companiond/src/store/store.ts: const UI_KEY = /^ui\.[a-z0-9_.]{1,64}$/
        for k in UIKey.all { #expect(k.wholeMatch(of: /ui\.[a-z0-9_.]{1,64}/) != nil, "\(k)") }
        #expect(Set(UIKey.all) == Set(UISettings().values.keys))
    }
}
```

`app/Tests/CompanionCoreTests/HotkeySpecTests.swift`:

```swift
import Carbon.HIToolbox
import Testing
@testable import CompanionCore

@Suite struct HotkeySpecTests {
    @Test func defaultIsOptionCommandG() {
        #expect(HotkeySpec.default.string == "opt+cmd+G")
        #expect(HotkeySpec.default.display == "⌥⌘G")
        #expect(HotkeySpec.default.carbonKeyCode == UInt32(kVK_ANSI_G))
        #expect(HotkeySpec.default.carbonModifiers == UInt32(optionKey | cmdKey))
    }

    @Test func parsesAndRoundTrips() {
        let s = HotkeySpec(string: "cmd+shift+ctrl+7")
        #expect(s == HotkeySpec(key: "7", control: true, shift: true, command: true))
        #expect(s?.string == "ctrl+shift+cmd+7")
        #expect(s?.display == "⌃⇧⌘7")
        #expect(HotkeySpec(string: s!.string) == s)
    }

    @Test func rejectsBadShortcuts() {
        #expect(HotkeySpec(string: "G") == nil)            // no modifier
        #expect(HotkeySpec(string: "shift+G") == nil)      // shift alone is not enough
        #expect(HotkeySpec(string: "cmd+F1") == nil)       // only one letter or digit
        #expect(HotkeySpec(string: "cmd+G+H") == nil)
        #expect(HotkeySpec(string: "cmd+é") == nil)
    }
}
```

`app/Tests/CompanionCoreTests/PanelGeometryTests.swift`:

```swift
import CoreGraphics
import Testing
@testable import CompanionCore

@Suite struct PanelGeometryTests {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 944) // visibleFrame, AppKit coordinates

    @Test func clampsWidth() {
        #expect(PanelGeometry.clampWidth(100) == 280)
        #expect(PanelGeometry.clampWidth(900) == 640)
        #expect(PanelGeometry.clampWidth(400) == 400)
    }

    @Test func noClaudeWindowDocksAtTheScreenEdge() {
        #expect(PanelGeometry.dockedFrame(width: 360, claudeFrame: nil, visibleFrame: screen) == CGRect(x: 0, y: 0, width: 360, height: 944))
    }

    @Test func flushLeftOfClaude() {
        let claude = CGRect(x: 500, y: 100, width: 900, height: 700)
        #expect(PanelGeometry.dockedFrame(width: 360, claudeFrame: claude, visibleFrame: screen) == CGRect(x: 140, y: 100, width: 360, height: 700))
    }

    @Test func noRoomGoesToTheScreenEdge() {
        let claude = CGRect(x: 100, y: 0, width: 1400, height: 944)
        #expect(PanelGeometry.dockedFrame(width: 360, claudeFrame: claude, visibleFrame: screen).minX == 0)
    }

    @Test func heightStaysOnScreen() {
        let claude = CGRect(x: 800, y: -50, width: 600, height: 1200)
        let f = PanelGeometry.dockedFrame(width: 300, claudeFrame: claude, visibleFrame: screen)
        #expect(f.minY == 0 && f.maxY == 944)
    }

    @Test func convertsTopLeftCoordinates() {
        // AX and CGWindowList use a top-left origin on the primary screen; AppKit uses bottom-left.
        #expect(PanelGeometry.appKitRect(fromTopLeft: CGRect(x: 10, y: 20, width: 100, height: 200), primaryScreenHeight: 982)
            == CGRect(x: 10, y: 762, width: 100, height: 200))
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app && swift test --filter "UISettingsTests|HotkeySpecTests|PanelGeometryTests"`
Expected: build FAIL — `cannot find 'UISettings' in scope`.

- [ ] **Step 3: Implement** — `app/Sources/CompanionCore/Window/HotkeySpec.swift`:

```swift
import Carbon.HIToolbox

/// The show/hide shortcut (spec §8, default ⌥⌘G). Stored as e.g. "opt+cmd+G".
public struct HotkeySpec: Equatable, Sendable {
    public var key: String
    public var control: Bool
    public var option: Bool
    public var shift: Bool
    public var command: Bool

    public static let `default` = HotkeySpec(key: "G", option: true, command: true)

    public init(key: String, control: Bool = false, option: Bool = false, shift: Bool = false, command: Bool = false) {
        self.key = key
        self.control = control
        self.option = option
        self.shift = shift
        self.command = command
    }

    public init?(string: String) {
        var s = HotkeySpec(key: "")
        for part in string.split(separator: "+").map({ $0.lowercased() }) {
            switch part {
            case "ctrl": s.control = true
            case "opt": s.option = true
            case "shift": s.shift = true
            case "cmd": s.command = true
            default:
                guard part.count == 1, s.key.isEmpty else { return nil }
                s.key = part.uppercased()
            }
        }
        guard s.isValid else { return nil }
        self = s
    }

    public var isValid: Bool { Self.keyCodes[key] != nil && (control || option || command) }

    public var string: String {
        var p: [String] = []
        if control { p.append("ctrl") }
        if option { p.append("opt") }
        if shift { p.append("shift") }
        if command { p.append("cmd") }
        return (p + [key]).joined(separator: "+")
    }

    public var display: String {
        (control ? "⌃" : "") + (option ? "⌥" : "") + (shift ? "⇧" : "") + (command ? "⌘" : "") + key
    }

    public var carbonModifiers: UInt32 {
        var m = 0
        if control { m |= controlKey }
        if option { m |= optionKey }
        if shift { m |= shiftKey }
        if command { m |= cmdKey }
        return UInt32(m)
    }

    public var carbonKeyCode: UInt32? { Self.keyCodes[key].map { UInt32($0) } }

    static let keyCodes: [String: Int] = [
        "A": kVK_ANSI_A, "B": kVK_ANSI_B, "C": kVK_ANSI_C, "D": kVK_ANSI_D, "E": kVK_ANSI_E, "F": kVK_ANSI_F,
        "G": kVK_ANSI_G, "H": kVK_ANSI_H, "I": kVK_ANSI_I, "J": kVK_ANSI_J, "K": kVK_ANSI_K, "L": kVK_ANSI_L,
        "M": kVK_ANSI_M, "N": kVK_ANSI_N, "O": kVK_ANSI_O, "P": kVK_ANSI_P, "Q": kVK_ANSI_Q, "R": kVK_ANSI_R,
        "S": kVK_ANSI_S, "T": kVK_ANSI_T, "U": kVK_ANSI_U, "V": kVK_ANSI_V, "W": kVK_ANSI_W, "X": kVK_ANSI_X,
        "Y": kVK_ANSI_Y, "Z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
        "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
    ]
}
```

`app/Sources/CompanionCore/Window/PanelGeometry.swift`:

```swift
import CoreGraphics

/// Panel placement math (spec §8). All rects are AppKit screen coordinates unless named otherwise.
public enum PanelGeometry {
    public static let minWidth: CGFloat = 280
    public static let maxWidth: CGFloat = 640
    public static let defaultWidth: CGFloat = 360

    public static func clampWidth(_ w: CGFloat) -> CGFloat { min(max(w, minWidth), maxWidth) }

    /// Flush to Claude's left edge with Claude's height, or at the screen's left edge when there is no room
    /// or no Claude window. Always inside `visibleFrame` vertically.
    public static func dockedFrame(width: CGFloat, claudeFrame: CGRect?, visibleFrame v: CGRect) -> CGRect {
        let w = clampWidth(width)
        guard let c = claudeFrame else { return CGRect(x: v.minX, y: v.minY, width: w, height: v.height) }
        let x = c.minX - w >= v.minX ? c.minX - w : v.minX
        let y = max(c.minY, v.minY)
        let top = min(c.maxY, v.maxY)
        return CGRect(x: x, y: y, width: w, height: max(top - y, 200))
    }

    /// AX and CGWindowList rects have their origin at the top left of the primary screen.
    public static func appKitRect(fromTopLeft r: CGRect, primaryScreenHeight h: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height)
    }
}
```

`app/Sources/CompanionCore/Model/UISettings.swift`:

```swift
import Foundation

public enum EditorChoice: String, CaseIterable, Sendable {
    case auto, vscode, cursor, xcode, system
    public var title: String {
        switch self {
        case .auto: "Automatic (VS Code if installed)"
        case .vscode: "Visual Studio Code"
        case .cursor: "Cursor"
        case .xcode: "Xcode"
        case .system: "Default app for the file"
        }
    }
}

/// Keys in the daemon Store (`settings.get/set`). The Store accepts only `^ui\.[a-z0-9_.]{1,64}$` (lowercase).
public enum UIKey {
    public static let speechRate = "ui.speech.rate"
    public static let voice = "ui.speech.voice"
    public static let autoPlay = "ui.speech.autoplay"
    public static let readCode = "ui.speech.read_code"
    public static let follow = "ui.window.follow"
    public static let width = "ui.window.width"
    public static let hotkey = "ui.hotkey"
    public static let editor = "ui.editor"
    public static let all = [speechRate, voice, autoPlay, readCode, follow, width, hotkey, editor]
}

public struct UISettings: Equatable, Sendable {
    public var speechRate = 1.0
    public var voiceIdentifier: String? = nil
    public var autoPlay = false
    public var readCode = false
    public var followClaude = false
    public var panelWidth = 360.0
    public var hotkey = HotkeySpec.default
    public var editor = EditorChoice.auto

    public init() {}

    /// Reads every key; anything missing, unreadable or malformed keeps its default.
    public static func load(_ get: @Sendable (String) async throws -> String?) async -> UISettings {
        var s = UISettings()
        func read(_ k: String) async -> String? { (try? await get(k)) ?? nil }
        if let v = await read(UIKey.speechRate).flatMap(Double.init) { s.speechRate = min(max(v, 0.5), 2.0) }
        if let v = await read(UIKey.voice), !v.isEmpty { s.voiceIdentifier = v }
        if let v = await read(UIKey.autoPlay) { s.autoPlay = v == "true" }
        if let v = await read(UIKey.readCode) { s.readCode = v == "true" }
        if let v = await read(UIKey.follow) { s.followClaude = v == "true" }
        if let v = await read(UIKey.width).flatMap(Double.init) { s.panelWidth = Double(PanelGeometry.clampWidth(v)) }
        if let v = await read(UIKey.hotkey).flatMap(HotkeySpec.init(string:)) { s.hotkey = v }
        if let v = await read(UIKey.editor).flatMap(EditorChoice.init(rawValue:)) { s.editor = v }
        return s
    }

    public var values: [String: String] {
        [UIKey.speechRate: String(speechRate), UIKey.voice: voiceIdentifier ?? "", UIKey.autoPlay: String(autoPlay),
         UIKey.readCode: String(readCode), UIKey.follow: String(followClaude), UIKey.width: String(Int(panelWidth)),
         UIKey.hotkey: hotkey.string, UIKey.editor: editor.rawValue]
    }

    public func changes(from old: UISettings) -> [(key: String, value: String)] {
        let a = old.values
        return values.filter { a[$0.key] != $0.value }.sorted { $0.key < $1.key }.map { (key: $0.key, value: $0.value) }
    }
}
```

- [ ] **Step 4: Round-trip every key through the real daemon** — in `app/Tests/CompanionCoreTests/DaemonIntegrationTests.swift`, after the `ui.speech.autoPlay` refusal line, add:

```swift
        for (k, v) in UISettings().values {
            try await client.settingsSet(k, v)
            #expect(try await client.settingsGet(k) == v, "\(k)")
        }
```

- [ ] **Step 5: Run the tests**

Run: `cd app && swift test --filter "UISettingsTests|HotkeySpecTests|PanelGeometryTests|DaemonIntegrationTests"`
Expected: PASS, including the integration test's key round-trip.

- [ ] **Step 6: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore/Model/UISettings.swift app/Sources/CompanionCore/Window app/Tests/CompanionCoreTests/UISettingsTests.swift app/Tests/CompanionCoreTests/HotkeySpecTests.swift app/Tests/CompanionCoreTests/PanelGeometryTests.swift app/Tests/CompanionCoreTests/DaemonIntegrationTests.swift
git commit -m "feat(app): add UI settings, the hotkey spec and panel geometry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `AppModel` — state, the ask flow, events

The one place that decides what is sent. It owns no AppKit; the shell injects two callbacks (`onSettingsChanged`, `onReplyCompleted`).

**Files:**
- Create: `app/Sources/CompanionCore/Model/AppModel.swift`, `app/Sources/CompanionCore/Model/AppModel+Display.swift`
- Test: `app/Tests/CompanionCoreTests/FakeDaemon.swift`, `app/Tests/CompanionCoreTests/AppModelTests.swift`

**Interfaces:**
- Consumes: Tasks 2, 3 (`DaemonAPI`, `Connection`, `Connector`), 5 (`Conversation`, `ChatMessage`, `TurnEvent`), 6 (`UISettings`).
- Produces:
  - Added in the M4b reconciliation: `revokeNotice`, `dismissRevokeNotice()`, `static func revokeText(_: RevokeResult) -> String?`.
  - Added after review: `authError`, `threadNotices`, `isSecurityStop`, `acknowledgeSecurityStop()`, `loadAuth()` (public, Retry), `sendAgain(_:)`, `canExplain`, `currentThreadNotice`, `dismissThreadNotice()`. `confirmPreview()` is the only path that sends `confirmed: true`.
  - `enum ConnectionState { connecting, connected(daemonVersion:), stopped(String) }`; `enum Gate { ready, connecting, daemonStopped(String), hostStarting, hostFailed(String), securityStop(String), signedOut, authUnsupported(String), authError(String), noSession }`; `struct PendingPreview: Identifiable { question; prepared; removed: Set<String>; notice: String?; var summaryLine }`; `enum SentView: Identifiable { found(SentRecord), notKept(turnId:) }`
  - `@MainActor @Observable final class AppModel` — read-only state: `connection, host, auth, snapshot, privacy, worktrees, syncs, repoBanners, alerts, syncError, conversations, settings`; settable: `draft, preview, sentView, errorMessage`; callbacks: `onSettingsChanged: ((UISettings) -> Void)?`, `onReplyCompleted: ((UUID, String) -> Void)?`; `init(connector:)`; actions: `start()`, `shutdown()`, `restartDaemon()`, `restartHost()`, `refresh()`, `pin(_:)`, `followFocus()`, `picker(query:) -> PickerGroups?`, `submitDraft()`, `ask(_:) -> Bool`, `explainLastMessage()`, `toggle(itemId:)`, `cancelPreview()`, `confirmPreview()`, `interrupt()`, `approve(root:includeWorktrees:) -> String?`, `revoke(root:)`, `setSharingMode(_:)`, `signIn() -> URL?`, `viewSent(_:)`, `setSetting(_:_:)`, `appendToDraft(_:)`, `dismiss(alert:)`, `dismissRepoBanner()`, `dismissSyncError()`, `handle(_ e: DaemonEvent)`; display (Task 7 `+Display`): `gate, selectedSessionId, selectedSession, currentMessages, currentWorktree, currentRoot, repoSummary, repoHelp, selectionLabel, syncSummary, focusMovedTitle, currentRepoBanner, unavailableRepo, redactionNotice, isAnswering, canSend`; `SecurityAlert.bannerText`, `SessionSummary.locationLine`, `RepoLine.summary`; `static let explainQuestion = "Explain Claude's last message simply."`.

- [ ] **Step 1: Write the fake and the failing tests** — `app/Tests/CompanionCoreTests/FakeDaemon.swift`:

```swift
import Foundation
@testable import CompanionCore

/// Scriptable DaemonAPI for AppModel tests. @MainActor: every call is serialised on the main actor, so the fake's
/// state is never touched concurrently (main-actor async methods satisfy the nonisolated async requirements).
@MainActor final class FakeDaemon: DaemonAPI {
    static let storeKey = /ui\.[a-z0-9_.]{1,64}/ // companiond/src/store/store.ts
    var calls: [String] = []
    /// prepareIds the daemon would refuse without `confirmed: true` (M4b 1011).
    var needsConfirm: Set<String> = []
    var host: HostState = .ready(warnings: [])
    var auth: AuthState = .signedIn(planType: "plus")
    var snapshot = FakeDaemon.snap(selected: "s1")
    var privacy = PrivacyState(sharingMode: .ask, approvals: [], redactionNotice: RedactionNotice.text)
    var worktree: WorktreeResolution? = .resolved(root: "/r", branch: "main", isLinkedWorktree: true)
    var prepareResults: [Result<Prepared, DaemonError>] = []
    var sendResults: [Result<SendResult, DaemonError>] = []
    var approveError: DaemonError?
    var sent: [SentRecord] = []
    var stored: [String: String] = [:]
    var sendParams: [(prepareId: String, removed: [String], confirmed: Bool)] = []
    /// Runs inside chat.send before it answers (events that arrive "before the response").
    var duringSend: (@MainActor () async -> Void)?
    let events: AsyncStream<DaemonEvent>
    let sink: AsyncStream<DaemonEvent>.Continuation

    init() {
        let (s, c) = AsyncStream.makeStream(of: DaemonEvent.self)
        events = s
        sink = c
    }
    nonisolated var connection: Connection { Connection(api: self, events: events, close: {}) }

    static func session(_ id: String, title: String) -> SessionSummary {
        SessionSummary(sessionId: id, cliSessionId: "c-\(id)", title: title, status: .idle, isArchived: false,
                       lastFocusedAt: 1, lastActivityAt: 1, recordCwd: "/r", recordBranch: "main", resolvedRoot: "/r",
                       source: "desktop", transcriptMissing: nil)
    }
    static func snap(selected: String?, via: String = "focus", focusMovedTo: String? = nil) -> SessionsSnapshot {
        SessionsSnapshot(
            sessions: [session("s1", title: "SYNTHETIC FIXTURE one"), session("s2", title: "SYNTHETIC FIXTURE two")],
            selection: Selection(sessionId: selected, via: selected == nil ? "none" : via, focusedSessionId: "s1",
                                 focusLabel: "Claude focus (from Claude's records)", focusMovedTo: focusMovedTo, pinnedMissing: false),
            desktopRecordsError: nil, refreshedAt: 1)
    }
    nonisolated static func prepared(_ id: String, needsConfirm: Bool, mode: SharingMode = .ask) -> Prepared {
        let items = ["item-1", "item-2"].map { PreviewItem(id: $0, kind: "user", label: "You", text: "SYNTHETIC FIXTURE \($0)", redactions: 0) }
        return Prepared(prepareId: id, sessionId: "s1", mode: mode,
                        preview: mode == .off ? nil : ContextPreview(items: items, notes: [], omitted: 0, bytes: 200),
                        needsConfirm: needsConfirm, repo: RepoLine(state: "bound", root: "/r", branch: "main", detail: nil), repoNote: nil,
                        sessionTitle: mode == .off ? nil : "SYNTHETIC FIXTURE one")
    }

    func hello() async throws -> HelloResult { calls.append("daemon.hello"); return HelloResult(protocolVersion: 1, daemonVersion: "0.4.0") }
    func shutdown() async throws { calls.append("daemon.shutdown") }
    func hostStatus() async throws -> HostState { calls.append("host.status"); return host }
    func hostRestart() async throws -> HostState { calls.append("host.restart"); return host }
    func hostAcknowledgeSecurityStop() async throws -> HostState {
        calls.append("host.acknowledgeSecurityStop")
        host = .ready(warnings: [])
        return host
    }
    var authError: DaemonError?
    func authStatus() async throws -> AuthState {
        calls.append("auth.status")
        if let e = authError { throw e }
        return auth
    }
    func authLogin() async throws -> URL { calls.append("auth.login"); return URL(string: "https://auth.example.invalid/start")! }
    func sessionsSnapshot() async throws -> SessionsSnapshot { calls.append("sessions.snapshot"); return snapshot }
    func sessionsRefresh() async throws -> SessionsSnapshot { calls.append("sessions.refresh"); return snapshot }
    func sessionsPin(_ sessionId: String?) async throws -> Selection {
        calls.append("sessions.pin:\(sessionId ?? "null")")
        snapshot = Self.snap(selected: sessionId ?? "s1", via: sessionId == nil ? "focus" : "pin")
        return snapshot.selection
    }
    func sessionsPicker(query: String?, includeArchived: Bool) async throws -> PickerGroups {
        PickerGroups(busy: [], idle: snapshot.sessions, recent: [], older: [])
    }
    func sessionsSync(_ sessionId: String) async throws -> SyncStatus {
        SyncStatus(state: "live", stats: SyncStats(records: 3, malformedLines: 1, unknownRecords: 0, droppedEvents: 0), lastPollAt: 1)
    }
    func sessionsWorktree(_ sessionId: String) async throws -> WorktreeResolution? { calls.append("sessions.worktree"); return worktree }
    func privacyGet() async throws -> PrivacyState { calls.append("privacy.get"); return privacy }
    func privacySetSharingMode(_ mode: SharingMode) async throws -> SharingMode {
        calls.append("privacy.setSharingMode:\(mode.rawValue)")
        privacy = PrivacyState(sharingMode: mode, approvals: privacy.approvals, redactionNotice: privacy.redactionNotice)
        return mode
    }
    func privacyApprove(root: String, includeWorktrees: Bool) async throws -> ApprovedRoot {
        calls.append("privacy.approve:\(root):\(includeWorktrees)")
        if let e = approveError { throw e }
        return ApprovedRoot(root: root, commonDir: root + "/.git", includeWorktrees: includeWorktrees, approvedAt: 1)
    }
    var revokePending = 0
    func privacyRevoke(root: String) async throws -> RevokeResult {
        calls.append("privacy.revoke:\(root)")
        return RevokeResult(revoked: true, pendingClose: revokePending)
    }
    func chatPrepare(sessionId: String, question: String) async throws -> Prepared {
        calls.append("chat.prepare:\(question)")
        let p = prepareResults.isEmpty ? Self.prepared("p-auto", needsConfirm: false, mode: .automatic) : try prepareResults.removeFirst().get()
        if p.needsConfirm { needsConfirm.insert(p.prepareId) }
        return p
    }
    func chatSend(prepareId: String, removeItemIds: [String], confirmed: Bool) async throws -> SendResult {
        calls.append("chat.send:\(prepareId)")
        sendParams.append((prepareId, removeItemIds, confirmed))
        if needsConfirm.contains(prepareId) && !confirmed {
            throw DaemonError(code: DaemonErrorCode.confirmRequired, message: "Confirm what will be shared before sending.")
        }
        await duringSend?()
        if sendResults.isEmpty { return SendResult(threadId: "t1", turnId: "u\(sendParams.count)") }
        return try sendResults.removeFirst().get()
    }
    func chatInterrupt(sessionId: String) async throws { calls.append("chat.interrupt:\(sessionId)") }
    func chatSent(sessionId: String) async throws -> [SentRecord] { sent }
    func settingsGet(_ key: String) async throws -> String? {
        guard key.wholeMatch(of: Self.storeKey) != nil else { throw DaemonError(code: DaemonErrorCode.invalidParams, message: "UI setting keys look like ui.<name>.") }
        return stored[key]
    }
    func settingsSet(_ key: String, _ value: String) async throws {
        guard key.wholeMatch(of: Self.storeKey) != nil else { throw DaemonError(code: DaemonErrorCode.invalidParams, message: "UI setting keys look like ui.<name>.") }
        calls.append("settings.set:\(key)")
        stored[key] = value
    }
}
```

`app/Tests/CompanionCoreTests/AppModelTests.swift`:

```swift
import Foundation
import Testing
@testable import CompanionCore

@MainActor @Suite struct AppModelTests {
    func started(_ d: FakeDaemon = FakeDaemon()) async -> (AppModel, FakeDaemon) {
        let m = AppModel(connector: { d.connection })
        await m.start()
        await m.detailLoad?.value
        return (m, d)
    }

    @Test func startLoadsEverything() async {
        let (m, d) = await started()
        #expect(m.connection == .connected(daemonVersion: "0.4.0"))
        #expect(m.gate == .ready)
        #expect(Array(d.calls.prefix(3)) == ["daemon.hello", "host.status", "privacy.get"])
        #expect(d.calls.contains("auth.status"))
        #expect(m.repoSummary == "r · main")
        #expect(m.selectionLabel == "Claude focus (from Claude's records)")
        #expect(m.syncSummary == "Live · 1 unreadable line skipped")
        #expect(m.redactionNotice == RedactionNotice.text)
    }

    @Test func gates() async {
        let m0 = AppModel(connector: { throw DaemonLaunchError.nodeNotFound })
        await m0.start()
        #expect(m0.gate == .daemonStopped(DaemonLaunchError.nodeNotFound.errorDescription!))

        let d1 = FakeDaemon()
        d1.host = .failed(detail: "Codex is not installed.")
        #expect(await started(d1).0.gate == .hostFailed("Codex is not installed."))

        let d2 = FakeDaemon()
        d2.auth = .signedOut
        #expect(await started(d2).0.gate == .signedOut)

        let d3 = FakeDaemon()
        d3.snapshot = FakeDaemon.snap(selected: nil)
        #expect(await started(d3).0.gate == .noSession)
    }

    @Test func askShowsThePreviewAndSendsOnlyAfterConfirm() async {
        let d = FakeDaemon()
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: true))]
        let (m, _) = await started(d)
        m.draft = "  What broke?  "
        await m.submitDraft()
        #expect(m.draft == "")
        #expect(m.preview?.prepared.prepareId == "p1")
        #expect(!d.calls.contains { $0.hasPrefix("chat.send") })
        m.toggle(itemId: "item-2")
        #expect(m.preview?.summaryLine.hasPrefix("1 of 2 items") == true)
        await m.confirmPreview()
        #expect(m.preview == nil)
        #expect(d.sendParams.map(\.prepareId) == ["p1"])
        #expect(d.sendParams.first?.removed == ["item-2"])
        #expect(d.sendParams.first?.confirmed == true)
        #expect(m.currentMessages.map(\.text) == ["What broke?", ""])
        #expect(m.currentMessages.last?.turnId == "u1")
        #expect(m.isAnswering)
    }

    @Test func cancellingThePreviewSendsNothingAndRestoresTheDraft() async {
        let d = FakeDaemon()
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: true))]
        let (m, _) = await started(d)
        m.draft = "Why?"
        await m.submitDraft()
        m.cancelPreview()
        #expect(m.preview == nil)
        #expect(m.draft == "Why?")
        #expect(!d.calls.contains { $0.hasPrefix("chat.send") })
        #expect(m.currentMessages.isEmpty)
    }

    @Test func offAndAutomaticSendAtOnce() async {
        let d = FakeDaemon()
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: false, mode: .off))]
        let (m, _) = await started(d)
        #expect(await m.ask("q"))
        #expect(m.preview == nil)
        #expect(d.sendParams.map(\.prepareId) == ["p1"])
        #expect(d.sendParams.first?.confirmed == false)
    }

    @Test func anAskPrepareAlwaysShowsTheSheet() async {
        let d = FakeDaemon()
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: false, mode: .ask))]
        let (m, _) = await started(d)
        await m.ask("q")
        #expect(m.preview?.prepared.prepareId == "p1")
        #expect(d.sendParams.isEmpty)
    }

    @Test func aRefusedUnconfirmedSendIsPreviewedAgain() async {
        let d = FakeDaemon()
        // Automatic prepare, then the mode became Ask: the daemon refuses the unconfirmed send (1011).
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: false, mode: .automatic)),
                            .success(FakeDaemon.prepared("p2", needsConfirm: true))]
        d.sendResults = [.failure(DaemonError(code: DaemonErrorCode.confirmRequired, message: "Confirm what will be shared before sending."))]
        let (m, _) = await started(d)
        await m.ask("q")
        #expect(m.preview?.prepared.prepareId == "p2")
        #expect(m.currentMessages.isEmpty)
        await m.confirmPreview()
        #expect(d.sendParams.map(\.confirmed) == [false, true])
    }

    @Test func tooLongQuestionsAreRefusedLocally() async {
        let (m, d) = await started()
        #expect(await m.ask(String(repeating: "x", count: 20_001)) == false)
        #expect(m.errorMessage != nil)
        #expect(!d.calls.contains { $0.hasPrefix("chat.prepare") })
    }

    @Test func anExpiredPrepareIsPreparedAgain() async {
        let d = FakeDaemon()
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: true)), .success(FakeDaemon.prepared("p2", needsConfirm: true))]
        d.sendResults = [.failure(DaemonError(code: DaemonErrorCode.prepareExpired, message: "expired"))]
        let (m, _) = await started(d)
        await m.ask("q")
        await m.confirmPreview()
        #expect(m.preview?.prepared.prepareId == "p2")
        #expect(m.preview?.notice != nil)
        #expect(m.currentMessages.isEmpty)
    }

    @Test func eventsBeforeTheSendAnswerLandInTheReplyAndAutoPlay() async {
        let (m, d) = await started()
        m.setSetting(\.autoPlay, true)
        var played: [String] = []
        m.onReplyCompleted = { _, text in played.append(text) }
        d.duringSend = {
            m.handle(.chatDelta(ChatDelta(sessionId: "s1", threadId: "t1", turnId: "u1", itemId: "i1", text: "See src/a.ts:3")))
            m.handle(.turnCompleted(TurnCompleted(sessionId: "s1", threadId: "t1", turnId: "u1", status: "completed", error: nil)))
        }
        await m.ask("q")
        #expect(m.currentMessages.last?.text == "See src/a.ts:3")
        #expect(m.currentMessages.last?.status == .done)
        #expect(played == ["See src/a.ts:3"])
    }

    @Test func busyOffersSendAgainWithTheSamePrepare() async {
        let d = FakeDaemon()
        d.sendResults = [.failure(DaemonError(code: DaemonErrorCode.hostBusy, message: "Too many … busy"))]
        let (m, _) = await started(d)
        await m.ask("one")
        let failed = m.currentMessages.last!
        #expect(failed.status == .failed("Too many repositories are busy right now. Try again in a moment."))
        #expect(failed.retry?.prepareId == "p-auto")
        await m.sendAgain(failed)
        #expect(d.sendParams.map(\.prepareId) == ["p-auto", "p-auto"])
        #expect(m.currentMessages.map(\.text) == ["one", ""])
        #expect(m.isAnswering)
    }

    @Test func abandonedRepliesEndOnTheDaemonsWord() async {
        let (m, _) = await started()
        await m.ask("two")
        m.handle(.hostChanged(.starting))
        #expect(m.isAnswering) // no guessing from host state
        m.handle(.turnCompleted(TurnCompleted(sessionId: "s1", threadId: "t1", turnId: "u1", status: "abandoned",
                                              error: "Codex restarted before this reply finished. Ask again.")))
        #expect(m.currentMessages.last?.status == .failed("Codex restarted before this reply finished. Ask again."))
        #expect(m.gate == .hostStarting)
    }

    @Test func eventsWithoutASessionIdWaitForTheSendAnswer() async {
        let (m, d) = await started()
        d.duringSend = {
            m.handle(.chatDelta(ChatDelta(sessionId: nil, threadId: "t1", turnId: "u1", itemId: "i1", text: "early")))
        }
        await m.ask("q")
        #expect(m.currentMessages.last?.text == "early")
    }

    @Test func securityStopNeedsAcknowledgeAndRestartsAreRefused() async {
        let d = FakeDaemon()
        d.host = .failed(detail: "Security check failed: Codex started a commandExecution item")
        let (m, _) = await started(d)
        #expect(m.gate == .securityStop("Security check failed: Codex started a commandExecution item"))
        await m.restartHost()
        await m.restartDaemon()
        #expect(!d.calls.contains("host.restart"))
        #expect(!d.calls.contains("daemon.shutdown"))
        await m.acknowledgeSecurityStop()
        #expect(d.calls.contains("host.acknowledgeSecurityStop"))
        #expect(m.gate == .ready)
    }

    @Test func aDisconnectedDaemonCanBeRestartedEvenAfterASecurityStop() async {
        let d = FakeDaemon()
        d.host = .failed(detail: "Security check failed: x")
        let (m, _) = await started(d)
        m.handle(.disconnected)
        #expect(m.gate == .daemonStopped("companiond stopped."))
        await m.restartDaemon()
        #expect(d.calls.filter { $0 == "daemon.hello" }.count == 2) // connected again
    }

    @Test func authErrorHasAWayOut() async {
        let d = FakeDaemon()
        d.authError = DaemonError(code: DaemonErrorCode.hostNotReady, message: "Codex is not ready.")
        let (m, _) = await started(d)
        #expect(m.gate == .authError("Codex is not ready."))
        d.authError = nil
        await m.loadAuth()
        #expect(m.gate == .ready)
    }

    @Test func revokeShowsRepliesStillFinishing() async {
        let (m, d) = await started()
        await m.revoke(root: "/r")
        #expect(d.calls.contains("privacy.revoke:/r"))
        #expect(m.revokeNotice == nil) // nothing pending
        d.revokePending = 2
        await m.revoke(root: "/r")
        #expect(m.revokeNotice?.hasPrefix("2 replies are still finishing") == true)
        m.dismissRevokeNotice()
        #expect(m.revokeNotice == nil)
        #expect(AppModel.revokeText(RevokeResult(revoked: false, pendingClose: 3)) == nil)
    }

    @Test func threadNoticesAndExplainInOff() async {
        let (m, _) = await started()
        m.handle(.threadReplaced(ThreadReplaced(sessionId: "s1", threadId: "t9", reason: "resume_refused")))
        #expect(m.currentThreadNotice == AppModel.threadReplacedNotice)
        m.dismissThreadNotice()
        #expect(m.currentThreadNotice == nil)
        await m.setSharingMode(.off)
        #expect(!m.canExplain)
    }

    @Test func approvals() async {
        let d = FakeDaemon()
        d.worktree = .unavailable(reason: "not_approved", detail: "This repository is not approved.", root: "/r", candidate: "/r")
        let (m, _) = await started(d)
        #expect(m.unavailableRepo == AppModel.UnavailableRepo(detail: "This repository is not approved.", approvableRoot: "/r"))
        d.approveError = DaemonError(code: DaemonErrorCode.approvalRefused, message: "refused", data: .object(["reason": .string("home_or_root")]))
        #expect(await m.approve(root: "/r", includeWorktrees: true) == "Your home folder, a folder that contains it, or the disk root cannot be approved.")
        d.approveError = nil
        d.worktree = .resolved(root: "/r", branch: "main", isLinkedWorktree: true)
        #expect(await m.approve(root: "/r", includeWorktrees: true) == nil)
        #expect(d.calls.contains("privacy.approve:/r:true"))
        #expect(m.unavailableRepo == nil)

        d.worktree = .unavailable(reason: "repo_refused", detail: "Refused: core.pager is set.", root: "/r", candidate: "/r")
        await m.refresh()
        #expect(m.unavailableRepo?.approvableRoot == nil) // only not_approved offers approval
    }

    @Test func alertsBannersAndDisconnect() async {
        let (m, _) = await started()
        let a = SecurityAlert(sessionId: "s1", threadId: "t1", turnId: "u1", kind: "guard", detail: "Codex started a commandExecution item")
        m.handle(.securityAlert(a))
        m.handle(.securityAlert(a))
        #expect(m.alerts.count == 1)
        #expect(a.bannerText == "Security check stopped the reply: Codex started a commandExecution item")
        m.handle(.sessionWorktree(WorktreeEvent(sessionId: "s1", resolution: .resolved(root: "/r2", branch: "b", isLinkedWorktree: true),
                                                change: RepoChange(from: "/r", to: "/r2", banner: "Claude is now in /r2 (b)", contextNote: "Repository changed from /r to /r2"))))
        #expect(m.currentRepoBanner == "Claude is now in /r2 (b)")
        #expect(m.repoSummary == "r2 · b")
        m.dismissRepoBanner()
        #expect(m.currentRepoBanner == nil)
        m.handle(.disconnected)
        #expect(m.gate == .daemonStopped("companiond stopped."))
    }

    @Test func viewSentFindsTheRecordOrSaysNotKept() async {
        let (m, d) = await started()
        await m.ask("q")
        let reply = m.currentMessages.last!
        await m.viewSent(reply)
        #expect(m.sentView == .notKept(turnId: "u1"))
        d.sent = [SentRecord(sessionId: "s1", threadId: "t1", turnId: "u1", contextBlock: "<untrusted_data source=\"claude-session\">SYNTHETIC FIXTURE</untrusted_data>", question: "q", sentAt: 1)]
        await m.viewSent(reply)
        if case .found(let r)? = m.sentView { #expect(r.question == "q") } else { Issue.record("record not found") }
    }

    @Test func pinFocusChipAndSettings() async {
        let d = FakeDaemon()
        d.snapshot = FakeDaemon.snap(selected: "s1", via: "pin", focusMovedTo: "s2")
        let (m, _) = await started(d)
        #expect(m.selectionLabel == "Pinned")
        #expect(m.focusMovedTitle == "SYNTHETIC FIXTURE two")
        await m.followFocus()
        #expect(d.calls.contains("sessions.pin:null"))
        await m.pin("s2")
        #expect(m.selectedSessionId == "s2")
        m.setSetting(\.speechRate, 1.5)
        await m.settingsWrite?.value
        #expect(d.stored["ui.speech.rate"] == "1.5")
        await m.setSharingMode(.off)
        #expect(m.privacy?.sharingMode == .off)
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app && swift test --filter AppModelTests`
Expected: build FAIL — `cannot find 'AppModel' in scope`.

- [ ] **Step 3: Implement** — `app/Sources/CompanionCore/Model/AppModel.swift`:

```swift
import Foundation
import Observation

public enum ConnectionState: Equatable, Sendable { case connecting, connected(daemonVersion: String), stopped(String) }

public enum Gate: Equatable, Sendable {
    case ready, connecting, daemonStopped(String), hostStarting, hostFailed(String), securityStop(String)
    case signedOut, authUnsupported(String), authError(String), noSession
}

public struct PendingPreview: Identifiable, Equatable, Sendable {
    public let question: String
    public let prepared: Prepared
    public var removed: Set<String>
    public var notice: String?
    public var id: String { prepared.prepareId }
}

public enum SentView: Identifiable, Equatable, Sendable {
    case found(SentRecord), notKept(turnId: String)
    public var id: String {
        switch self {
        case .found(let r): r.turnId
        case .notKept(let t): t
        }
    }
}

/// App state and every action that reaches companiond. Sends only a prepareId from chat.prepare in the same flow.
@MainActor @Observable
public final class AppModel {
    public static let explainQuestion = "Explain Claude's last message simply."
    static let threadReplacedNotice = "GPT lost the earlier part of this conversation (Codex could not reopen it). It continues in a new thread."

    public private(set) var connection: ConnectionState = .connecting
    public private(set) var host: HostState = .starting
    public private(set) var auth: AuthState?
    public private(set) var authError: String?
    public private(set) var threadNotices: [String: String] = [:]
    /// Set after a revoke whose threads are still finishing (pendingClose > 0).
    public private(set) var revokeNotice: String?
    public private(set) var snapshot: SessionsSnapshot?
    public private(set) var privacy: PrivacyState?
    public private(set) var worktrees: [String: WorktreeResolution] = [:]
    public private(set) var syncs: [String: SyncStatus] = [:]
    public private(set) var repoBanners: [String: String] = [:]
    public private(set) var alerts: [SecurityAlert] = []
    public private(set) var syncError: String?
    public private(set) var conversations: [String: Conversation] = [:]
    public private(set) var settings = UISettings()
    public var draft = ""
    public var preview: PendingPreview?
    public var sentView: SentView?
    public var errorMessage: String?

    @ObservationIgnored public var onSettingsChanged: ((UISettings) -> Void)?
    @ObservationIgnored public var onReplyCompleted: ((UUID, String) -> Void)?
    @ObservationIgnored public private(set) var detailLoad: Task<Void, Never>?
    @ObservationIgnored public private(set) var settingsWrite: Task<Void, Never>?
    @ObservationIgnored private let connector: Connector
    @ObservationIgnored private var current: Connection?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var autoPlayed: Set<UUID> = []
    /// Events with no session id for a turn no conversation owns yet (chat.send has not answered). Replayed on attach.
    @ObservationIgnored private var unrouted: [String: [TurnEvent]] = [:]

    public init(connector: @escaping Connector) {
        self.connector = connector
    }

    private var api: (any DaemonAPI)? { current?.api }

    // MARK: Lifecycle

    public func start() async {
        connection = .connecting
        generation += 1
        let gen = generation
        do {
            let c = try await connector()
            current = c
            eventTask = Task { [weak self] in
                for await e in c.events {
                    guard let self, self.generation == gen else { return }
                    self.handle(e)
                }
            }
            let hello = try await c.api.hello()
            connection = .connected(daemonVersion: hello.daemonVersion)
            host = try await c.api.hostStatus()
            privacy = try await c.api.privacyGet()
            settings = await UISettings.load { try await c.api.settingsGet($0) }
            onSettingsChanged?(settings)
            apply(snapshot: try await c.api.sessionsSnapshot())
            if host.isReady { await loadAuth() }
        } catch {
            connection = .stopped(Self.describe(error))
        }
    }

    /// daemon.shutdown, then close stdin. A daemon that does not answer within 3 s is closed anyway.
    public func shutdown() async {
        guard let c = current else { return }
        current = nil
        generation += 1
        eventTask?.cancel()
        let closer = Task {
            guard (try? await Task.sleep(for: .seconds(3))) != nil else { return } // cancelled: the answer came in time
            await c.close()
        }
        try? await c.api.shutdown()
        closer.cancel()
        await c.close()
    }

    /// A security stop must be acknowledged, never skipped by a restart (ruling 18).
    public var isSecurityStop: Bool {
        if case .failed(let d) = host { d.hasPrefix(DaemonErrorCode.securityStopPrefix) } else { false }
    }

    public func restartDaemon() async {
        // A live daemon in a security stop must be acknowledged; a daemon that is already gone may be restarted
        // (its stop latch went with it, and the user would otherwise be locked out).
        if isSecurityStop, case .connected = connection { return }
        await shutdown()
        stopAllRunning("companiond restarted. Ask again.")
        host = .starting
        auth = nil
        authError = nil
        worktrees = [:]
        syncs = [:]
        await start()
    }

    public func restartHost() async {
        guard let api, !isSecurityStop else { return }
        do { host = try await api.hostRestart() } catch { errorMessage = Self.describe(error) }
    }

    /// Only the Acknowledge button calls this (M4b: host.acknowledgeSecurityStop clears the latch, then starts Codex).
    public func acknowledgeSecurityStop() async {
        guard let api, isSecurityStop else { return }
        do { host = try await api.hostAcknowledgeSecurityStop() } catch { errorMessage = Self.describe(error) }
        if host.isReady { await loadAuth() }
    }

    public func loadAuth() async {
        guard let api else { return }
        do {
            auth = try await api.authStatus()
            authError = nil
        } catch {
            authError = Self.describe(error)
        }
    }

    // MARK: Sessions

    public var selectedSessionId: String? { snapshot?.selection.sessionId }
    public var selectedSession: SessionSummary? { snapshot?.sessions.first { $0.sessionId == selectedSessionId } }

    private func apply(snapshot new: SessionsSnapshot) {
        let old = snapshot?.selection.sessionId
        snapshot = new
        guard let id = new.selection.sessionId, id != old || worktrees[id] == nil else { return }
        detailLoad = Task { await self.loadDetail(id) }
    }

    private func loadDetail(_ id: String) async {
        guard let api else { return }
        do { worktrees[id] = try await api.sessionsWorktree(id) } catch {} // null clears a stale resolution
        if let s = try? await api.sessionsSync(id) { syncs[id] = s }
    }

    public func refresh() async {
        guard let api else { return }
        do {
            apply(snapshot: try await api.sessionsRefresh())
            if let id = selectedSessionId { await loadDetail(id) }
        } catch { errorMessage = Self.describe(error) }
    }

    public func pin(_ sessionId: String?) async {
        guard let api else { return }
        do {
            _ = try await api.sessionsPin(sessionId)
            apply(snapshot: try await api.sessionsSnapshot())
            await detailLoad?.value
        } catch { errorMessage = Self.describe(error) }
    }

    public func followFocus() async { await pin(nil) }

    public func picker(query: String) async -> PickerGroups? {
        try? await api?.sessionsPicker(query: query, includeArchived: false)
    }

    // MARK: Asking

    public func appendToDraft(_ text: String) {
        draft = draft.isEmpty ? text : draft + " " + text
    }

    public func submitDraft() async {
        guard canSend else { return }
        let q = draft
        draft = ""
        let prepared = await ask(q)
        if !prepared, draft.isEmpty { draft = q }
    }

    /// chat.prepare; Ask → preview sheet; Off/Automatic → send at once. False when nothing was prepared.
    @discardableResult
    public func ask(_ raw: String) async -> Bool {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, let api, let sid = selectedSessionId, gate == .ready else { return false }
        guard q.utf16.count <= DaemonLimits.questionUTF16 else {
            errorMessage = "The question is too long. Keep it under 20,000 characters."
            return false
        }
        do {
            let p = try await api.chatPrepare(sessionId: sid, question: q)
            // Second guard: an Ask-mode prepare always goes through the sheet, whatever needsConfirm says.
            if p.needsConfirm || p.mode == .ask {
                preview = PendingPreview(question: q, prepared: p, removed: [], notice: nil)
            } else {
                await send(sessionId: p.sessionId, PendingSend(prepareId: p.prepareId, removeItemIds: [], confirmed: false), question: q)
            }
            return true
        } catch {
            errorMessage = Self.describe(error)
            return false
        }
    }

    public var canExplain: Bool { gate == .ready && !isAnswering && privacy?.sharingMode != .off }

    public func explainLastMessage() async {
        guard canExplain else { return }
        await ask(Self.explainQuestion)
    }

    public func toggle(itemId: String) {
        guard var p = preview else { return }
        if p.removed.contains(itemId) { p.removed.remove(itemId) } else { p.removed.insert(itemId) }
        preview = p
    }

    public func cancelPreview() {
        if let p = preview, draft.isEmpty, p.question != Self.explainQuestion { draft = p.question }
        preview = nil
    }

    /// The only place `confirmed: true` is sent: the user pressed Send in the preview sheet.
    public func confirmPreview() async {
        guard let p = preview else { return }
        preview = nil
        await send(sessionId: p.prepared.sessionId,
                   PendingSend(prepareId: p.prepared.prepareId, removeItemIds: p.removed.sorted(), confirmed: true),
                   question: p.question)
    }

    /// "Send again" after hostBusy, turnBusy or hostNotReady: the same prepareId (M4b retry rule).
    public func sendAgain(_ message: ChatMessage) async {
        guard let retry = message.retry,
              let sid = conversations.first(where: { $0.value.messages.contains { $0.id == message.id } })?.key,
              let question = conversations[sid]?.question(before: message.id) else { return }
        conversations[sid]?.discard(message.id)
        await send(sessionId: sid, retry, question: question)
    }

    private func send(sessionId sid: String, _ s: PendingSend, question: String, attempt: Int = 0) async {
        guard let api else { return }
        var conv = conversations[sid] ?? Conversation()
        let mid = conv.begin(question: question)
        conversations[sid] = conv
        do {
            let r = try await api.chatSend(prepareId: s.prepareId, removeItemIds: s.removeItemIds, confirmed: s.confirmed)
            conversations[sid]?.attach(mid, threadId: r.threadId, turnId: r.turnId)
            // Known limit (low likelihood: M4b stores the thread before startTurn, so events carry a sessionId): if one
            // turn's early events arrive split between this buffer and the Conversation's, their order is not merged.
            for e in unrouted.removeValue(forKey: r.turnId) ?? [] { conversations[sid]?.apply(e) }
            maybeAutoPlay(sid, turnId: r.turnId)
        } catch let e as DaemonError where DaemonErrorCode.prepareAgain.contains(e.code) {
            // Expired, stale (mode or approval changed) or a confirmation is now required: prepare again.
            conversations[sid]?.discard(mid)
            do {
                let fresh = try await api.chatPrepare(sessionId: sid, question: question)
                if fresh.needsConfirm || fresh.mode == .ask {
                    preview = PendingPreview(question: question, prepared: fresh, removed: [],
                                             notice: "What will be sent has changed or expired. Check it again.")
                } else if attempt == 0 {
                    // Off / Automatic need no preview: send the fresh prepare once, unconfirmed.
                    await send(sessionId: sid, PendingSend(prepareId: fresh.prepareId, removeItemIds: [], confirmed: false),
                               question: question, attempt: 1)
                } else {
                    errorMessage = "The request expired twice. Ask again."
                    if draft.isEmpty { draft = question }
                }
            } catch {
                errorMessage = Self.describe(error)
                if draft.isEmpty { draft = question }
            }
        } catch let e as DaemonError where DaemonErrorCode.retryable.contains(e.code) {
            conversations[sid]?.fail(mid, message: Self.describe(e), retry: s)
        } catch {
            conversations[sid]?.fail(mid, message: Self.describe(error))
        }
    }

    public func interrupt() async {
        guard let api, let sid = selectedSessionId else { return }
        do { try await api.chatInterrupt(sessionId: sid) } catch { errorMessage = Self.describe(error) }
    }

    public func viewSent(_ message: ChatMessage) async {
        guard let api, let turn = message.turnId,
              let sid = conversations.first(where: { $0.value.owns(turnId: turn) })?.key else { return }
        let records = (try? await api.chatSent(sessionId: sid)) ?? []
        sentView = records.first { $0.turnId == turn }.map { SentView.found($0) } ?? .notKept(turnId: turn)
    }

    private func maybeAutoPlay(_ sid: String, turnId: String) {
        guard settings.autoPlay, let m = conversations[sid]?.message(forTurn: turnId), m.status == .done,
              !m.text.isEmpty, !autoPlayed.contains(m.id) else { return }
        autoPlayed.insert(m.id)
        onReplyCompleted?(m.id, m.text)
    }

    private func stopAllRunning(_ reason: String) {
        for k in conversations.keys { conversations[k]?.stopRunning(reason: reason) }
    }

    // MARK: Privacy, account, settings

    public func approve(root: String, includeWorktrees: Bool) async -> String? {
        guard let api else { return "companiond is not running." }
        do {
            _ = try await api.privacyApprove(root: root, includeWorktrees: includeWorktrees)
            privacy = try await api.privacyGet()
            if let id = selectedSessionId { await loadDetail(id) }
            return nil
        } catch let e as DaemonError where e.code == DaemonErrorCode.approvalRefused {
            return Self.approvalText(reason: e.reason, fallback: e.message)
        } catch {
            return Self.describe(error)
        }
    }

    /// Spec v3.4 §8: "Revoke shows pendingClose threads still finishing; after 30 s the daemon may restart Codex."
    public func revoke(root: String) async {
        guard let api else { return }
        do {
            let r = try await api.privacyRevoke(root: root)
            revokeNotice = Self.revokeText(r)
            privacy = try await api.privacyGet()
            if let id = selectedSessionId { await loadDetail(id) }
        } catch { errorMessage = Self.describe(error) }
    }

    static func revokeText(_ r: RevokeResult) -> String? {
        guard r.revoked, r.pendingClose > 0 else { return nil }
        let n = r.pendingClose
        return "\(n) reply\(n == 1 ? " is" : "s are") still finishing in that repository. GPT cannot read it any more; if \(n == 1 ? "it does" : "they do") not finish within 30 seconds, Codex restarts and every conversation reopens at its next message."
    }

    public func dismissRevokeNotice() { revokeNotice = nil }

    public func setSharingMode(_ mode: SharingMode) async {
        guard let api else { return }
        do {
            _ = try await api.privacySetSharingMode(mode)
            privacy = try await api.privacyGet()
        } catch { errorMessage = Self.describe(error) }
    }

    public func signIn() async -> URL? {
        do { return try await api?.authLogin() } catch { errorMessage = Self.describe(error); return nil }
    }

    public func setSetting<V>(_ keyPath: WritableKeyPath<UISettings, V>, _ value: V) {
        let old = settings
        settings[keyPath: keyPath] = value
        let changes = settings.changes(from: old)
        guard !changes.isEmpty else { return }
        onSettingsChanged?(settings)
        guard let api else { return }
        settingsWrite = Task { for c in changes { try? await api.settingsSet(c.key, c.value) } }
    }

    public func dismiss(alert: SecurityAlert) { alerts.removeAll { $0 == alert } }
    public func dismissRepoBanner() { if let id = selectedSessionId { repoBanners[id] = nil } }
    public func dismissSyncError() { syncError = nil }
    public func dismissThreadNotice() { if let id = selectedSessionId { threadNotices[id] = nil } }

    // MARK: Events

    public func handle(_ e: DaemonEvent) {
        switch e {
        case .hostChanged(let h):
            // Replies are ended by the daemon ("abandoned"), not guessed from host state (ruling 15).
            let wasReady = host.isReady
            host = h
            if h.isReady && !wasReady { Task { await self.loadAuth() } }
        case .authChanged(let a):
            auth = a
            authError = nil
        case .threadReplaced(let t):
            threadNotices[t.sessionId] = Self.threadReplacedNotice
        case .sessionsChanged(let s):
            apply(snapshot: s)
        case .sessionTranscript(let t):
            syncs[t.sessionId] = SyncStatus(state: t.kind == "missing" ? "missing" : "live", stats: t.stats,
                                            lastPollAt: syncs[t.sessionId]?.lastPollAt)
        case .sessionWorktree(let w):
            worktrees[w.sessionId] = w.resolution
            if let c = w.change { repoBanners[w.sessionId] = c.banner }
        case .syncError(let m):
            syncError = m
        case .chatDelta(let d):
            route(d.sessionId, .delta(turnId: d.turnId, itemId: d.itemId, text: d.text))
        case .chatItem(let i):
            route(i.sessionId, .item(turnId: i.turnId, phase: i.phase, item: i.item))
        case .turnCompleted(let t):
            if let sid = route(t.sessionId, .completed(turnId: t.turnId, status: t.status, error: t.error)) {
                maybeAutoPlay(sid, turnId: t.turnId)
            }
            if let id = selectedSessionId { detailLoad = Task { await self.loadDetail(id) } } // live branch after a turn
        case .securityAlert(let a):
            guard !alerts.contains(a) else { return }
            alerts.append(a)
            if alerts.count > 20 { alerts.removeFirst() }
        case .disconnected:
            connection = .stopped("companiond stopped.")
            stopAllRunning("companiond stopped.")
        case .unknown:
            break
        }
    }

    @discardableResult
    private func route(_ sessionId: String?, _ e: TurnEvent) -> String? {
        guard let sid = sessionId ?? conversations.first(where: { $0.value.owns(turnId: e.turnId) })?.key else {
            // No session id and no owner yet: keep it for the chat.send answer (bounded like Conversation's buffer).
            if unrouted[e.turnId] == nil && unrouted.count >= Conversation.earlyTurnCap { unrouted.removeAll() }
            if (unrouted[e.turnId]?.count ?? 0) < Conversation.earlyEventCap { unrouted[e.turnId, default: []].append(e) }
            return nil
        }
        conversations[sid, default: Conversation()].apply(e)
        return sid
    }

    // MARK: Text

    static func approvalText(reason: String?, fallback: String) -> String {
        switch reason {
        case "not_absolute": "That is not a full folder path."
        case "missing": "That folder does not exist."
        case "home_or_root": "Your home folder, a folder that contains it, or the disk root cannot be approved."
        case "not_toplevel": "Approve the repository's top folder, not a folder inside it."
        default: fallback // repo_refused: the daemon's message carries the visible reason
        }
    }

    static func describe(_ error: any Error) -> String {
        if let e = error as? DaemonError {
            switch e.code {
            case DaemonErrorCode.turnBusy: return "GPT is still answering. Wait or press Stop."
            case DaemonErrorCode.hostBusy: return "Too many repositories are busy right now. Try again in a moment."
            case DaemonErrorCode.stopped: return "companiond stopped."
            default: return e.message
            }
        }
        if let e = error as? any LocalizedError, let d = e.errorDescription { return d }
        return "Something went wrong talking to companiond."
    }
}
```

`app/Sources/CompanionCore/Model/AppModel+Display.swift`:

```swift
import Foundation

extension AppModel {
    public var gate: Gate {
        switch connection {
        case .connecting: return .connecting
        case .stopped(let why): return .daemonStopped(why)
        case .connected: break
        }
        switch host {
        case .starting, .stopped: return .hostStarting
        case .failed(let d): return d.hasPrefix(DaemonErrorCode.securityStopPrefix) ? .securityStop(d) : .hostFailed(d)
        case .ready: break
        }
        switch auth {
        case nil: return authError.map { .authError($0) } ?? .hostStarting
        case .signedOut?: return .signedOut
        case .unsupported(let mode)?: return .authUnsupported(mode)
        case .signedIn?: break
        }
        return selectedSessionId == nil ? .noSession : .ready
    }

    public var currentMessages: [ChatMessage] { selectedSessionId.flatMap { conversations[$0]?.messages } ?? [] }
    public var isAnswering: Bool { selectedSessionId.flatMap { conversations[$0]?.isRunning } ?? false }
    public var canSend: Bool { gate == .ready && !isAnswering && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    public var currentWorktree: WorktreeResolution? { selectedSessionId.flatMap { worktrees[$0] } }
    public var currentRoot: String? {
        if case .resolved(let root, _, _)? = currentWorktree { root } else { nil }
    }

    public var repoSummary: String {
        switch currentWorktree {
        case .resolved(let root, let branch, _)?: "\(URL(fileURLWithPath: root).lastPathComponent) · \(branch ?? "detached HEAD")"
        case .unavailable?: "Repository unavailable"
        case nil: selectedSessionId == nil ? "No session" : "Repository not resolved yet"
        }
    }

    public var repoHelp: String {
        switch currentWorktree {
        case .resolved(let root, _, _)?: root
        case .unavailable(_, let detail, _, _)?: detail
        case nil: ""
        }
    }

    public var selectionLabel: String {
        guard let s = snapshot?.selection else { return "No session" }
        switch s.via {
        case "pin": return "Pinned"
        case "focus": return s.focusLabel
        default: return "No session"
        }
    }

    public var syncSummary: String {
        guard let id = selectedSessionId, let s = syncs[id] else { return "Sync: checking" }
        switch s.state {
        case "live":
            let n = s.stats?.malformedLines ?? 0
            return n > 0 ? "Live · \(n) unreadable line\(n == 1 ? "" : "s") skipped" : "Live"
        case "missing": return "Transcript not found"
        default: return "Not tracked"
        }
    }

    public var focusMovedTitle: String? {
        guard let s = snapshot, let id = s.selection.focusMovedTo else { return nil }
        return s.sessions.first { $0.sessionId == id }?.title ?? "another session"
    }

    public var currentRepoBanner: String? { selectedSessionId.flatMap { repoBanners[$0] } }
    public var currentThreadNotice: String? { selectedSessionId.flatMap { threadNotices[$0] } }

    public struct UnavailableRepo: Equatable, Sendable {
        public let detail: String
        /// Set only when approval would fix it (reason not_approved and git answered with a root).
        public let approvableRoot: String?
    }

    public var unavailableRepo: UnavailableRepo? {
        guard case .unavailable(let reason, let detail, let root, _)? = currentWorktree else { return nil }
        return UnavailableRepo(detail: detail, approvableRoot: reason == "not_approved" ? root : nil)
    }

    public var redactionNotice: String { privacy?.redactionNotice ?? RedactionNotice.text }
}

extension SecurityAlert {
    public var bannerText: String {
        switch kind {
        case "guard": "Security check stopped the reply: \(detail)"
        case "server_request": "Security check: \(detail)"
        default: detail
        }
    }
}

extension SessionSummary {
    public var locationLine: String {
        let place = (resolvedRoot ?? recordCwd).map { URL(fileURLWithPath: $0).lastPathComponent } ?? "no folder"
        return recordBranch.map { "\(place) · \($0)" } ?? place
    }
}

extension RepoLine {
    public var summary: String {
        switch state {
        case "bound": "Repository: \(root ?? "?") (\(branch ?? "detached HEAD")). GPT can read it with read-only tools."
        case "unavailable": "Repository tools are off: \(detail ?? "unavailable")."
        default: "No repository: GPT gets no repository tools."
        }
    }
}

extension PendingPreview {
    public var summaryLine: String {
        let items = prepared.preview?.items.count ?? 0
        let kb = Double(prepared.preview?.bytes ?? 0) / 1024
        var s = "\(items - removed.count) of \(items) items · \(String(format: "%.1f", kb)) KB before removals"
        if let o = prepared.preview?.omitted, o > 0 { s += " · \(o) older items left out by the size cap" }
        return s
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && swift test --filter AppModelTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore/Model app/Tests/CompanionCoreTests/FakeDaemon.swift app/Tests/CompanionCoreTests/AppModelTests.swift
git commit -m "feat(app): add the app model and the confirm-before-send flow" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Safe reply rendering and `path:line` links

GPT's reply is untrusted (it can quote transcript and repo text). Rendering removes every link and image, shows link targets as text (ruling 3), and links only `path:line` references that resolve inside the bound root.

**Files:**
- Create: `app/Sources/CompanionCore/Text/FileReferences.swift`, `app/Sources/CompanionCore/Text/ReplyMarkdown.swift`
- Test: `app/Tests/CompanionCoreTests/FileReferencesTests.swift`, `app/Tests/CompanionCoreTests/ReplyMarkdownTests.swift`

**Interfaces:**
- Consumes: Task 6 (`EditorChoice`).
- Produces: `struct FileReference: Equatable, Sendable { path (absolute, inside root); line }`; `enum FileReferences { struct Match { range: Range<String.Index>; reference }; static func find(in:root:) -> [Match]; static func contained(_:root:) -> String? }`; `enum EditorLink { static let scheme = "companion-open"; static func companionURL(_:) -> URL; static func parseCompanionURL(_:) -> FileReference?; static func url(for:editor:) -> URL? }`; `enum ReplyBlock: Equatable { paragraph, heading(level:text:), bullet, numbered(marker:text:), quote, code(language:text:) }`; `enum ReplyMarkdown { static func blocks(_:) -> [ReplyBlock]; static func inline(_:root:) -> AttributedString }`.

- [ ] **Step 1: Write the failing tests** — `app/Tests/CompanionCoreTests/FileReferencesTests.swift`:

```swift
import Foundation
import Testing
@testable import CompanionCore

@Suite struct FileReferencesTests {
    @Test func findsRelativeAndAbsoluteReferencesInsideTheRoot() {
        let text = "See src/app.ts:12 and /r/lib/x.swift:3:5, also ./README.md:1."
        let refs = FileReferences.find(in: text, root: "/r").map(\.reference)
        #expect(refs == [FileReference(path: "/r/src/app.ts", line: 12), FileReference(path: "/r/lib/x.swift", line: 3),
                         FileReference(path: "/r/README.md", line: 1)])
        let first = FileReferences.find(in: text, root: "/r")[0]
        #expect(text[first.range] == "src/app.ts:12")
    }

    @Test func refusesEverythingOutsideTheRoot() {
        #expect(FileReferences.find(in: "/etc/hosts.txt:1 ../up.ts:2 /r2/a.ts:3 a/../../b.ts:4", root: "/r").isEmpty)
        #expect(FileReferences.find(in: "src/app.ts:12", root: nil).isEmpty)
        #expect(FileReferences.find(in: "src/app.ts:0", root: "/r").isEmpty)
        #expect(FileReferences.find(in: "https://example.com:8080/x", root: "/r").isEmpty)
        #expect(FileReferences.contained("a/./b/../c.ts", root: "/r/") == "/r/a/c.ts")
        #expect(FileReferences.contained("x\u{0}.ts", root: "/r") == nil)
        #expect(FileReferences.contained("a.ts", root: "relative") == nil)
    }

    @Test func editorURLs() {
        let ref = FileReference(path: "/r/my dir/a.ts", line: 7)
        #expect(EditorLink.url(for: ref, editor: .vscode)?.absoluteString == "vscode://file/r/my%20dir/a.ts:7")
        #expect(EditorLink.url(for: ref, editor: .cursor)?.absoluteString == "cursor://file/r/my%20dir/a.ts:7")
        #expect(EditorLink.url(for: ref, editor: .system) == URL(fileURLWithPath: "/r/my dir/a.ts"))
        #expect(EditorLink.parseCompanionURL(EditorLink.companionURL(ref)) == ref)
        #expect(EditorLink.parseCompanionURL(URL(string: "https://example.com/?path=/r/a.ts&line=1")!) == nil)
        #expect(EditorLink.parseCompanionURL(URL(string: "companion-open://open?path=/r/a.ts&line=abc")!) == nil)
    }
}
```

`app/Tests/CompanionCoreTests/ReplyMarkdownTests.swift`:

```swift
import Foundation
import Testing
@testable import CompanionCore

@Suite struct ReplyMarkdownTests {
    @Test func splitsBlocks() {
        let md = "# Title\nFirst line\nsecond line\n\n- one\n2. two\n> quoted\n```swift\nlet x = 1\n```\nafter\n```\nunterminated"
        #expect(ReplyMarkdown.blocks(md) == [
            .heading(level: 1, text: "Title"), .paragraph("First line\nsecond line"), .bullet("one"),
            .numbered(marker: "2.", text: "two"), .quote("quoted"), .code(language: "swift", text: "let x = 1"),
            .paragraph("after"), .code(language: nil, text: "unterminated"),
        ])
    }

    @Test func removesLinksAndImagesAndShowsTheTarget() {
        let s = ReplyMarkdown.inline("Read [the docs](https://evil.example/x) ![pixel](https://evil.example/p.png) now", root: nil)
        #expect(String(s.characters) == "Read the docs (https://evil.example/x) pixel now")
        #expect(s.runs.allSatisfy { $0.link == nil && $0.imageURL == nil })
    }

    @Test func aStyledLinkShowsItsURLOnce() {
        let s = ReplyMarkdown.inline("[**a** b](https://evil.example/u) end", root: nil)
        #expect(String(s.characters) == "a b (https://evil.example/u) end")
    }

    @Test func autolinksAreTextToo() {
        let s = ReplyMarkdown.inline("<https://evil.example/a>", root: "/r")
        #expect(s.runs.allSatisfy { $0.link == nil })
    }

    @Test func linksOnlyFileReferencesInsideTheRoot() {
        let s = ReplyMarkdown.inline("Look at `src/a.ts:3` and /etc/passwd.txt:1", root: "/r")
        let links = s.runs.compactMap { run -> (String, URL)? in run.link.map { (String(s[run.range].characters), $0) } }
        #expect(links.count == 1)
        #expect(links.first?.0 == "src/a.ts:3")
        #expect(links.first.flatMap { EditorLink.parseCompanionURL($0.1) } == FileReference(path: "/r/src/a.ts", line: 3))
    }

    @Test func keepsEmphasisAndCodeText() {
        #expect(String(ReplyMarkdown.inline("**bold** and `code`", root: nil).characters) == "bold and code")
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app && swift test --filter "FileReferencesTests|ReplyMarkdownTests"`
Expected: build FAIL — `cannot find 'FileReferences' in scope`.

- [ ] **Step 3: Implement** — `app/Sources/CompanionCore/Text/FileReferences.swift`:

```swift
import Foundation

public struct FileReference: Equatable, Sendable {
    /// Absolute and lexically inside the bound root.
    public let path: String
    public let line: Int
    public init(path: String, line: Int) {
        self.path = path
        self.line = line
    }
}

/// `path:line` references in GPT replies (spec §4.6, §8). Only paths inside the bound root are kept.
public enum FileReferences {
    public struct Match: Equatable, Sendable {
        public let range: Range<String.Index>
        public let reference: FileReference
    }

    // A path with an extension, then :line (and an optional :column). Not preceded by a path or URL character.
    nonisolated(unsafe) static let regex = try! NSRegularExpression(
        pattern: #"(?<![\w/.~:-])((?:/|\./)?(?:[\w.@+-]+/)*[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,10}):([1-9][0-9]{0,6})(?::[0-9]+)?"#)

    public static func find(in text: String, root: String?) -> [Match] {
        guard let root else { return [] }
        let all = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: all).compactMap { m in
            guard let whole = Range(m.range, in: text), let p = Range(m.range(at: 1), in: text),
                  let l = Range(m.range(at: 2), in: text), let line = Int(text[l]),
                  let abs = contained(String(text[p]), root: root) else { return nil }
            return Match(range: whole, reference: FileReference(path: abs, line: line))
        }
    }

    /// Lexical containment: never touches the filesystem, never follows "..", refuses NUL.
    public static func contained(_ path: String, root: String) -> String? {
        guard !path.contains("\u{0}"), root.hasPrefix("/"), let base = normalize(root) else { return nil }
        let joined = path.hasPrefix("/") ? path : base + "/" + path
        guard let full = normalize(joined) else { return nil }
        return full == base || full.hasPrefix(base == "/" ? "/" : base + "/") ? full : nil
    }

    static func normalize(_ absolute: String) -> String? {
        var parts: [Substring] = []
        for c in absolute.split(separator: "/", omittingEmptySubsequences: true) {
            if c == "." { continue }
            if c == ".." {
                if parts.isEmpty { return nil }
                parts.removeLast()
                continue
            }
            parts.append(c)
        }
        return "/" + parts.joined(separator: "/")
    }
}

public enum EditorLink {
    public static let scheme = "companion-open"

    public static func companionURL(_ ref: FileReference) -> URL {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "open"
        c.queryItems = [URLQueryItem(name: "path", value: ref.path), URLQueryItem(name: "line", value: String(ref.line))]
        return c.url!
    }

    public static func parseCompanionURL(_ url: URL) -> FileReference? {
        guard url.scheme == scheme, let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let path = c.queryItems?.first(where: { $0.name == "path" })?.value, path.hasPrefix("/"),
              let line = c.queryItems?.first(where: { $0.name == "line" })?.value.flatMap({ Int($0) }), line > 0 else { return nil }
        return FileReference(path: path, line: line)
    }

    /// The URL to hand to NSWorkspace. Xcode is opened with `xed --line` by the app instead.
    public static func url(for ref: FileReference, editor: EditorChoice) -> URL? {
        switch editor {
        case .vscode, .cursor:
            var c = URLComponents()
            c.scheme = editor == .vscode ? "vscode" : "cursor"
            c.host = "file"
            c.path = "\(ref.path):\(ref.line)"
            return c.url
        case .auto, .xcode, .system:
            return URL(fileURLWithPath: ref.path)
        }
    }
}
```

`app/Sources/CompanionCore/Text/ReplyMarkdown.swift`:

```swift
import Foundation

public enum ReplyBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bullet(String)
    case numbered(marker: String, text: String)
    case quote(String)
    case code(language: String?, text: String)
}

/// The only place GPT reply text is parsed as Markdown (SourceRulesTests enforces it).
public enum ReplyMarkdown {
    public static func blocks(_ markdown: String) -> [ReplyBlock] {
        var out: [ReplyBlock] = []
        var para: [String] = []
        var fence: (lang: String?, lines: [String])?
        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))); para = [] }
        }
        for raw in markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            let isFence = line.hasPrefix("```") || line.hasPrefix("~~~")
            if var f = fence {
                if isFence {
                    out.append(.code(language: f.lang, text: f.lines.joined(separator: "\n")))
                    fence = nil
                } else {
                    f.lines.append(raw)
                    fence = f
                }
                continue
            }
            if isFence {
                flush()
                let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                fence = (lang.isEmpty ? nil : lang, [])
                continue
            }
            if line.isEmpty { flush(); continue }
            if let m = line.firstMatch(of: /^(#{1,6})\s+(.*)$/) { flush(); out.append(.heading(level: m.1.count, text: String(m.2))); continue }
            if let m = line.firstMatch(of: /^[-*+]\s+(.*)$/) { flush(); out.append(.bullet(String(m.1))); continue }
            if let m = line.firstMatch(of: /^(\d{1,3}[.)])\s+(.*)$/) { flush(); out.append(.numbered(marker: String(m.1), text: String(m.2))); continue }
            if let m = line.firstMatch(of: /^>\s?(.*)$/) { flush(); out.append(.quote(String(m.1))); continue }
            para.append(line)
        }
        flush()
        if let f = fence { out.append(.code(language: f.lang, text: f.lines.joined(separator: "\n"))) }
        return out
    }

    /// Inline Markdown (emphasis, code spans) with every link and image removed, then `path:line` links added.
    public static func inline(_ text: String, root: String?) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        let parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        var out = AttributedString()
        // A link may span several runs (e.g. [**a** b](u)); its URL is shown once, after the last of them.
        var open: (url: URL, text: String)?
        func closeLink() {
            if let o = open, o.url.absoluteString != o.text { out.append(AttributedString(" (\(o.url.absoluteString))")) }
            open = nil
        }
        for run in parsed.runs {
            var piece = AttributedString(parsed[run.range])
            let target = run.link
            if open != nil && open?.url != target { closeLink() }
            piece.link = nil
            piece.imageURL = nil
            out.append(piece)
            if let target { open = (target, (open?.text ?? "") + String(piece.characters)) }
        }
        closeLink()
        let plain = String(out.characters)
        for m in FileReferences.find(in: plain, root: root) {
            let lo = plain.distance(from: plain.startIndex, to: m.range.lowerBound)
            let len = plain.distance(from: m.range.lowerBound, to: m.range.upperBound)
            let start = out.characters.index(out.startIndex, offsetBy: lo)
            let end = out.characters.index(start, offsetBy: len)
            out[start..<end].link = EditorLink.companionURL(m.reference)
        }
        return out
    }
}
```

Note for `autolinksAreTextToo`: `<https://…>` parses to a link whose text equals the URL, so no " (url)" is appended; the run just loses its link.

- [ ] **Step 4: Run the tests**

Run: `cd app && swift test --filter "FileReferencesTests|ReplyMarkdownTests|SourceRulesTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore/Text app/Tests/CompanionCoreTests/FileReferencesTests.swift app/Tests/CompanionCoreTests/ReplyMarkdownTests.swift
git commit -m "feat(app): render replies without links or images; link path:line inside the root" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Read Aloud

**Files:**
- Create: `app/Sources/CompanionCore/Speech/ReadAloud.swift`
- Test: `app/Tests/CompanionCoreTests/ReadAloudTests.swift`

**Interfaces:**
- Consumes: `SpeechText.plainText(fromMarkdown:readCode:)` (M0).
- Produces: `@MainActor protocol SpeechSynthesizing: AnyObject { var onEnd: ((Int) -> Void)? { get set }; func speak(_:rate:voiceIdentifier:token:); func pause(); func resume(); func stop(atWordBoundary:) }`; `enum Playback: Equatable { idle, playing(UUID), paused(UUID) }`; `@MainActor @Observable final class ReadAloudController { playback; rateMultiplier; voiceIdentifier; readCode; init(synth:); static func avRate(multiplier:) -> Float; play(id:markdown:); toggle(id:markdown:); stop(); isActive(_:); icon(for:) }`; `@MainActor final class AVSpeechAdapter: SpeechSynthesizing` (one `AVSpeechSynthesizer`).

- [ ] **Step 1: Write the failing test** — `app/Tests/CompanionCoreTests/ReadAloudTests.swift`:

```swift
import AVFoundation
import Foundation
import Synchronization
import Testing
@testable import CompanionCore

@MainActor final class FakeSynth: SpeechSynthesizing {
    var onEnd: ((Int) -> Void)?
    var log: [String] = []
    var lastToken = 0
    func speak(_ text: String, rate: Float, voiceIdentifier: String?, token: Int) {
        log.append("speak:\(text)@\(rate)")
        lastToken = token
    }
    func pause() { log.append("pause") }
    func resume() { log.append("resume") }
    func stop(atWordBoundary: Bool) { log.append(atWordBoundary ? "stop:word" : "stop:now") }
}

/// File scope (nonisolated): the synthesizer calls these from its own threads.
final class WriteBox: Sendable {
    let frames = Mutex<UInt32>(0)
    let cont = Mutex<CheckedContinuation<Void, Never>?>(nil)
    func finish() { cont.withLock { $0?.resume(); $0 = nil } }
}

final class SpeechRecorder: NSObject, AVSpeechSynthesizerDelegate, Sendable {
    let events = Mutex<[String]>([])
    func add(_ e: String) { events.withLock { $0.append(e) } }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) { add("start") }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didPause u: AVSpeechUtterance) { add("pause") }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didContinue u: AVSpeechUtterance) { add("continue") }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { add("cancel") }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { add("finish") }
}

@MainActor @Suite struct ReadAloudTests {
    @Test func rateMapping() {
        #expect(ReadAloudController.avRate(multiplier: 1) == AVSpeechUtteranceDefaultSpeechRate)
        #expect(ReadAloudController.avRate(multiplier: 0.5) == AVSpeechUtteranceDefaultSpeechRate * 0.5)
        #expect(ReadAloudController.avRate(multiplier: 2) == min(AVSpeechUtteranceDefaultSpeechRate * 2, AVSpeechUtteranceMaximumSpeechRate))
        #expect(ReadAloudController.avRate(multiplier: 9) == ReadAloudController.avRate(multiplier: 2))
        #expect(ReadAloudController.avRate(multiplier: 0) == ReadAloudController.avRate(multiplier: 0.5))
    }

    @Test func playPauseResumeStop() {
        let s = FakeSynth()
        let c = ReadAloudController(synth: s)
        let a = UUID()
        c.toggle(id: a, markdown: "**Hi**\n```\ncode\n```")
        #expect(c.playback == .playing(a))
        #expect(s.log == ["speak:Hi\nCode block omitted.@\(AVSpeechUtteranceDefaultSpeechRate)"])
        #expect(c.icon(for: a) == "pause.fill")
        c.toggle(id: a, markdown: "")
        #expect(c.playback == .paused(a))
        #expect(c.icon(for: a) == "play.fill")
        c.toggle(id: a, markdown: "")
        #expect(c.playback == .playing(a))
        c.stop()
        #expect(c.playback == .idle)
        #expect(Array(s.log.dropFirst()) == ["pause", "resume", "stop:word"])
    }

    @Test func newPlaybackStopsTheOldOneAndStaleEndsAreIgnored() {
        let s = FakeSynth()
        let c = ReadAloudController(synth: s)
        let a = UUID(), b = UUID()
        c.play(id: a, markdown: "one")
        let first = s.lastToken
        c.play(id: b, markdown: "two")
        #expect(s.log.contains("stop:now"))
        s.onEnd?(first)                 // the cancelled utterance reports late
        #expect(c.playback == .playing(b))
        s.onEnd?(s.lastToken)
        #expect(c.playback == .idle)
        #expect(!c.isActive(b))
    }

    @Test func readCodeAndRateSettingsApply() {
        let s = FakeSynth()
        let c = ReadAloudController(synth: s)
        c.readCode = true
        c.rateMultiplier = 0.5
        c.play(id: UUID(), markdown: "```\nlet x = 1\n```")
        #expect(s.log == ["speak:let x = 1@\(AVSpeechUtteranceDefaultSpeechRate * 0.5)"])
    }

    /// Spec §12.3: write(_:toBufferCallback:) produces non-empty audio. Needs at least one installed voice.
    /// nonisolated: the buffer callback runs on a synthesizer thread; a main-actor closure would trap there.
    @Test(.enabled(if: !AVSpeechSynthesisVoice.speechVoices().isEmpty), .timeLimit(.minutes(1)))
    nonisolated func writeProducesAudio() async {
        let box = WriteBox()
        let synth = AVSpeechSynthesizer()
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            box.cont.withLock { $0 = c }
            Task { try? await Task.sleep(for: .seconds(30)); box.finish() }
            synth.write(AVSpeechUtterance(string: "Hello from the companion.")) { buffer in
                guard let pcm = buffer as? AVAudioPCMBuffer else { return }
                if pcm.frameLength == 0 { box.finish() } else { box.frames.withLock { $0 += pcm.frameLength } }
            }
        }
        withExtendedLifetime(synth) {} // keep the synthesizer alive until the write has finished
        #expect(box.frames.withLock { $0 } > 0)
    }

    /// Spec §12.3 delegate sequence on the real synthesizer. Needs an audio device: opt-in (ruling 10).
    @Test(.enabled(if: ProcessInfo.processInfo.environment["COMPANION_SPEECH_TESTS"] == "1"), .timeLimit(.minutes(1)))
    nonisolated func realDelegateSequence() async throws {
        func waitFor(_ e: String, _ r: SpeechRecorder) async throws {
            for _ in 0..<200 where !r.events.withLock({ $0.contains(e) }) { try await Task.sleep(for: .milliseconds(50)) }
        }
        let s = AVSpeechSynthesizer()
        let r = SpeechRecorder()
        s.delegate = r
        s.speak(AVSpeechUtterance(string: "This sentence is long enough to pause, resume and then stop before it ends, at a word boundary, on this Mac."))
        try await waitFor("start", r)
        s.pauseSpeaking(at: .word)
        try await waitFor("pause", r)
        s.continueSpeaking()
        try await waitFor("continue", r)
        s.stopSpeaking(at: .word)
        try await waitFor("cancel", r)
        #expect(r.events.withLock { $0 } == ["start", "pause", "continue", "cancel"])
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && swift test --filter ReadAloudTests`
Expected: build FAIL — `cannot find type 'SpeechSynthesizing' in scope`.

- [ ] **Step 3: Implement** — `app/Sources/CompanionCore/Speech/ReadAloud.swift`:

```swift
import AVFoundation
import Foundation
import Observation

/// The synthesizer seam (tests use a fake). `token` identifies one utterance; `onEnd` reports it finished or cancelled.
@MainActor public protocol SpeechSynthesizing: AnyObject {
    var onEnd: ((Int) -> Void)? { get set }
    func speak(_ text: String, rate: Float, voiceIdentifier: String?, token: Int)
    func pause()
    func resume()
    func stop(atWordBoundary: Bool)
}

public enum Playback: Equatable, Sendable { case idle, playing(UUID), paused(UUID) }

/// Read Aloud (spec §8, §9): one synthesizer, pause/resume/stop at word boundaries, 0.5×–2×, new playback stops the old.
@MainActor @Observable
public final class ReadAloudController {
    public private(set) var playback: Playback = .idle
    public var rateMultiplier = 1.0
    public var voiceIdentifier: String?
    public var readCode = false
    @ObservationIgnored private let synth: any SpeechSynthesizing
    @ObservationIgnored private var token = 0

    public init(synth: any SpeechSynthesizing) {
        self.synth = synth
        synth.onEnd = { [weak self] t in self?.ended(t) }
    }

    public static func avRate(multiplier: Double) -> Float {
        let m = Float(min(max(multiplier, 0.5), 2.0))
        return min(max(AVSpeechUtteranceDefaultSpeechRate * m, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
    }

    public func play(id: UUID, markdown: String) {
        if playback != .idle { synth.stop(atWordBoundary: false) }
        token += 1
        playback = .playing(id)
        synth.speak(SpeechText.plainText(fromMarkdown: markdown, readCode: readCode),
                    rate: Self.avRate(multiplier: rateMultiplier), voiceIdentifier: voiceIdentifier, token: token)
    }

    public func toggle(id: UUID, markdown: String) {
        switch playback {
        case .playing(id):
            synth.pause()
            playback = .paused(id)
        case .paused(id):
            synth.resume()
            playback = .playing(id)
        default:
            play(id: id, markdown: markdown)
        }
    }

    public func stop() {
        guard playback != .idle else { return }
        synth.stop(atWordBoundary: true)
        playback = .idle
    }

    public func isActive(_ id: UUID) -> Bool { playback == .playing(id) || playback == .paused(id) }

    public func icon(for id: UUID) -> String {
        switch playback {
        case .playing(id): "pause.fill"
        case .paused(id): "play.fill"
        default: "speaker.wave.2"
        }
    }

    private func ended(_ t: Int) {
        if t == token { playback = .idle }
    }
}

/// The real synthesizer. Delegate callbacks arrive off the main actor and hop back with the utterance's identity.
@MainActor
public final class AVSpeechAdapter: NSObject, SpeechSynthesizing, AVSpeechSynthesizerDelegate {
    public var onEnd: ((Int) -> Void)?
    private let synth = AVSpeechSynthesizer()
    private var tokens: [ObjectIdentifier: Int] = [:]

    public override init() {
        super.init()
        synth.delegate = self
    }

    public func speak(_ text: String, rate: Float, voiceIdentifier: String?, token: Int) {
        let u = AVSpeechUtterance(string: text)
        u.rate = rate
        if let v = voiceIdentifier.flatMap({ AVSpeechSynthesisVoice(identifier: $0) }) { u.voice = v }
        tokens[ObjectIdentifier(u)] = token
        synth.speak(u)
    }

    public func pause() { synth.pauseSpeaking(at: .word) }
    public func resume() { synth.continueSpeaking() }
    public func stop(atWordBoundary: Bool) { synth.stopSpeaking(at: atWordBoundary ? .word : .immediate) }

    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        let id = ObjectIdentifier(u)
        Task { @MainActor in self.end(id) }
    }

    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        let id = ObjectIdentifier(u)
        Task { @MainActor in self.end(id) }
    }

    private func end(_ id: ObjectIdentifier) {
        if let t = tokens.removeValue(forKey: id) { onEnd?(t) }
    }
}
```

- [ ] **Step 4: Run the test**

Run: `cd app && swift test --filter ReadAloudTests`
Expected: PASS (`realDelegateSequence` skipped unless `COMPANION_SPEECH_TESTS=1`).

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore/Speech/ReadAloud.swift app/Tests/CompanionCoreTests/ReadAloudTests.swift
git commit -m "feat(app): add Read Aloud with pause, resume, stop and rate" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Dictation (`SpeechAnalyzer` + `SpeechTranscriber`)

**Files:**
- Create: `app/Sources/CompanionCore/Speech/Dictation.swift`, `app/Sources/CompanionCore/Speech/SpeechAnalyzerEngine.swift`
- Test: `app/Tests/CompanionCoreTests/DictationTests.swift`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `enum DictationEvent: Equatable, Sendable { installing(Double), volatile(String), final(String), failed(String) }`; `@MainActor protocol DictationEngine: AnyObject { func start(_ events: @escaping @MainActor (DictationEvent) -> Void) async throws; func stop() async }`; `protocol DictationPermissions: Sendable { func microphone() async -> Bool; func speechRecognition() async -> Bool }`; `struct SystemDictationPermissions: DictationPermissions`; `enum DictationState: Equatable { idle, preparing, installing(Double), recording(live: String), finishing, failed(String) }`; `@MainActor @Observable final class DictationController { state; isRecording; isError; statusText; init(engine:permissions:); toggle(appendTo:) async; stop() async; static let microphoneDenied, speechDenied }`; `enum DictationError: LocalizedError { unsupportedLocale, noAudioFormat }`; `@MainActor final class SpeechAnalyzerEngine: DictationEngine { static func transcribe(file:locale:) async throws -> String }`.

API names below follow Apple's `Speech` documentation for macOS 26 (`SpeechTranscriber(locale:transcriptionOptions:reportingOptions:attributeOptions:)`, `AssetInventory.assetInstallationRequest(supporting:)`, `SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith:)`, `start(inputSequence:)`, `analyzeSequence(from:)`, `finalizeAndFinish(through:)`, `finalizeAndFinishThroughEndOfInput()`, `result.isFinal`). If the installed SDK spells one differently, follow the SDK and keep the behaviour; note it in the commit message.

- [ ] **Step 1: Write the failing test** — `app/Tests/CompanionCoreTests/DictationTests.swift`:

```swift
import Foundation
import Testing
@testable import CompanionCore

@MainActor final class FakeEngine: DictationEngine {
    var emit: (@MainActor (DictationEvent) -> Void)?
    var started = 0
    var stopped = 0
    var startError: (any Error)?
    var finalOnStop: String?
    var holdStart = false
    var held: CheckedContinuation<Void, Never>?
    func start(_ events: @escaping @MainActor (DictationEvent) -> Void) async throws {
        started += 1
        if holdStart { await withCheckedContinuation { held = $0 } }
        if let e = startError { throw e }
        emit = events
        events(.installing(0.5))
    }
    func stop() async {
        stopped += 1
        if let f = finalOnStop { emit?(.final(f)) }
    }
}

struct FakePermissions: DictationPermissions {
    let mic: Bool
    let speech: Bool
    func microphone() async -> Bool { mic }
    func speechRecognition() async -> Bool { speech }
}

@MainActor @Suite struct DictationTests {
    @Test func deniedPermissionsExplainAndNeverStart() async {
        let e = FakeEngine()
        let c = DictationController(engine: e, permissions: FakePermissions(mic: false, speech: true))
        await c.toggle(appendTo: { _ in })
        #expect(c.state == .failed(DictationController.microphoneDenied))
        #expect(c.isError)
        let c2 = DictationController(engine: e, permissions: FakePermissions(mic: true, speech: false))
        await c2.toggle(appendTo: { _ in })
        #expect(c2.state == .failed(DictationController.speechDenied))
        #expect(e.started == 0)
    }

    @Test func recordsShowsLiveTextAndAppendsFinals() async {
        let e = FakeEngine()
        e.finalOnStop = "and the rest"
        let c = DictationController(engine: e, permissions: FakePermissions(mic: true, speech: true))
        var got: [String] = []
        await c.toggle(appendTo: { got.append($0) })
        #expect(c.state == .recording(live: ""))
        #expect(c.isRecording)
        e.emit?(.volatile("what is"))
        #expect(c.state == .recording(live: "what is"))
        e.emit?(.final(" What is this file? "))
        #expect(got == ["What is this file?"])
        #expect(c.state == .recording(live: ""))
        await c.toggle(appendTo: { got.append($0) })
        #expect(got == ["What is this file?", "and the rest"])
        #expect(c.state == .idle)
        #expect(e.stopped == 1)
    }

    @Test func stopWhileStartingNeverLeavesTheMicOn() async {
        let e = FakeEngine()
        e.holdStart = true
        let c = DictationController(engine: e, permissions: FakePermissions(mic: true, speech: true))
        let starting = Task { await c.toggle(appendTo: { _ in }) }
        while e.held == nil { await Task.yield() }
        await c.toggle(appendTo: { _ in })      // Stop pressed while the engine is still starting
        #expect(c.state == .idle)
        e.held?.resume()
        await starting.value
        #expect(e.stopped == 2)                  // the late start is stopped again
        #expect(c.state == .idle)
        #expect(!c.isRecording)
    }

    @Test func aFailureWhileRecordingStopsTheEngine() async {
        let e = FakeEngine()
        let c = DictationController(engine: e, permissions: FakePermissions(mic: true, speech: true))
        await c.toggle(appendTo: { _ in })
        e.emit?(.failed("Dictation stopped."))
        for _ in 0..<100 where e.stopped == 0 { await Task.yield() }
        #expect(e.stopped == 1)
        #expect(c.state == .failed("Dictation stopped."))
        #expect(!c.isRecording)
    }

    @Test func engineErrorsAreShown() async {
        let e = FakeEngine()
        e.startError = DictationError.unsupportedLocale
        let c = DictationController(engine: e, permissions: FakePermissions(mic: true, speech: true))
        await c.toggle(appendTo: { _ in })
        #expect(c.state == .failed(DictationError.unsupportedLocale.errorDescription!))
        #expect(c.statusText == DictationError.unsupportedLocale.errorDescription)
    }

    /// Spec §12.3: a clip made with `say -o`, fed through SpeechAnalyzer from a file. Needs speech assets: opt-in (ruling 10).
    @Test(.enabled(if: ProcessInfo.processInfo.environment["COMPANION_SPEECH_TESTS"] == "1"), .timeLimit(.minutes(5)))
    func transcribesASaidClip() async throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "companion-speech-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let clip = dir.appending(path: "clip.aiff")
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-o", clip.path, "The quick brown fox jumps over the lazy dog."]
        try say.run()
        say.waitUntilExit()
        #expect(say.terminationStatus == 0)
        let text = try await SpeechAnalyzerEngine.transcribe(file: clip, locale: Locale(identifier: "en-US")).lowercased()
        #expect(text.contains("brown fox"))
        #expect(text.contains("lazy dog"))
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && swift test --filter DictationTests`
Expected: build FAIL — `cannot find type 'DictationEngine' in scope`.

- [ ] **Step 3: Implement** — `app/Sources/CompanionCore/Speech/Dictation.swift`:

```swift
import AVFoundation
import Foundation
import Observation
import Speech

public enum DictationEvent: Equatable, Sendable {
    case installing(Double)
    case volatile(String)
    case final(String)
    case failed(String)
}

@MainActor public protocol DictationEngine: AnyObject {
    func start(_ events: @escaping @MainActor (DictationEvent) -> Void) async throws
    func stop() async
}

public protocol DictationPermissions: Sendable {
    func microphone() async -> Bool
    func speechRecognition() async -> Bool
}

/// Microphone and Speech Recognition on first use (spec §7.8, ruling 9).
public struct SystemDictationPermissions: DictationPermissions {
    public init() {}
    public func microphone() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }
    public func speechRecognition() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) } }
        default: return false
        }
    }
}

public enum DictationState: Equatable, Sendable {
    case idle, preparing, installing(Double), recording(live: String), finishing, failed(String)
}

/// Dictation (spec §8, §9): continuous until stopped, live text shown, final text appended to the editable draft.
@MainActor @Observable
public final class DictationController {
    public static let microphoneDenied = "Microphone access is off. Turn it on in System Settings › Privacy & Security › Microphone."
    public static let speechDenied = "Speech Recognition is off. Turn it on in System Settings › Privacy & Security › Speech Recognition."

    public private(set) var state: DictationState = .idle
    @ObservationIgnored private let engine: any DictationEngine
    @ObservationIgnored private let permissions: any DictationPermissions
    @ObservationIgnored private var sink: ((String) -> Void)?
    @ObservationIgnored private var startGeneration = 0

    public init(engine: any DictationEngine, permissions: any DictationPermissions) {
        self.engine = engine
        self.permissions = permissions
    }

    public var isRecording: Bool { if case .recording = state { true } else { false } }
    public var isError: Bool { if case .failed = state { true } else { false } }
    public var statusText: String? {
        switch state {
        case .preparing: "Getting the microphone ready…"
        case .installing(let p): "Downloading the speech model… \(Int(p * 100))%"
        case .finishing: "Finishing…"
        case .failed(let m): m
        case .idle, .recording: nil
        }
    }

    public func toggle(appendTo sink: @escaping (String) -> Void) async {
        switch state {
        case .recording, .installing, .preparing: await stop()
        case .finishing: return
        case .idle, .failed: await start(sink)
        }
    }

    private func start(_ sink: @escaping (String) -> Void) async {
        self.sink = sink
        startGeneration += 1
        let gen = startGeneration
        state = .preparing
        // After every await: if Stop was pressed meanwhile (generation moved), give up, and never leave the mic on.
        guard await permissions.microphone() else { if gen == startGeneration { state = .failed(Self.microphoneDenied) }; return }
        guard gen == startGeneration else { return }
        guard await permissions.speechRecognition() else { if gen == startGeneration { state = .failed(Self.speechDenied) }; return }
        guard gen == startGeneration else { return }
        do {
            try await engine.start { [weak self] e in self?.on(e) }
            guard gen == startGeneration else {
                await engine.stop()
                return
            }
            switch state {
            case .preparing, .installing: state = .recording(live: "")
            default: break
            }
        } catch {
            if gen == startGeneration { state = .failed((error as? any LocalizedError)?.errorDescription ?? "Dictation could not start.") }
        }
    }

    public func stop() async {
        startGeneration += 1
        state = .finishing
        await engine.stop()
        if state == .finishing { state = .idle }
    }

    private func on(_ e: DictationEvent) {
        switch e {
        case .installing(let p):
            switch state {
            case .preparing, .installing: state = .installing(p)
            default: break
            }
        case .volatile(let t):
            if case .recording = state { state = .recording(live: t) }
        case .final(let t):
            let clean = t.trimmingCharacters(in: .whitespacesAndNewlines)
            if !clean.isEmpty { sink?(clean) }
            if case .recording = state { state = .recording(live: "") }
        case .failed(let m):
            // The engine failed mid-recording: turn the microphone off too, never leave it running behind an error.
            startGeneration += 1
            state = .failed(m)
            Task { await self.engine.stop() }
        }
    }
}
```

`app/Sources/CompanionCore/Speech/SpeechAnalyzerEngine.swift`:

```swift
import AVFoundation
import Foundation
import Speech

public enum DictationError: Error, LocalizedError, Equatable {
    case unsupportedLocale, noAudioFormat
    public var errorDescription: String? {
        switch self {
        case .unsupportedLocale: "Dictation does not support this Mac's language yet."
        case .noAudioFormat: "The microphone's audio could not be prepared for dictation."
        }
    }
}

/// SpeechAnalyzer + SpeechTranscriber only (spec §9, F15). Missing locale assets are installed with progress.
@MainActor
public final class SpeechAnalyzerEngine: DictationEngine {
    private var audioEngine: AVAudioEngine?
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var results: Task<Void, Never>?

    public init() {}

    static func transcriber(_ locale: Locale, volatile: Bool) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, transcriptionOptions: [],
                          reportingOptions: volatile ? [.volatileResults] : [], attributeOptions: [])
    }

    static func ensureAssets(_ t: SpeechTranscriber, progress: @escaping @MainActor (Double) -> Void) async throws {
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [t]) else { return }
        let p = request.progress
        let watcher = Task { @MainActor in
            while !Task.isCancelled {
                progress(p.fractionCompleted)
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        defer { watcher.cancel() }
        try await request.downloadAndInstall()
    }

    public func start(_ events: @escaping @MainActor (DictationEvent) -> Void) async throws {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) else { throw DictationError.unsupportedLocale }
        let transcriber = Self.transcriber(locale, volatile: true)
        try await Self.ensureAssets(transcriber) { events(.installing($0)) }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { throw DictationError.noAudioFormat }

        let (stream, builder) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        // Stored before anything below can throw, so stop() (or the catch) can always clean up.
        self.analyzer = analyzer
        input = builder
        results = Task { @MainActor in
            do {
                for try await r in transcriber.results {
                    let text = String(r.text.characters)
                    events(r.isFinal ? .final(text) : .volatile(text))
                }
            } catch {
                events(.failed("Dictation stopped."))
            }
        }
        do {
            try await analyzer.start(inputSequence: stream)
            let engine = AVAudioEngine()
            audioEngine = engine
            let node = engine.inputNode
            let micFormat = node.outputFormat(forBus: 0)
            guard let converter = AVAudioConverter(from: micFormat, to: format) else { throw DictationError.noAudioFormat }
            node.installTap(onBus: 0, bufferSize: 4096, format: micFormat,
                            block: MicTap.block(converter: ConverterBox(converter, to: format), builder: builder))
            engine.prepare()
            try engine.start()
        } catch {
            audioEngine?.inputNode.removeTap(onBus: 0)
            audioEngine?.stop()
            audioEngine = nil
            builder.finish()
            input = nil
            await analyzer.cancelAndFinishNow()
            self.analyzer = nil
            results?.cancel()
            results = nil
            throw error
        }
    }

    public func stop() async {
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        input?.finish()
        input = nil
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        analyzer = nil
        await results?.value
        results = nil
    }

    /// Spec §12.3 test path: transcribe an audio file, return the final text.
    public static func transcribe(file url: URL, locale: Locale) async throws -> String {
        guard let l = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else { throw DictationError.unsupportedLocale }
        let t = transcriber(l, volatile: false)
        try await ensureAssets(t) { _ in }
        let analyzer = SpeechAnalyzer(modules: [t])
        let collect = Task {
            var parts: [String] = []
            for try await r in t.results { parts.append(String(r.text.characters)) }
            return parts.joined(separator: " ")
        }
        let audio = try AVAudioFile(forReading: url)
        if let last = try await analyzer.analyzeSequence(from: audio) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        return try await collect.value
    }
}

/// AVAudioEngine calls the tap on its own audio thread. The block is built in a nonisolated function so it does not
/// inherit @MainActor (a main-actor closure called there traps at run time under Swift 6).
enum MicTap {
    /// Captures only the Sendable box and the continuation (the tap block may be @Sendable in the SDK).
    nonisolated static func block(converter: ConverterBox,
                                  builder: AsyncStream<AnalyzerInput>.Continuation) -> AVAudioNodeTapBlock {
        return { buffer, _ in
            if let out = converter.convert(buffer) { builder.yield(AnalyzerInput(buffer: out)) }
        }
    }
}

/// Used only on the audio thread, one buffer at a time. Holds the target format so the tap captures no
/// non-Sendable AVFoundation object directly.
final class ConverterBox: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let format: AVAudioFormat
    init(_ converter: AVAudioConverter, to format: AVAudioFormat) {
        self.converter = converter
        self.format = format
    }

    func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let ratio = format.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        // The input block may be @Sendable in the SDK: keep the flag in a box and the buffer as nonisolated(unsafe).
        final class Fed: @unchecked Sendable { var done = false }
        let fed = Fed()
        nonisolated(unsafe) let source = input
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed.done {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed.done = true
            inputStatus.pointee = .haveData
            return source
        }
        return status == .error || out.frameLength == 0 ? nil : out
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && swift test --filter DictationTests`
Expected: PASS (`transcribesASaidClip` skipped unless `COMPANION_SPEECH_TESTS=1`). Then run it once locally:
`cd app && COMPANION_SPEECH_TESTS=1 swift test --filter DictationTests/transcribesASaidClip` — expected PASS after the first run installs the en-US assets. If the test process is stopped by macOS privacy protection (the test runner has no usage strings), record that and cover the clip check in the Task 14 checklist from the signed app instead.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore/Speech app/Tests/CompanionCoreTests/DictationTests.swift
git commit -m "feat(app): add dictation with SpeechAnalyzer and SpeechTranscriber" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Views

SwiftUI views over `AppModel`, `ReadAloudController` and `DictationController` (all from the environment). No logic that decides what is sent lives here. Every untrusted string goes through `Text(String)`.

**Files:**
- Create: `app/Sources/CompanionApp/FileOpener.swift`, `app/Sources/CompanionApp/Views/CenterMessage.swift`, `Views/SidebarView.swift`, `Views/HeaderView.swift`, `Views/PickerView.swift`, `Views/BannerStack.swift`, `Views/ApproveSheet.swift`, `Views/ChatView.swift`, `Views/ReplyView.swift`, `Views/InputBar.swift`, `Views/PreviewSheet.swift`, `Views/SentSheet.swift`, `Views/SettingsView.swift` (all under `app/Sources/CompanionApp/`)
- Test: `SourceRulesTests` (Task 1) covers these files; behaviour is checked in Task 12 Step 4 and the Task 14 checklist.

**Interfaces:**
- Consumes: Tasks 2, 5–10.
- Produces: `SidebarView` (panel root), `SettingsView` (Settings scene root), `@MainActor @Observable final class WindowStatus { accessibilityTrusted; followNote; hotkeyError }` (written by Task 12's coordinator), `enum FileOpener { static func open(_:root:editor:) }`.

- [ ] **Step 1: Shared pieces** — `app/Sources/CompanionApp/FileOpener.swift`:

```swift
import AppKit
import CompanionCore
import UniformTypeIdentifiers

/// Hands a path:line to the user's editor. The app writes nothing. The link came from an untrusted reply, so only a
/// regular, non-package file of a safe type is opened (ruling 19); anything else is revealed in Finder or refused.
@MainActor enum FileOpener {
    static let refused: [UTType] = [.executable, .application, .applicationBundle, .bundle, .package, .shellScript,
                                    .script, .html, .xml, .svg, .webArchive, .internetLocation, .aliasFile, .symbolicLink]

    static func open(_ ref: FileReference, root: String, editor: EditorChoice) {
        let file = URL(fileURLWithPath: ref.path)
        // Lexical containment is not enough: a symlinked folder inside the root could point outside it.
        let realRoot = URL(fileURLWithPath: root).resolvingSymlinksInPath().path
        guard FileReferences.contained(file.resolvingSymlinksInPath().path, root: realRoot) != nil else { return }
        guard let v = try? file.resourceValues(forKeys: [.isRegularFileKey, .isPackageKey, .isSymbolicLinkKey, .contentTypeKey]),
              v.isSymbolicLink != true, v.isRegularFile == true, v.isPackage != true else { return }
        let type = v.contentType ?? .data
        if refused.contains(where: { type.conforms(to: $0) }) || FileManager.default.isExecutableFile(atPath: ref.path) {
            NSWorkspace.shared.activateFileViewerSelecting([file])
            return
        }
        var chosen = editor
        if chosen == .auto {
            chosen = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "vscode://file/")!) != nil ? .vscode : .system
        }
        if chosen == .system && !(type.conforms(to: .plainText) || type.conforms(to: .sourceCode)) {
            NSWorkspace.shared.activateFileViewerSelecting([file])
            return
        }
        if chosen == .xcode {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/xed")
            p.arguments = ["--line", String(ref.line), ref.path]
            try? p.run()
            return
        }
        if let url = EditorLink.url(for: ref, editor: chosen) { NSWorkspace.shared.open(url) }
    }
}
```

`app/Sources/CompanionApp/Views/CenterMessage.swift`:

```swift
import SwiftUI

struct CenterMessage<Actions: View>: View {
    let title: String
    var detail: String? = nil
    var spinner = false
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 10) {
            if spinner { ProgressView() }
            Text(title).font(.headline).multilineTextAlignment(.center)
            if let detail {
                Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).textSelection(.enabled)
            }
            actions
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension CenterMessage where Actions == EmptyView {
    init(title: String, detail: String? = nil, spinner: Bool = false) {
        self.init(title: title, detail: detail, spinner: spinner) { EmptyView() }
    }
}

/// A one-line notice with an optional action and a dismiss button.
struct Banner: View {
    enum Tone { case info, warning, danger }
    let text: String
    var tone: Tone = .info
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var onDismiss: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: tone == .danger ? "exclamationmark.octagon.fill" : tone == .warning ? "exclamationmark.triangle.fill" : "info.circle.fill")
                .foregroundStyle(tone == .danger ? Color.red : tone == .warning ? Color.orange : Color.accentColor)
            Text(text).font(.callout).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            if let actionTitle, let action { Button(actionTitle, action: action).buttonStyle(.link) }
            if let onDismiss { Button { onDismiss() } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Dismiss") }
        }
        .padding(8)
        .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
    }
}
```

- [ ] **Step 2: Panel, header, picker, banners, approval** — `app/Sources/CompanionApp/Views/SidebarView.swift`:

```swift
import CompanionCore
import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            HeaderView()
            Divider()
            BannerStack()
            gateContent
            if model.gate == .ready {
                Divider()
                InputBar()
            }
        }
        .frame(minWidth: 280, maxWidth: 640, minHeight: 320)
        .sheet(item: $model.preview) { _ in PreviewSheet() }
        .sheet(item: $model.sentView) { view in SentSheet(view: view) }
        .alert("Something went wrong", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    @ViewBuilder private var gateContent: some View {
        switch model.gate {
        case .ready:
            ChatView()
        case .connecting:
            CenterMessage(title: "Starting companiond…", spinner: true)
        case .daemonStopped(let why):
            CenterMessage(title: "companiond is not running", detail: why) {
                Button("Restart companiond") { Task { await model.restartDaemon() } }
            }
        case .hostStarting:
            CenterMessage(title: "Starting Codex and running its security checks…", spinner: true)
        case .hostFailed(let why):
            CenterMessage(title: "Chat is off", detail: why) {
                Button("Try again") { Task { await model.restartHost() } }
            }
        case .securityStop(let why):
            // Ruling 18: no "Try again" here. Only this button clears the stop (host.acknowledgeSecurityStop).
            CenterMessage(title: "Security check failed. Chat stopped.",
                          detail: why + "\n\nGPT was stopped because something it did was outside the read-only rules. Read the reason, then acknowledge to start Codex again.") {
                Button("I've read this — acknowledge and restart") { Task { await model.acknowledgeSecurityStop() } }
            }
        case .authError(let why):
            CenterMessage(title: "Could not check your ChatGPT sign-in", detail: why) {
                Button("Retry") { Task { await model.loadAuth() } }
            }
        case .signedOut:
            CenterMessage(title: "Sign in with ChatGPT",
                          detail: "GPT answers through your ChatGPT plan. The sign-in page opens in your browser. No API key is used.") {
                SignInButton()
            }
        case .authUnsupported(let mode):
            CenterMessage(title: "This sign-in is not supported", detail: "Codex reports the \"\(mode)\" sign-in. Sign in with ChatGPT instead.") {
                SignInButton()
            }
        case .noSession:
            CenterMessage(title: "No Claude session found", detail: "Open Claude Code Desktop and select a session, then press Refresh (⌘R).") {
                Button("Refresh") { Task { await model.refresh() } }
            }
        }
    }
}

struct SignInButton: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    var body: some View {
        Button("Sign in with ChatGPT") {
            Task { if let url = await model.signIn() { openURL(url) } }
        }
        .keyboardShortcut(.defaultAction)
    }
}
```

`app/Sources/CompanionApp/Views/HeaderView.swift`:

```swift
import CompanionCore
import SwiftUI

struct HeaderView: View {
    @Environment(AppModel.self) private var model
    @State private var showPicker = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(statusColor).frame(width: 8, height: 8).help(model.selectedSession?.status.rawValue ?? "")
                Text(model.selectedSession?.title ?? "No Claude session").font(.headline).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                Button { showPicker.toggle() } label: { Image(systemName: "list.bullet") }
                    .help("Choose a Claude session")
                    .popover(isPresented: $showPicker) { PickerView(close: { showPicker = false }) }
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Refresh (⌘R)")
            }
            .buttonStyle(.borderless)
            HStack(spacing: 6) {
                Label(model.repoSummary, systemImage: "folder").lineLimit(1).truncationMode(.middle).help(model.repoHelp)
                Spacer(minLength: 4)
                Text("🔒 Read-only").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1).background(.quaternary, in: Capsule())
                    .help("GPT can read this repository but cannot change it.")
                SharingChip()
            }
            .font(.caption)
            HStack(spacing: 6) {
                Text(model.selectionLabel).foregroundStyle(.secondary)
                Text("·").foregroundStyle(.secondary)
                Text(model.syncSummary).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if model.snapshot?.selection.via == "pin" {
                    Button("Unpin") { Task { await model.followFocus() } }.buttonStyle(.link)
                } else if let id = model.selectedSessionId {
                    Button("Pin") { Task { await model.pin(id) } }.buttonStyle(.link)
                }
            }
            .font(.caption2)
        }
        .padding(10)
    }

    private var statusColor: Color {
        switch model.selectedSession?.status {
        case .busy?: .orange
        case .idle?: .green
        case .recent?: .gray
        default: .secondary
        }
    }
}

struct SharingChip: View {
    @Environment(AppModel.self) private var model
    @State private var confirmAutomatic = false

    var body: some View {
        Menu {
            ForEach(SharingMode.allCases, id: \.self) { mode in
                Button(mode.title) {
                    if mode == .automatic { confirmAutomatic = true } else { Task { await model.setSharingMode(mode) } }
                }
            }
        } label: {
            Text("Context: \(model.privacy?.sharingMode.title ?? "…")")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("What GPT gets from the Claude session")
        .automaticModeConfirmation(isPresented: $confirmAutomatic)
    }
}

extension View {
    /// Choosing Automatic needs a confirmation that shows the redaction notice (ruling 14).
    func automaticModeConfirmation(isPresented: Binding<Bool>) -> some View {
        modifier(AutomaticModeConfirmation(isPresented: isPresented))
    }
}

struct AutomaticModeConfirmation: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var isPresented: Bool
    func body(content: Content) -> some View {
        content.confirmationDialog("Send Claude's session context without asking?", isPresented: $isPresented) {
            Button("Use Automatic") { Task { await model.setSharingMode(.automatic) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Each question then includes the new part of the Claude session (capped at 12 KB, redacted) without a preview. " + model.redactionNotice)
        }
    }
}
```

`app/Sources/CompanionApp/Views/PickerView.swift`:

```swift
import CompanionCore
import SwiftUI

struct PickerView: View {
    @Environment(AppModel.self) private var model
    let close: () -> Void
    @State private var query = ""
    @State private var groups: PickerGroups?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Search sessions", text: $query).textFieldStyle(.roundedBorder)
            Button("Follow Claude focus") { Task { await model.followFocus(); close() } }.buttonStyle(.link)
            List {
                section("Busy", groups?.busy)
                section("Idle", groups?.idle)
                section("Recent", groups?.recent)
                if !query.isEmpty { section("Older", groups?.older) }
            }
            .frame(width: 320, height: 380)
        }
        .padding(10)
        .task(id: query) {
            try? await Task.sleep(for: .milliseconds(200))
            groups = await model.picker(query: query)
        }
    }

    @ViewBuilder private func section(_ title: String, _ items: [SessionSummary]?) -> some View {
        if let items, !items.isEmpty {
            Section(title) {
                ForEach(items) { s in
                    Button {
                        Task { await model.pin(s.sessionId); close() }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.title).lineLimit(1)
                            Text(s.locationLine).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}
```

`app/Sources/CompanionApp/Views/BannerStack.swift`:

```swift
import CompanionCore
import SwiftUI

private struct ApprovalTarget: Identifiable { let root: String; var id: String { root } }

struct BannerStack: View {
    @Environment(AppModel.self) private var model
    @State private var approving: ApprovalTarget?

    var body: some View {
        VStack(spacing: 6) {
            ForEach(model.alerts) { a in
                Banner(text: a.bannerText, tone: .danger, onDismiss: { model.dismiss(alert: a) })
            }
            if let msg = model.snapshot?.desktopRecordsError { Banner(text: msg, tone: .warning) }
            if let msg = model.syncError { Banner(text: "Sync problem: \(msg)", tone: .warning, onDismiss: { model.dismissSyncError() }) }
            if let banner = model.currentRepoBanner { Banner(text: banner, onDismiss: { model.dismissRepoBanner() }) }
            if let notice = model.currentThreadNotice { Banner(text: notice, tone: .warning, onDismiss: { model.dismissThreadNotice() }) }
            if let moved = model.focusMovedTitle {
                Banner(text: "Claude focus moved to \(moved) — switch?", actionTitle: "Switch", action: { Task { await model.followFocus() } })
            }
            if model.snapshot?.selection.pinnedMissing == true {
                Banner(text: "The pinned session is no longer listed.", tone: .warning, actionTitle: "Unpin", action: { Task { await model.followFocus() } })
            }
            if let u = model.unavailableRepo {
                Banner(text: u.detail, tone: .warning, actionTitle: u.approvableRoot == nil ? nil : "Approve…",
                       action: u.approvableRoot.map { root in { approving = ApprovalTarget(root: root) } })
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, model.alerts.isEmpty && model.unavailableRepo == nil && model.currentRepoBanner == nil ? 0 : 6)
        .sheet(item: $approving) { t in ApproveSheet(root: t.root) }
    }
}
```

`app/Sources/CompanionApp/Views/ApproveSheet.swift`:

```swift
import CompanionCore
import SwiftUI

struct ApproveSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let root: String
    @State private var includeWorktrees = true
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Let GPT read this repository?").font(.headline)
            Text(root).font(.callout.monospaced()).textSelection(.enabled)
            Text("GPT reads files here only through read-only tools. It cannot change, create or delete files. Secret-looking files (.env, keys, credentials) stay hidden. You can revoke this in Settings › Privacy.")
                .font(.callout)
            Toggle("Also approve this repository's worktrees (Claude Desktop runs each session in its own worktree)", isOn: $includeWorktrees)
            if let error { Text(error).font(.callout).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Approve") {
                    busy = true
                    Task {
                        error = await model.approve(root: root, includeWorktrees: includeWorktrees)
                        busy = false
                        if error == nil { dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(busy)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}
```

- [ ] **Step 3: Chat, reply, input** — `app/Sources/CompanionApp/Views/ChatView.swift`:

```swift
import CompanionCore
import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if model.currentMessages.isEmpty {
                        Text("Ask GPT about what Claude is doing in this session. GPT can read the repository but never changes it.")
                            .font(.callout).foregroundStyle(.secondary).padding(.top, 20)
                    }
                    ForEach(model.currentMessages) { m in MessageView(message: m).id(m.id) }
                }
                .padding(10)
            }
            .onChange(of: model.currentMessages.last?.text) {
                if let id = model.currentMessages.last?.id { proxy.scrollTo(id, anchor: .bottom) }
            }
        }
    }
}

struct MessageView: View {
    @Environment(AppModel.self) private var model
    @Environment(ReadAloudController.self) private var readAloud
    let message: ChatMessage

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 40)
                Text(message.text).textSelection(.enabled).padding(8)
                    .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if !message.text.isEmpty { ReplyView(markdown: message.text, root: model.currentRoot) }
                if let a = message.activity {
                    Label(a, systemImage: "doc.text.magnifyingglass").font(.caption).foregroundStyle(.secondary)
                }
                footer
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    @ViewBuilder private var footer: some View {
        HStack(spacing: 10) {
            switch message.status {
            case .sending, .streaming:
                ProgressView().controlSize(.small)
                Text("Answering…").font(.caption).foregroundStyle(.secondary)
            case .interrupted:
                Text("Stopped").font(.caption).foregroundStyle(.secondary)
            case .failed(let why):
                Text(why).font(.caption).foregroundStyle(.red)
                if message.retry != nil {
                    Button("Send again") { Task { await model.sendAgain(message) } }.font(.caption)
                }
            case .done:
                EmptyView()
            }
            Spacer(minLength: 0)
            if !message.isRunning && !message.text.isEmpty {
                Button { readAloud.toggle(id: message.id, markdown: message.text) } label: {
                    Image(systemName: readAloud.icon(for: message.id))
                }
                .help(readAloud.isActive(message.id) ? "Pause or resume" : "Read aloud")
                if readAloud.isActive(message.id) {
                    Button { readAloud.stop() } label: { Image(systemName: "stop.fill") }.help("Stop reading")
                }
            }
            if message.turnId != nil {
                Button("View what was sent") { Task { await model.viewSent(message) } }.font(.caption)
            }
        }
        .buttonStyle(.borderless)
    }
}
```

`app/Sources/CompanionApp/Views/ReplyView.swift`:

```swift
import CompanionCore
import SwiftUI

/// Renders a GPT reply through ReplyMarkdown only. The single link kind is companion-open (path:line inside the root).
struct ReplyView: View {
    @Environment(AppModel.self) private var model
    let markdown: String
    let root: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(ReplyMarkdown.blocks(markdown).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            // Checked again here: the root may have changed since the reply was rendered.
            guard let ref = EditorLink.parseCompanionURL(url), let root,
                  let path = FileReferences.contained(ref.path, root: root) else { return .discarded }
            FileOpener.open(FileReference(path: path, line: ref.line), root: root, editor: model.settings.editor)
            return .handled
        })
    }

    @ViewBuilder private func view(for block: ReplyBlock) -> some View {
        switch block {
        case .paragraph(let t):
            Text(ReplyMarkdown.inline(t, root: root)).textSelection(.enabled)
        case .heading(let level, let t):
            Text(ReplyMarkdown.inline(t, root: root)).font(level <= 2 ? .headline : .subheadline.bold())
        case .bullet(let t):
            HStack(alignment: .firstTextBaseline, spacing: 6) { Text("•"); Text(ReplyMarkdown.inline(t, root: root)).textSelection(.enabled) }
        case .numbered(let marker, let t):
            HStack(alignment: .firstTextBaseline, spacing: 6) { Text(marker); Text(ReplyMarkdown.inline(t, root: root)).textSelection(.enabled) }
        case .quote(let t):
            Text(ReplyMarkdown.inline(t, root: root)).foregroundStyle(.secondary).padding(.leading, 8)
                .overlay(alignment: .leading) { Rectangle().frame(width: 2).foregroundStyle(.tertiary) }
        case .code(_, let code):
            ScrollView(.horizontal) {
                Text(code).font(.system(.callout, design: .monospaced)).textSelection(.enabled).padding(8)
            }
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
        }
    }
}
```

`app/Sources/CompanionApp/Views/InputBar.swift`:

```swift
import CompanionCore
import SwiftUI

struct InputBar: View {
    @Environment(AppModel.self) private var model
    @Environment(DictationController.self) private var dictation

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 6) {
            if model.privacy?.sharingMode != .off { // ruling 20
                Button("Explain Claude's last message") { Task { await model.explainLastMessage() } }
                    .buttonStyle(.link).font(.caption).disabled(!model.canExplain)
            }
            if case .recording(let live) = dictation.state, !live.isEmpty {
                Text(live).font(.callout).foregroundStyle(.secondary).lineLimit(3)
            }
            if let status = dictation.statusText {
                Text(status).font(.caption).foregroundStyle(dictation.isError ? .red : .secondary)
            }
            HStack(alignment: .bottom, spacing: 6) {
                TextField("Ask GPT about this Claude session", text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await model.submitDraft() } }
                Button {
                    Task { await dictation.toggle(appendTo: { model.appendToDraft($0) }) }
                } label: {
                    Image(systemName: dictation.isRecording ? "mic.fill" : "mic")
                        .foregroundStyle(dictation.isRecording ? Color.red : Color.primary)
                }
                .help(dictation.isRecording ? "Stop dictation" : "Dictate")
                if model.isAnswering {
                    Button { Task { await model.interrupt() } } label: { Image(systemName: "stop.circle.fill") }.help("Stop the reply")
                } else {
                    Button { Task { await model.submitDraft() } } label: { Image(systemName: "arrow.up.circle.fill") }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(!model.canSend)
                        .help("Send (⌘↩)")
                }
            }
            .buttonStyle(.borderless)
        }
        .padding(10)
    }
}
```

- [ ] **Step 4: Preview and "what was sent" sheets** — `app/Sources/CompanionApp/Views/PreviewSheet.swift`:

```swift
import CompanionCore
import SwiftUI

/// Ask mode (spec §4.3, §7.5): the exact items, each removable. Nothing is sent until Send.
struct PreviewSheet: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let p = model.preview {
            VStack(alignment: .leading, spacing: 10) {
                Text("Check what GPT will see").font(.headline)
                if let notice = p.notice { Text(notice).font(.callout).foregroundStyle(.orange) }
                if let title = p.prepared.sessionTitle { Text("Claude session: " + title).font(.callout).textSelection(.enabled) }
                Text(p.prepared.repo.summary).font(.callout)
                if let note = p.prepared.repoNote { Text(note).font(.callout) }
                ForEach(p.prepared.preview?.notes ?? [], id: \.self) { note in
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
                List {
                    ForEach(p.prepared.preview?.items ?? []) { item in
                        Toggle(isOn: Binding(get: { !p.removed.contains(item.id) }, set: { _ in model.toggle(itemId: item.id) })) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(item.label).font(.caption.bold())
                                    if item.redactions > 0 { Text("\(item.redactions) masked").font(.caption2).foregroundStyle(.orange) }
                                }
                                Text(item.text).font(.system(.caption, design: .monospaced)).textSelection(.enabled).lineLimit(8)
                            }
                        }
                    }
                }
                .frame(minHeight: 240)
                Text(p.summaryLine).font(.caption).foregroundStyle(.secondary)
                Text("Your question: " + p.question).font(.caption).lineLimit(2)
                Text(model.redactionNotice).font(.caption).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("Cancel", role: .cancel) { model.cancelPreview() }.keyboardShortcut(.cancelAction)
                    Button("Send") { Task { await model.confirmPreview() } }.keyboardShortcut(.defaultAction)
                }
            }
            .padding(16)
            .frame(width: 520, height: 580)
        }
    }
}
```

`app/Sources/CompanionApp/Views/SentSheet.swift`:

```swift
import CompanionCore
import SwiftUI

struct SentSheet: View {
    @Environment(\.dismiss) private var dismiss
    let view: SentView

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What was sent to GPT").font(.headline)
            switch view {
            case .found(let r):
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Question").font(.caption.bold())
                        Text(r.question).textSelection(.enabled)
                        Text("Context").font(.caption.bold())
                        Text(r.contextBlock.isEmpty ? "(no context)" : r.contextBlock)
                            .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            case .notKept:
                Text("companiond keeps this only until it restarts, and it has restarted since. The same text is in the Codex thread history.")
                    .font(.callout)
            }
            HStack { Spacer(); Button("Close") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(16)
        .frame(width: 520, height: 480)
    }
}
```

- [ ] **Step 5: Settings** — `app/Sources/CompanionApp/Views/SettingsView.swift`:

```swift
import AVFoundation
import CompanionCore
import Observation
import SwiftUI

/// Window state the settings show; written by WindowCoordinator (Task 12).
@MainActor @Observable final class WindowStatus {
    var accessibilityTrusted = false
    var followNote: String?
    var hotkeyError: String?
}

struct SettingsView: View {
    var body: some View {
        TabView {
            AccountSettings().tabItem { Label("Account", systemImage: "person.crop.circle") }
            PrivacySettings().tabItem { Label("Privacy", systemImage: "hand.raised") }
            SpeechSettings().tabItem { Label("Speech", systemImage: "speaker.wave.2") }
            WindowSettings().tabItem { Label("Window", systemImage: "sidebar.left") }
            AdvancedSettings().tabItem { Label("Advanced", systemImage: "gearshape.2") }
        }
        .frame(width: 540, height: 440)
        .padding()
    }
}

struct AccountSettings: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Form {
            LabeledContent("ChatGPT") { Text(authText) }
            if !isSignedIn { SignInButton() }
            LabeledContent("Codex") { Text(hostText) }
            ForEach(warnings, id: \.self) { w in Text(w).font(.caption).foregroundStyle(.orange) }
            Text("The companion never reads or stores your ChatGPT token; Codex keeps it in your Keychain.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }
    private var isSignedIn: Bool { if case .signedIn? = model.auth { true } else { false } }
    private var warnings: [String] { if case .ready(let w) = model.host { w } else { [] } }
    private var authText: String {
        switch model.auth {
        case .signedIn(let plan)?: "Signed in" + (plan.map { " (\($0))" } ?? "")
        case .signedOut?: "Signed out"
        case .unsupported(let mode)?: "Unsupported sign-in: \(mode)"
        case nil: "Unknown"
        }
    }
    private var hostText: String {
        switch model.host {
        case .ready: "Ready"
        case .starting: "Starting"
        case .stopped: "Stopped"
        case .failed(let d): d
        }
    }
}

struct PrivacySettings: View {
    @Environment(AppModel.self) private var model
    @State private var confirmAutomatic = false
    var body: some View {
        Form {
            Picker("Claude session context", selection: Binding(
                get: { model.privacy?.sharingMode ?? .ask },
                set: { m in if m == .automatic { confirmAutomatic = true } else { Task { await model.setSharingMode(m) } } })) {
                ForEach(SharingMode.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.radioGroup)
            Text(modeHelp).font(.caption).foregroundStyle(.secondary)
            Section("Approved repositories") {
                if let notice = model.revokeNotice {
                    Banner(text: notice, tone: .warning, onDismiss: { model.dismissRevokeNotice() })
                }
                if model.privacy?.approvals.isEmpty ?? true {
                    Text("None yet. GPT gets repository tools only for repositories you approve.").foregroundStyle(.secondary)
                }
                ForEach(model.privacy?.approvals ?? []) { a in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(a.root).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
                            Text(a.includeWorktrees ? "Includes this repository's worktrees" : "This folder only").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Revoke") { Task { await model.revoke(root: a.root) } }
                    }
                }
            }
            Text(model.redactionNotice).font(.callout)
        }
        .formStyle(.grouped)
        .automaticModeConfirmation(isPresented: $confirmAutomatic)
    }
    private var modeHelp: String {
        switch model.privacy?.sharingMode ?? .ask {
        case .off: "Nothing from the Claude session is sent. GPT gets your question and, if approved, read-only repository tools."
        case .ask: "Before each question you see exactly what will be sent and can remove items."
        case .automatic: "The new part of the Claude session (capped at 12 KB, redacted) is sent without a preview."
        }
    }
}

struct SpeechSettings: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Form {
            LabeledContent("Speed") {
                HStack {
                    Slider(value: Binding(get: { model.settings.speechRate }, set: { model.setSetting(\.speechRate, ($0 * 4).rounded() / 4) }),
                           in: 0.5...2.0, step: 0.25)
                    Text(String(format: "%.2f×", model.settings.speechRate)).monospacedDigit().frame(width: 48)
                }
            }
            Picker("Voice", selection: Binding(get: { model.settings.voiceIdentifier ?? "" },
                                               set: { model.setSetting(\.voiceIdentifier, $0.isEmpty ? nil : $0) })) {
                Text("System default").tag("")
                ForEach(Self.voices, id: \.identifier) { v in Text(v.name + " (" + v.language + ")").tag(v.identifier) }
            }
            Toggle("Read each reply aloud when it finishes", isOn: Binding(get: { model.settings.autoPlay }, set: { model.setSetting(\.autoPlay, $0) }))
            Toggle("Read code blocks (otherwise it says \"code block omitted\")", isOn: Binding(get: { model.settings.readCode }, set: { model.setSetting(\.readCode, $0) }))
        }
        .formStyle(.grouped)
    }
    static var voices: [AVSpeechSynthesisVoice] {
        let lang = Locale.current.language.languageCode?.identifier ?? "en"
        return AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(lang) }.sorted { $0.name < $1.name }
    }
}

struct WindowSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(WindowStatus.self) private var status
    @State private var key = ""
    var body: some View {
        Form {
            Toggle("Follow the Claude window", isOn: Binding(get: { model.settings.followClaude }, set: { model.setSetting(\.followClaude, $0) }))
            Text("Uses the Accessibility permission only to read where Claude Desktop's window is, and keeps the panel against its left edge. Nothing in Claude is changed.")
                .font(.caption).foregroundStyle(.secondary)
            if let note = status.followNote { Text(note).font(.callout).foregroundStyle(.orange) }
            Section("Show or hide shortcut") {
                HStack {
                    Toggle("⌃", isOn: modifier(\.control))
                    Toggle("⌥", isOn: modifier(\.option))
                    Toggle("⇧", isOn: modifier(\.shift))
                    Toggle("⌘", isOn: modifier(\.command))
                    TextField("Key", text: $key).frame(width: 44).onChange(of: key) { applyKey() }
                }
                .toggleStyle(.button)
                Text("Now: " + model.settings.hotkey.display).font(.caption)
                if let e = status.hotkeyError { Text(e).font(.caption).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .onAppear { key = model.settings.hotkey.key }
    }
    private func modifier(_ kp: WritableKeyPath<HotkeySpec, Bool>) -> Binding<Bool> {
        Binding(get: { model.settings.hotkey[keyPath: kp] }, set: { v in
            var h = model.settings.hotkey
            h[keyPath: kp] = v
            if h.isValid { model.setSetting(\.hotkey, h) }
        })
    }
    private func applyKey() {
        var h = model.settings.hotkey
        h.key = String(key.uppercased().suffix(1))
        if h.isValid { model.setSetting(\.hotkey, h) }
    }
}

struct AdvancedSettings: View {
    @Environment(AppModel.self) private var model
    @AppStorage("nodePath") private var nodePath = ""
    var body: some View {
        Form {
            Picker("Open path:line in", selection: Binding(get: { model.settings.editor }, set: { model.setSetting(\.editor, $0) })) {
                ForEach(EditorChoice.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            TextField("Node.js path (empty = automatic)", text: $nodePath)
            Text("companiond needs Node.js 24 or newer. Empty uses /opt/homebrew/bin/node or /usr/local/bin/node. Restart companiond after a change.")
                .font(.caption).foregroundStyle(.secondary)
            LabeledContent("companiond") { Text(daemonText) }
            if model.isSecurityStop {
                Text("A security stop is waiting for you in the panel. Read it and acknowledge it there first.").font(.callout).foregroundStyle(.red)
            } else {
                HStack {
                    Button("Restart companiond") { Task { await model.restartDaemon() } }
                    Button("Restart Codex") { Task { await model.restartHost() } }
                }
            }
        }
        .formStyle(.grouped)
    }
    private var daemonText: String {
        switch model.connection {
        case .connecting: "Starting"
        case .connected(let v): "Running (version \(v))"
        case .stopped(let why): why
        }
    }
}
```

- [ ] **Step 6: Build and run the source rules**

Run: `cd app && swift build && swift test --filter SourceRulesTests`
Expected: build succeeds with no Swift 6 concurrency errors; `SourceRulesTests` PASS (no `print(`, no `LocalizedStringKey(`, no `AttributedString(markdown` outside `ReplyMarkdown.swift`, no banned Claude paths). The app target still launches the M0 window until Task 12.

- [ ] **Step 7: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionApp
git commit -m "feat(app): add the sidebar, preview, approval and settings views" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: App shell — panel, hotkey, follow window, lifecycle

**Files:**
- Create: `app/Sources/CompanionApp/SidePanel.swift`, `app/Sources/CompanionApp/HotkeyCenter.swift`, `app/Sources/CompanionApp/ClaudeWindowFollower.swift`, `app/Sources/CompanionApp/WindowCoordinator.swift`, `app/Sources/CompanionApp/AppDelegate.swift`
- Modify: `app/Sources/CompanionApp/CompanionApp.swift` (replace the M0 `WindowGroup`)
- Test: geometry and hotkey math are covered by Task 6; this task is verified by running the app (Step 4).

**Interfaces:**
- Consumes: Tasks 4 (`DaemonLocator.live`), 6, 7, 9, 10, 11.
- Produces: the running app. `WindowCoordinator { install(rootView:onWidthChange:); show(); toggle(); apply(_:onHotkey:); retryFollowIfNeeded() }`; `ClaudeWindowFollower { static let claudeBundleId = "com.anthropic.claudefordesktop"; onFrame; start() -> Bool; stop(); static func windowListBounds() -> CGRect? }`; `HotkeyCenter { register(_:action:) -> String?; unregister() }`.

- [ ] **Step 1: Panel and hotkey** — `app/Sources/CompanionApp/SidePanel.swift`:

```swift
import AppKit

/// The side panel (spec §8): a titled, resizable NSPanel at normal level (ruling 2), 280–640 pt wide.
final class SidePanel: NSPanel {
    init(content: NSView) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 360, height: 700),
                   styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                   backing: .buffered, defer: false)
        title = "ClaudeGPT Companion"
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        level = .normal
        collectionBehavior = [.fullScreenAuxiliary]
        contentMinSize = NSSize(width: 280, height: 320)
        contentMaxSize = NSSize(width: 640, height: CGFloat.greatestFiniteMagnitude)
        contentView = content
    }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
```

`app/Sources/CompanionApp/HotkeyCenter.swift`:

```swift
import Carbon.HIToolbox
import CompanionCore

/// Global show/hide shortcut through RegisterEventHotKey (spec §7.8, F13: no permission needed).
@MainActor final class HotkeyCenter {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var action: (@MainActor () -> Void)?

    /// nil on success, else a message for Settings › Window.
    func register(_ spec: HotkeySpec, action: @escaping @MainActor () -> Void) -> String? {
        unregister()
        guard let code = spec.carbonKeyCode, spec.isValid else { return "That shortcut is not valid." }
        self.action = action
        if handlerRef == nil {
            var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let refcon = Unmanaged.passUnretained(self).toOpaque()
            InstallEventHandler(GetApplicationEventTarget(), { _, _, refcon in
                guard let refcon else { return OSStatus(eventNotHandledErr) }
                let center = Unmanaged<HotkeyCenter>.fromOpaque(refcon).takeUnretainedValue()
                MainActor.assumeIsolated { center.action?() }
                return noErr
            }, 1, &type, refcon, &handlerRef)
        }
        let id = EventHotKeyID(signature: OSType(0x4347_5054), id: 1) // "CGPT"
        let status = RegisterEventHotKey(code, spec.carbonModifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef)
        return status == noErr ? nil : "Another app already uses \(spec.display). Choose another shortcut."
    }

    func unregister() {
        if let r = hotKeyRef { UnregisterEventHotKey(r) }
        hotKeyRef = nil
    }
}
```

- [ ] **Step 2: Claude window follower (public AX API, opt-in)** — `app/Sources/CompanionApp/ClaudeWindowFollower.swift`:

```swift
import AppKit
import ApplicationServices
import CompanionCore

/// Reads Claude Desktop's focused window frame (spec §8, D2). Read-only: no AX action, no attribute is ever set.
@MainActor final class ClaudeWindowFollower {
    static let claudeBundleId = "com.anthropic.claudefordesktop"
    var onFrame: ((CGRect?) -> Void)?
    private var observer: AXObserver?
    private var appElement: AXUIElement?
    private var window: AXUIElement?
    private var workspaceTokens: [NSObjectProtocol] = []

    /// False when Claude Desktop is not running (the follower attaches when it launches).
    func start() -> Bool {
        stop()
        let nc = NSWorkspace.shared.notificationCenter
        workspaceTokens = [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification].map { name in
            nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let id = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier
                MainActor.assumeIsolated { if id == Self.claudeBundleId { _ = self?.attach() } }
            }
        }
        return attach()
    }

    func stop() {
        detach()
        for t in workspaceTokens { NSWorkspace.shared.notificationCenter.removeObserver(t) }
        workspaceTokens = []
    }

    private func attach() -> Bool {
        detach()
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: Self.claudeBundleId).first else {
            onFrame?(nil)
            return false
        }
        var created: AXObserver?
        let callback: AXObserverCallback = { _, _, notification, refcon in
            guard let refcon else { return }
            let me = Unmanaged<ClaudeWindowFollower>.fromOpaque(refcon).takeUnretainedValue()
            let name = notification as String
            MainActor.assumeIsolated { me.handle(name) }
        }
        guard AXObserverCreate(app.processIdentifier, callback, &created) == .success, let obs = created else { return false }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(obs, element, kAXFocusedWindowChangedNotification as CFString, refcon)
        AXObserverAddNotification(obs, element, kAXMainWindowChangedNotification as CFString, refcon)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        observer = obs
        appElement = element
        watchFocusedWindow()
        return true
    }

    private func detach() {
        if let obs = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode) }
        observer = nil
        appElement = nil
        window = nil
    }

    private func handle(_ name: String) {
        if name == kAXFocusedWindowChangedNotification || name == kAXMainWindowChangedNotification { watchFocusedWindow() } else { report() }
    }

    private func watchFocusedWindow() {
        guard let obs = observer, let app = appElement else { return }
        if let w = window {
            AXObserverRemoveNotification(obs, w, kAXMovedNotification as CFString)
            AXObserverRemoveNotification(obs, w, kAXResizedNotification as CFString)
        }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
            window = nil
            onFrame?(nil)
            return
        }
        let w = value as! AXUIElement // type id checked above
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(obs, w, kAXMovedNotification as CFString, refcon)
        AXObserverAddNotification(obs, w, kAXResizedNotification as CFString, refcon)
        window = w
        report()
    }

    private func report() { onFrame?(window.flatMap(Self.frame(of:))) }

    private static func frame(of w: AXUIElement) -> CGRect? {
        var p: CFTypeRef?
        var s: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &p) == .success,
              AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &s) == .success,
              let p, let s, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return PanelGeometry.appKitRect(fromTopLeft: CGRect(origin: origin, size: size),
                                        primaryScreenHeight: NSScreen.screens.first?.frame.height ?? 0)
    }

    /// Claude's front window bounds without any permission (window geometry only; ruling 16).
    static func windowListBounds() -> CGRect? {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: claudeBundleId).first,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier && (w[kCGWindowLayer as String] as? Int) == 0 {
            if let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b as CFDictionary) {
                return PanelGeometry.appKitRect(fromTopLeft: r, primaryScreenHeight: NSScreen.screens.first?.frame.height ?? 0)
            }
        }
        return nil
    }
}
```

- [ ] **Step 3: Coordinator, delegate, app** — `app/Sources/CompanionApp/WindowCoordinator.swift`:

```swift
import AppKit
import ApplicationServices
import CompanionCore
import SwiftUI

@MainActor final class WindowCoordinator {
    private let status: WindowStatus
    private let follower = ClaudeWindowFollower()
    private let hotkeys = HotkeyCenter()
    private var panel: SidePanel?
    private var width = PanelGeometry.defaultWidth
    private var wantFollow = false
    private var following = false
    private var registered: HotkeySpec?
    private var resizeObserver: NSObjectProtocol?

    init(status: WindowStatus) {
        self.status = status
        status.accessibilityTrusted = AXIsProcessTrusted()
    }

    func install(rootView: some View, onWidthChange: @escaping @MainActor (CGFloat) -> Void) {
        let p = SidePanel(content: NSHostingView(rootView: rootView))
        panel = p
        resizeObserver = NotificationCenter.default.addObserver(forName: NSWindow.didEndLiveResizeNotification, object: p, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let p = self.panel else { return }
                self.width = p.frame.width
                onWidthChange(p.frame.width)
            }
        }
        let claude = ClaudeWindowFollower.windowListBounds()
        if let screen = claude.flatMap(Self.screen(containing:)) ?? NSScreen.main {
            p.setFrame(PanelGeometry.dockedFrame(width: width, claudeFrame: nil, visibleFrame: screen.visibleFrame), display: true)
        }
    }

    func show() {
        panel?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func toggle() {
        guard let p = panel else { return }
        if p.isVisible && p.isKeyWindow { p.orderOut(nil) } else { show() }
    }

    func apply(_ s: UISettings, onHotkey: @escaping @MainActor () -> Void) {
        let w = PanelGeometry.clampWidth(CGFloat(s.panelWidth))
        if let p = panel, abs(p.frame.width - w) > 1 {
            var f = p.frame
            f.size.width = w
            p.setFrame(f, display: true)
        }
        width = w
        if registered != s.hotkey {
            status.hotkeyError = hotkeys.register(s.hotkey, action: onHotkey)
            registered = s.hotkey
        }
        if s.followClaude != wantFollow {
            wantFollow = s.followClaude
            setFollow(s.followClaude, prompt: true)
        }
    }

    /// After the user grants Accessibility in System Settings and comes back.
    func retryFollowIfNeeded() {
        if wantFollow && !following { setFollow(true, prompt: false) }
    }

    private func setFollow(_ on: Bool, prompt: Bool) {
        guard on else {
            follower.stop()
            following = false
            status.followNote = nil
            return
        }
        let trusted = prompt ? AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary) : AXIsProcessTrusted()
        status.accessibilityTrusted = trusted
        guard trusted else {
            status.followNote = "Allow ClaudeGPT Companion in System Settings › Privacy & Security › Accessibility. Until then the panel is a normal window you can move."
            return
        }
        following = true
        follower.onFrame = { [weak self] frame in self?.place(claudeFrame: frame) }
        status.followNote = follower.start() ? nil : "Claude Desktop is not running. The panel follows it once it opens."
    }

    private func place(claudeFrame: CGRect?) {
        guard let p = panel, let screen = claudeFrame.flatMap(Self.screen(containing:)) ?? p.screen ?? NSScreen.main else { return }
        p.setFrame(PanelGeometry.dockedFrame(width: width, claudeFrame: claudeFrame, visibleFrame: screen.visibleFrame), display: true)
    }

    private static func screen(containing r: CGRect) -> NSScreen? {
        func overlap(_ s: NSScreen) -> CGFloat { let i = s.frame.intersection(r); return i.isNull ? 0 : i.width * i.height }
        return NSScreen.screens.filter { overlap($0) > 0 }.max { overlap($0) < overlap($1) }
    }
}
```

`app/Sources/CompanionApp/AppDelegate.swift`:

```swift
import AppKit
import CompanionCore
import SwiftUI

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    let model: AppModel
    let readAloud = ReadAloudController(synth: AVSpeechAdapter())
    let dictation = DictationController(engine: SpeechAnalyzerEngine(), permissions: SystemDictationPermissions())
    let windowStatus: WindowStatus
    let window: WindowCoordinator
    private var observers: [NSObjectProtocol] = []

    override init() {
        model = AppModel(connector: DaemonLocator.live(
            env: ProcessInfo.processInfo.environment,
            configuredNode: { UserDefaults.standard.string(forKey: "nodePath") },
            resourceURL: Bundle.main.resourceURL))
        let status = WindowStatus()
        windowStatus = status
        window = WindowCoordinator(status: status)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)
        let root = SidebarView()
            .environment(model).environment(readAloud).environment(dictation).environment(windowStatus)
        window.install(rootView: root, onWidthChange: { [weak self] w in self?.model.setSetting(\.panelWidth, Double(w)) })
        model.onSettingsChanged = { [weak self] s in self?.apply(s) }
        model.onReplyCompleted = { [weak self] id, text in self?.readAloud.play(id: id, markdown: text) }
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if let self { Task { await self.model.refresh() } } }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.window.retryFollowIfNeeded() }
        })
        apply(model.settings)
        window.show()
        Task { await model.start() }
    }

    private func apply(_ s: UISettings) {
        readAloud.rateMultiplier = s.speechRate
        readAloud.voiceIdentifier = s.voiceIdentifier
        readAloud.readCode = s.readCode
        window.apply(s, onHotkey: { [weak self] in self?.window.toggle() })
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        readAloud.stop()
        Task {
            if dictation.isRecording { await dictation.stop() }
            await model.shutdown()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.show()
        return true
    }
}
```

Replace `app/Sources/CompanionApp/CompanionApp.swift` with:

```swift
import CompanionCore
import SwiftUI

@main
struct CompanionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Settings {
            SettingsView()
                .environment(delegate.model)
                .environment(delegate.readAloud)
                .environment(delegate.dictation)
                .environment(delegate.windowStatus)
        }
        .commands {
            CommandGroup(after: .sidebar) {
                Button("Show or Hide Panel") { delegate.window.toggle() }
                Button("Refresh Sessions") { Task { await delegate.model.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}
```

- [ ] **Step 4: Build, bundle and check by hand**

Run: `cd app && swift build && swift test && cd .. && bash scripts/build-app.sh && open "app/build/ClaudeGPT Companion.app"`
Expected: all tests PASS; the bundle verifies; the panel opens at the left edge of the screen with Claude's window. With `COMPANIOND_CODEX=off` in the environment (`COMPANIOND_CODEX=off open …` does not pass it; launch the binary directly: `COMPANIOND_CODEX=off "app/build/ClaudeGPT Companion.app/Contents/MacOS/CompanionApp"`) the panel shows "Chat is off" with the daemon's reason, which checks the stopped path without Codex. Check, and note each result for the Task 14 checklist:
- ⌥⌘G hides and shows the panel; ⌘R works when the app is active; ⌘, opens Settings with five tabs.
- Width drags between 280 and 640 pt and is remembered after relaunch (once the daemon runs).
- Settings › Window › Follow: the Accessibility prompt appears; with permission the panel moves with Claude's window; without it the note explains and the panel stays movable.
- Light and dark appearance both read well (System Settings › Appearance).
Quit with ⌘Q; `pgrep -f companiond/src/daemon/main.ts` prints nothing within 5 s.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionApp
git commit -m "feat(app): add the side panel, hotkey, follow-window and app lifecycle" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Re-check the daemon contract and run against the real daemon

M4b part 2 merged (PR #10) and this plan was reconciled with it on 2026-11-05. This task repeats that check against whatever `main` holds when implementation reaches it, then runs the app for real.

**Files:**
- Modify, only where `main` now differs from "Daemon API (reconciled with merged M4b)": `app/Sources/CompanionCore/Daemon/DaemonModels.swift`, `app/Sources/CompanionCore/Daemon/DaemonClient.swift`, `app/Sources/CompanionCore/Model/AppModel.swift`, their tests; that section of this plan.

- [ ] **Step 1: Update the branch from main** — sync with `main` (in an app-made worktree use the `sync_with_base_branch` tool; otherwise `git fetch origin && git merge origin/main`). Then `cd companiond && npm ci && npm test`. Expected: green.

- [ ] **Step 2: Diff the contract against the merged code, not the plan text** — compare `companiond/src/daemon/protocol.ts` (`METHODS`, `EVENTS`, `ErrorCodes`, `SECURITY_FAILED_PREFIX`), `handlers.ts` (`buildHandlers` param names and defaults — `chat.send`'s `confirmed`, `privacy.revoke`'s `{revoked, pendingClose}` — `wirePrepared`, `wireEvents`, `toDaemonError`), `chat/chatService.ts` (`Prepared`) and `store/store.ts` (`UI_KEY`) against "Daemon API (reconciled with merged M4b)". If nothing changed since a1947ea (`git diff a1947ea origin/main -- companiond/src/daemon companiond/src/chat/chatService.ts companiond/src/store/store.ts` is empty), skip to Step 3. For each difference: change the Swift mirror and its test first (failing test, then fix), and update that section. Confirm the reconciled items still hold: `"abandoned"` turn status (N1), `hostBusy` 1009 (N2), `prepareStale` 1010 and `confirmRequired` 1011 (N3, N3b), `pendingClose` (N6), `host.acknowledgeSecurityStop` and `host.restart`'s 1001, `chat.threadReplaced`, `Prepared.sessionTitle`.

- [ ] **Step 3: Full tests, including the daemon integration test**

Run: `cd app && swift test`
Expected: PASS, with `DaemonIntegrationTests/answersOverStdioThenShutsDown` run, not skipped.

- [ ] **Step 4: Live run from the bundle (N4)** — `bash scripts/build-app.sh && open "app/build/ClaudeGPT Companion.app"`. With Claude Code Desktop open on a session in an approved repo:
1. The header shows that session's title, root and live branch, status dot and "Live" sync.
2. If signed out, "Sign in with ChatGPT" opens the browser; the **owner** signs in (an agent never enters credentials). `auth.changed` flips the panel to chat.
3. Ask "Which file did Claude change last, and why?" in Ask mode: the preview lists items; remove one; Send. The reply streams, cites `path:line`, and "View what was sent" shows the context without the removed item.
4. Click a `path:line` link: the editor opens that file at that line.
5. Settings › Advanced shows "Running (version …)".
Record the outcome lines (no reply text, repo as `<repo>`) in the shared notes folder and in `docs/manual/m5-checklist.md` (Task 14).

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore app/Tests/CompanionCoreTests docs/superpowers/plans/2026-11-05-m5-swiftui-app.md
git commit -m "fix(app): reconcile the daemon client with the merged M4b API" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Checklist, primary acceptance test, spec, roadmap, PR

**Files:**
- Create: `scripts/tree-hash.sh`, `docs/manual/m5-checklist.md`
- Modify: `docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md` (this plan's "Spec changes"), `docs/superpowers/plans/README.md`

- [ ] **Step 1: The repo fingerprint** — `scripts/tree-hash.sh` (read-only: no git command here writes, and optional locks are off):

```bash
#!/usr/bin/env bash
# Read-only fingerprint of a repository for the primary acceptance test (spec §12.4): every file in the working
# tree (tracked, untracked and ignored; .git excluded), symlink targets, the index, HEAD, refs and packed-refs.
# Usage: scripts/tree-hash.sh <repo root>   Prints one SHA-256. Run before and after; the two must match.
set -euo pipefail
root="${1:?usage: scripts/tree-hash.sh <repo root>}"
cd "$root"
export GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 LC_ALL=C
git_dir="$(/usr/bin/git rev-parse --absolute-git-dir)"
common_dir="$(/usr/bin/git rev-parse --path-format=absolute --git-common-dir)"
{
  find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 shasum -a 256
  find . -path ./.git -prune -o -type l -print0 | sort -z | xargs -0 -I{} sh -c 'printf "%s -> %s\n" "$1" "$(readlink "$1")"' _ {}
  shasum -a 256 "$git_dir/index" "$git_dir/HEAD"
  /usr/bin/git for-each-ref --format='%(refname) %(objectname)'
  if [ -f "$common_dir/packed-refs" ]; then shasum -a 256 "$common_dir/packed-refs"; fi
} | shasum -a 256 | cut -d' ' -f1
```

Run: `chmod +x scripts/tree-hash.sh && a=$(bash scripts/tree-hash.sh .) && b=$(bash scripts/tree-hash.sh .) && test "$a" = "$b" && echo stable`
Expected: `stable`.

- [ ] **Step 2: The checklist** — `docs/manual/m5-checklist.md`:

```markdown
# M5 manual checklist (spec §12.3, §12.4, §14 M5)

Run on this Mac with the signed bundle (`bash scripts/build-app.sh`). Record each result as PASS / FAIL / NOT RUN
with a short note. No personal data: write repository paths as `<repo>`, never paste reply or transcript text.
Rows marked **Owner** need the owner at the Mac (speaking, listening, signing in).

| # | Check | Who | Result |
|---|-------|-----|--------|
| 1 | First dictation asks for Microphone, then Speech Recognition; denying either shows the System Settings hint | Owner | |
| 2 | Dictation: red mic while recording, live grey text, final text lands in the field and can be edited before Send | Owner | |
| 3 | Missing speech assets download with a progress line | Owner | |
| 4 | `COMPANION_SPEECH_TESTS=1 swift test --filter "DictationTests\|ReadAloudTests"` (clip transcription, delegate sequence) | Agent | |
| 5 | Read Aloud is audible; pause, resume and stop act at word boundaries; a new 🔊 stops the old one | Owner | |
| 6 | Speed 0.5× and 2× sound slower and faster; voice choice applies; auto-play reads a finished reply; "read code" on/off | Owner | |
| 7 | ⌥⌘G toggles the panel; a changed shortcut works; a taken shortcut shows the message | Agent | |
| 8 | Follow window on: Accessibility prompt; the panel stays flush left of Claude while Claude moves and resizes; off: normal window | Agent | |
| 9 | Accessibility denied: the note explains and the panel stays movable | Agent | |
| 10 | Light and dark appearance | Agent | |
| 11 | Ask mode: preview lists items; a removed item is absent in "View what was sent"; Cancel sends nothing | Agent | |
| 12 | Off sends no Claude context (View what was sent shows only the repository line); Automatic needs the confirmation | Agent | |
| 13 | An unapproved repo shows the banner; Approve works; approving the home folder is refused with the plain reason; revoking a repo while a reply runs in it shows "still finishing" in Settings › Privacy | Agent | |
| 14 | Reply links are not clickable and show their URL; no image loads; clicking `path:line` in a selectable reply reaches the app's handler and opens the editor at the line; a `path:line` to a `.command` or `.app` inside the repo is only revealed in Finder | Agent | |
| 14b | Security stop: the panel shows the reason and only "acknowledge and restart" clears it; Settings hides the restart buttons meanwhile | Agent | |
| 14c | Ask mode refuses to send without the sheet (a send from the sheet carries `confirmed: true`); "Send again" after a busy error reuses the prepare | Agent | |
| 15 | Quit stops companiond within 5 s (`pgrep -f companiond/src/daemon/main.ts` empty) | Agent | |
| 16 | **Primary acceptance test** (below) | Owner | |

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
```

- [ ] **Step 3: Run what the agent can** — rows marked Agent, plus row 4. Fill the Result column. Leave Owner rows as NOT RUN with "needs the owner". The implementation PR stays a draft until the owner fills them.

- [ ] **Step 4: Spec and roadmap** — apply this plan's "Spec changes" 1–5 to the spec (§2, §7.8, §8, §9) and add to the §14 M5 row: "*M5: implemented; acceptance test: see docs/manual/m5-checklist.md*". In `docs/superpowers/plans/README.md` set the M5 row status to "implemented; owner checklist pending" (and "done" only after the owner's rows pass and the PR merges).

- [ ] **Step 5: Final checks and commit**

Run: `cd app && swift test && cd ../companiond && npm test && npm run typecheck && cd .. && bash scripts/build-app.sh && bash scripts/check-repo.sh`
Expected: all green.

```bash
git add scripts/tree-hash.sh docs/manual/m5-checklist.md docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md docs/superpowers/plans/README.md
git commit -m "docs(m5): add the manual checklist, the acceptance fingerprint and the M5 spec changes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Push and open a draft PR**

```bash
git push origin feat/m5-swiftui-app
gh pr create --draft --base main --head feat/m5-swiftui-app --title "feat: M5 — SwiftUI app + speech (first usable release)" --body "Implements docs/superpowers/plans/2026-11-05-m5-swiftui-app.md. Daemon API reconciled with merged M4b (Task 13). Checklist: docs/manual/m5-checklist.md (owner rows pending).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: a draft PR URL. The owner runs the Owner rows, then reviews and merges.

---

## Self-review

- **Spec coverage (§14 M5: panel, hotkey, chat, picker, refresh, preview sheet, approvals, settings, follow-window opt-in, dictation, Read Aloud, §12.3 tests; mic/playback checklist; primary acceptance test):**
  - Panel (§8: NSPanel, left on Claude's screen, 280–640 pt): Tasks 6, 12. Hotkey ⌥⌘G, configurable, `RegisterEventHotKey` (§7.8, F13): Tasks 6, 11 (settings), 12.
  - Header (§8: title, root + live branch, status dot, sync, 🔒 Read-only, sharing chip, picker, refresh): Tasks 7 (`+Display`), 11. Live branch re-read after each turn: Task 7 (`turnCompleted` reloads the worktree).
  - Picker grouped Busy / Idle / Recent, searchable; pin; focus label; "Claude focus moved to X — switch?"; pinned-missing (§6.2): Tasks 7, 11. Refresh button, ⌘R, wake (§6.2): Tasks 7, 12. "Claude Desktop sessions not found" (§6.2): Task 11 banner.
  - Repo change banner, Unavailable with no fallback, approval of the exact toplevel with optional worktrees, refusal reasons (§6.3, §7.5): Tasks 7, 11.
  - Chat: bubbles, Markdown + code, clickable `path:line`, "Explain Claude's last message", stop (§8): Tasks 5, 7, 8, 11. No remote images (§7.1.9 vi-a): Task 8.
  - Sharing modes Off / Ask (default, preview with remove toggles) / Automatic; "View what was sent"; REDACTION_NOTICE; never raw transcripts automatically (§4.3, §7.4, §7.5): Tasks 7, 11, Global Constraints.
  - Account: "Sign in with ChatGPT", no API keys, unsupported auth disables chat (§5): Tasks 7 (gate), 11.
  - Security alerts and "Security check failed" (§7.1): Tasks 7, 11.
  - Speech (§8, §9): 🔊 play / pause / resume / stop, speed 0.5×–2×, voice, auto-play, code omitted unless chosen: Tasks 9, 11. Dictation with SpeechAnalyzer + SpeechTranscriber only, continuous, volatile live, final editable, assets with progress: Task 10.
  - Follow window (D2, §8): opt-in, public AX, works without permission: Tasks 6, 12.
  - §12.3 tests: dictation clip (Task 10, opt-in), delegate sequence / rate / stripping / `write` buffer (Task 9, M0), follow-window geometry (Task 6), message codec (Tasks 1–3).
  - §12.4: real mic and playback checklist, acceptance test with before/after hashes, light/dark, hotkey, follow on/off, permission-denied paths: Task 14.
  - §7.7 / §7.8 preservation and permissions: Global Constraints, Task 1 source rules, Task 4 (minimal env, stderr dropped), Task 12 (AX read-only).
- **Placeholder scan:** the only open values are measured results (Task 13 Step 4, Task 14 checklist) and run-time arguments (`<repo>`).
- **Type consistency:** `DaemonAPI` method names (Task 3) are the ones `FakeDaemon` (Task 7) and `AppModel` use; `Connection`/`Connector` (Task 3) → `DaemonLocator.live` (Task 4) → `AppDelegate` (Task 12); `UISettings` keys (Task 6) → `AppModel.setSetting` (Task 7) → Settings views (Task 11); `TurnEvent`/`Conversation` (Task 5) → `AppModel.route` (Task 7); `SpeechSynthesizing.stop(atWordBoundary:)` (Task 9) used by the controller and the adapter; `DictationEngine.start(_:)` (Task 10) used by `FakeEngine` and `SpeechAnalyzerEngine`; `FileReference.init(path:line:)` public (Task 8) used by `ReplyView` (Task 11); `WindowStatus` (Task 11) written by `WindowCoordinator` (Task 12).

## Interfaces produced for M6 / M7

- M6 (Jira) adds no app surface beyond what the daemon reports: Jira items would arrive as more preview items (`PreviewItem.kind`) and more `security.alert` kinds, both already rendered generically. A Jira sign-in, if it needs the browser, follows the `auth.login` pattern (an `https` URL the app opens).
- M7 (packaging) replaces ruling 1: bundle Node inside the app (then `DaemonLocator.nodeCandidates` gets the bundled path first), notarize, and decide whether nested code under `Contents/Resources/companiond` must be signed separately. The bundle layout (`Contents/Resources/companiond/src/daemon/main.ts`) stays.
