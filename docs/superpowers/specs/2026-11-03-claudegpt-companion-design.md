# ClaudeGPT Companion — design

Status: **draft for review** · Date: 2026-11-03 · Based on: `docs/findings/2026-11-03-phase1-poc.md`

## 1. Goal

A native macOS sidebar that sits to the LEFT of the unchanged Claude Code Desktop app. It gives you a
ChatGPT-style chat, powered by your ChatGPT Plus subscription through the official Codex app-server,
that can see what the focused Claude session is doing and read (never write) the same repository.

Claude Code stays the coding agent. The companion explains, researches and answers questions.

**Non-goals (v1):** orchestrating Claude, writing code (Codex coding mode), live terminal PTY access,
OpenAI API keys, paid speech APIs, modifying anything Claude owns.

## 2. Architecture

```
┌──────────────────────────── ClaudeGPT Companion.app ────────────────────────────┐
│  SwiftUI shell (thin)                                                           │
│   • side panel window, chat UI, markdown, session picker, settings              │
│   • mic → SpeechAnalyzer/SpeechTranscriber (fallback SFSpeechRecognizer)        │
│   • Read Aloud → AVSpeechSynthesizer                                            │
│        │  JSON lines over stdio (child process, no network port)                │
│  companiond (Node/TypeScript, all logic, fully unit-tested)                     │
│   ├─ SessionBridge   reads Claude Desktop records + JSONL transcripts (RO)      │
│   ├─ ContextBuilder  delta since last send → filter → redact → preview          │
│   ├─ CodexClient     drives `codex app-server` (stdio JSON-RPC)                 │
│   ├─ Store           SQLite (node:sqlite) — threads, cursors, approved roots    │
│   └─ Policy          approved roots, deny-list, redaction rules                 │
│        │ spawns                                                                 │
│  codex app-server  (own CODEX_HOME, ChatGPT login in Keychain)                  │
│   └─ spawns MCP: companion-readonly (repo jail)   + Atlassian MCP (read tools)  │
└─────────────────────────────────────────────────────────────────────────────────┘
        reads only ▲                                        ▲ reads only
  ~/.claude/projects/…jsonl, ~/.claude/sessions/<pid>.json,   approved repo/worktree
  ~/Library/Application Support/Claude/claude-code-sessions/
```

**Why this split (validated in Phase 1):** `swift test` does not run on this Mac's Command Line Tools,
while `node --test` does. Putting the bridge, redaction, jail and Codex protocol in TypeScript makes
the risky parts testable today. Swift does only what must be native: windows, mic, speech.

Alternatives considered:
- *Swift-only, talking to app-server directly* — one language, but untestable without Xcode and the
  MCP server would still need a second process. Rejected for v1.
- *Electron/Tauri* — not native, heavier, poorer speech integration. Rejected.

## 3. Components

| Unit | Does | Depends on |
|------|------|-----------|
| `SessionBridge` | Lists desktop records, maps `cliSessionId` → transcript path (encoded `cwd`, then glob fallback), marks running/busy from `~/.claude/sessions/<pid>.json` (pid alive check), picks focused by max `lastFocusedAt`, tails JSONL with `fs.watch` + byte offsets. | filesystem only |
| `TranscriptParser` | Turns JSONL lines into typed events: user text, assistant text, tool call (name, input), tool result (stdout/stderr/exit, trimmed), file edit, subagent event. Ignores `api-request*`, `attachment` bodies, unknown types. | — |
| `ContextBuilder` | For a question, builds a delta since the thread's cursor: recent turns, last assistant message, Bash commands + trimmed output + exit code, files changed, subagent summaries. Caps size, redacts, wraps in `<untrusted_claude_session>` tags. Returns text + preview. | parser, `Redactor` |
| `Redactor` | Masks tokens/keys (AWS, GitHub, OpenAI, Slack, JWT, PEM blocks, `password=`, connection strings, high-entropy strings). | — |
| `CodexClient` | `initialize`, `account/*` login, `thread/start|resume`, `turn/start|interrupt`, streams deltas, declines every approval request. | `codex` binary |
| `companion-readonly` MCP | `list_dir`, `read_file` (line numbers, ranges), `search` (`git grep -F`), `git_status`, `git_diff`, `find_definition` (ripgrep-free symbol search via `git grep -w`). Containment check *before* resolve, realpath, deny-list, size caps, approved roots only. | `git` |
| `Store` | SQLite in `~/Library/Application Support/ClaudeGPTCompanion/companion.db` (0600): `claude_session → codex_thread_id`, transcript cursor, approved roots, pins, settings. Chat history itself lives in Codex threads (`thread/resume` with turn pagination). | `node:sqlite` |
| SwiftUI shell | Window, chat, picker, indicators, settings, speech. Talks to companiond with a small typed message set. | AppKit/SwiftUI, Speech, AVFoundation |

## 4. Data flow — asking a question

1. UI shows the focused Claude session (or your pinned one) with a status dot: selected / busy / recent.
2. You type or dictate a question. The editable transcription is shown before you send.
3. companiond builds the context delta since the last cursor for that session and shows a
   **"Context to send" preview** (collapsible; on by default for the first send of each session).
4. companiond sends one `turn/start` to that session's Codex thread: context block + your question.
5. Codex may call `companion-readonly` tools on the session's `cwd` (must be an approved root).
6. Deltas stream to the UI; markdown renders; `path:line` references become clickable (open in your editor).
7. Cursor advances only after the turn completes, so nothing is resent unless you ask.

Switching Claude sessions switches the Codex thread; each one keeps its own history.

## 5. Authentication

- First run: "Sign in with ChatGPT" → `account/login/start {type:"chatgpt"}` → browser → done.
- Token stored by Codex in the macOS Keychain (`cli_auth_credentials_store = "keyring"`), in the
  companion's own `CODEX_HOME`. The companion never reads or logs the token.
- If `account/read` returns no account or a non-ChatGPT mode, chat is disabled with a clear "sign in"
  prompt. There is **no** API-key path in the UI.
- Usage counts against your Plus plan's Codex limits; `account/rateLimits/read` is shown in settings.

## 6. Session mapping and tailing

- Desktop record → `cliSessionId` → `~/.claude/projects/<encoded cwd>/<cliSessionId>.jsonl`; fallback
  glob `~/.claude/projects/*/<cliSessionId>.jsonl`. Do not use `lastAssistantCliSessionId`.
- Tail rules: keep a byte offset; buffer until `\n` (partial lines); if the size shrinks or the inode
  changes, re-read from the start and re-derive the cursor by record `uuid`; debounce `fs.watch` bursts;
  re-check on focus change.
- Subagents: read `<cliSessionId>/subagents/*.jsonl`, summarise only (name, goal, final message).
- Format drift: the parser tolerates unknown record types and shows "transcript format changed" if no
  known records are found.

## 7. Security model

Read-only is enforced in layers, so a prompt-injected model still cannot write or leak:

1. **No Codex shell.** `shell_tool`, `unified_exec` and other built-ins disabled in config.
2. **Sandbox + approvals.** `sandbox: "read-only"`, `approvalPolicy: "untrusted"`; companiond answers
   every approval request with `decline` and every other server request with an error.
3. **Tool allowlist.** Only `companion-readonly` tools and Atlassian *read* tools via `enabled_tools`.
4. **Repo jail.** Only roots you approved in the UI; containment check first; realpath (no symlink
   escape); deny-list (`.env*`, `*.pem`, `*.key`, `id_*`, `.ssh`, `.aws`, `.git` internals,
   `node_modules`, `credentials*`, `secret*`, `.npmrc`, `.netrc`); size caps.
5. **Claude data.** Read only the three locations in §6. Never `~/.claude/sessions/*.key`, the
   messaging socket, `~/.claude.json`, Claude credentials, or settings. Never write under `~/.claude`
   or Claude's Application Support.
6. **Prompt injection.** Transcript, file, terminal and Jira text is wrapped as untrusted data; the
   developer instructions say it never overrides rules. Layers 1–4 make that a defence in depth, not
   the only defence.
7. **Redaction + preview** before anything leaves the Mac. Raw full transcripts are never sent.
8. **Local storage.** App Support dir 0700, DB 0600, no secrets in the DB or logs.
9. **macOS permissions:** microphone and speech recognition only, requested on first use.
   Accessibility is **optional**, only for "follow Claude's window" (§8).

## 8. UI

- Side panel (`NSPanel`), docked to the left edge of the screen Claude is on; resizable width
  (280–640 pt, remembered); global hide/show shortcut (default ⌥⌘G, configurable).
- **Optional "follow Claude window"** (opt-in, needs Accessibility permission): reads Claude's window
  frame through the public Accessibility API and keeps the panel beside it. Without it, the panel stays
  where you put it. No private window-management APIs.
- Header: session title + repo/branch, status dot, sync status ("up to date · 3 new events"),
  🔒 "Read-only" badge, session picker (focused / pinned / recent / busy).
- Chat: ChatGPT-style bubbles, markdown + code, clickable `path:line`, "Explain Claude's last message"
  quick action, stop button while streaming.
- Each reply: 🔊 Read Aloud (play/pause/resume/stop), speed slider, voice picker in settings,
  optional auto-play. Speech text strips markdown and skips code blocks (says "code block omitted").
- Input: text field, 🎙 mic (red recording indicator, live transcript, editable before send).
- Settings: account, speech, privacy (preview on/off, redaction rules, approved roots), context size,
  Jira connection. Light/dark follow the system.

## 9. Jira (milestone 4)

- Add the official Atlassian remote MCP server (`https://mcp.atlassian.com/v2/mcp`) to the companion's
  Codex config; OAuth through app-server's MCP OAuth flow (`mcpServer/oauthLogin/completed`).
- `enabled_tools` = read tools only (search issues, get issue, get comments, read project metadata).
  Before shipping: a test that lists the server's tools through `mcpServerStatus/list` and **fails** if
  any create/edit/transition/comment/worklog tool is visible.

## 10. Technical risks

| Risk | Mitigation |
|------|-----------|
| Claude transcript format changes | tolerant parser, version shown in UI, fixture tests from real-shaped (synthetic) records |
| Codex app-server is marked experimental; flags change | pin the `@openai/codex` version; startup self-check that `shell_tool` is off and the tool list matches the allowlist, else refuse to chat |
| Plus plan rate limits | show limits; keep context deltas small |
| `enabled_tools` not enforced for remote MCP | allowlist test (§9); if it fails, proxy Atlassian through our own MCP exposing read tools only |
| No Xcode → no Swift tests | keep Swift thin; manual checklist; recommend installing Xcode |
| Live terminal output not available | transcript-based only; documented |
| Speech differences across macOS versions | SpeechTranscriber on 26+, SFSpeechRecognizer on 15 |

## 11. Testing

- `node --test` for companiond: parser fixtures (partial lines, truncation, rotation, unknown types),
  mapping, redactor, jail (traversal, symlink escape, deny-list incl. `.env`, size caps), context
  builder (delta only, caps), CodexClient against a fake app-server (approval declined, streaming,
  resume).
- Permission-boundary tests: no write APIs reachable; every approval declined; config self-check.
- Live smoke test (manual, needs login): login → two turns → resume → attack prompt.
- Swift: build check + manual macOS checklist (window, shortcut, mic permission, TTS controls,
  light/dark). Swift unit tests once Xcode is installed.

## 12. Milestones

1. **M1 — companiond core:** bridge, parser, redactor, jail MCP, Codex client, store, CLI harness. Tests.
2. **M2 — minimal usable app:** SwiftUI panel + chat + session picker + read-only badge + preview,
   `.app` bundle script. *(Claude session → bridge → persistent GPT chat → repo reads.)*
3. **M3 — speech:** mic dictation and Read Aloud.
4. **M4 — Jira:** Atlassian MCP read-only + allowlist test.
5. **M5 — terminal context polish:** test-failure and build-output summarising.
6. **M6 — packaging:** install script, README, signing notes, release.

## 13. Decisions needed from you

1. **Xcode:** install full Xcode (free, ~15 GB) so the Swift side gets unit tests? Recommended, not blocking.
2. **"Follow Claude window"** with Accessibility permission as an opt-in in M2, or leave it for later?
3. **License:** MIT (assumed, since you want anyone to use it).
