# M8 — Sidebar redesign, copy and history Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the v0.7.0 sidebar into a first-party-feeling macOS 26 panel where every message can be selected and copied, every turn shows what was sent and what came back (kept across launches), and the context picker sends the user's own conversation before subagent noise.

**Architecture:** companiond gains a `turns` table (schema v2) that records each sent turn (redacted question, the exact context block, the sent items, the answer, status) and three read methods plus `chat.newChat`. The context builder picks items by priority tier under the unchanged 12 KB cap. The app restores the current chat from history on session select, shows a per-turn "Context sent" disclosure, a history list of past chats (read-only), and a redesigned SwiftUI surface (glass header and composer, status line, empty state, Markdown with highlighted code, copy everywhere).

**Tech Stack:** Swift 6.2 / SwiftUI on macOS 26 (CI: Xcode on `macos-26`; no APIs newer than macOS 26), Node 24 + TypeScript (`node:sqlite`), `node --test`, Swift Testing.

**Spec:** `docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md` (v3.6) plus the owner verdict in the M8 task brief (quoted in the PR). Rulings are in the shared-notes ledger `m8-sdd-ledger.md` and summarized below.

## Global Constraints

- Do not weaken the Seatbelt profile, the tool allowlist, redaction, the `<untrusted_data>` wrapping, or the Ask-mode "Check what GPT will see" approval (`confirmed: true` only from that sheet).
- The context cap stays `DEFAULT_CAPS = { totalBytes: 12 * 1024, textChars: 2000, toolChars: 1500, maxItems: 40 }`.
- No API keys; no secret or token logging; no `print(`/`NSLog(`/`debugPrint(`/`dump(` in app sources (SourceRulesTests).
- Untrusted text is never parsed as a `LocalizedStringKey`; Markdown is parsed only in `ReplyMarkdown.swift`.
- Never read Claude credentials, `~/.claude/sessions/*.key`, the messaging socket; never change Claude config.
- Public repo: no personal data, no `/Users/<name>/` paths, no emails (`scripts/check-repo.sh`). Screenshots show only synthetic fixture content.
- macOS 26 deployment target; only APIs available in the macOS 26 SDK (CI runs `macos-26`).
- Commit trailer, literally: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- companion.db "holds no secrets": everything written to `turns` passes through `redact()` first.

## Rulings (design and scope, made by the M8 session)

| # | Ruling | If wrong |
|---|---|---|
| R1 | A "chat" is one Codex thread of one Claude session. ⌘K / New chat ends the session's current thread (closes it, clears the stored thread and the context cursor) so the next question starts a fresh thread that again gets the newest context. | New chat would need a different store key; cheap to change. |
| R2 | History is kept by companiond in companion.db (`turns`, schema v2). Question and answer are passed through `redact()` before storage; the context block is stored exactly as sent (already redacted). 200 turns per chat, 2,000 turns overall, answer capped at 64 KB. | Bigger DB or shorter history. |
| R3 | Past chats open read-only (view and copy). Only the current chat of the selected session accepts questions; resuming an old Codex thread is out of scope. | Add `chat.resume` later. |
| R4 | Settings › Privacy gets "Keep chat history" (default on, `ui.history.keep`, stored by the app and sent to the daemon as `history.setEnabled`) and "Clear history…". Off stops new rows; existing rows remain until cleared. | — |
| R5 | Context ranking: tier 1 user messages, tier 2 Claude replies and failures, tier 3 commands, file edits, folder changes, tier 4 subagent results/summaries. Pass A fills up to 75% of the budget with tiers 1–2 newest-first; pass B fills the rest with tier 3, then tier 4, then leftover tiers 1–2, each newest-first. Output keeps transcript order. Notes say what was left out by kind. | Ranking constants change only. |
| R6 | PR screenshots come from a DEBUG-only demo connector (`COMPANION_DEMO=<scene>`) compiled out of release builds (`#if DEBUG`), so the real SwiftUI views run in the real panel with synthetic data and nothing reaches OpenAI. The real bundle is also run locally with sharing Off for the selection/copy check. | A demo mode in product code; it is compiled out of release. |
| R7 | Text selection: the root cause in v0.7.0 is `isMovableByWindowBackground = true` on the panel, which turns drags over text into window moves, plus one `Text` per paragraph. Fix: panel no longer moves by background (header still drags via the titlebar area); a message's prose is one selectable `Text` built from one `AttributedString`. | Fall back to an NSTextView representable. |
| R8 | Syntax highlighting is an in-repo tokenizer (keywords, strings, comments, numbers, types) for swift, ts/js, python, go, rust, sh, json, yaml, ruby, java/kotlin, c/cpp; unknown languages render plain mono. No new dependencies. | Add languages. |
| R9 | Glass only on the navigation layer: the header bar and the floating composer (`glassEffect`), with a hard top scroll-edge effect. Messages sit on the window background; user questions use a quiet fill, GPT answers are full-width document text. | Visual only. |

## File Structure

companiond
- Modify `src/context/contextBuilder.ts` — tiered pick (R5).
- Create `test/context/ranking.test.ts` — synthetic 800-item fixture.
- Modify `src/store/store.ts` — schema v2 `turns` table and methods.
- Create `test/store/history.test.ts`.
- Modify `src/chat/chatService.ts` — record turns, accumulate answer deltas, `newChat`.
- Modify `src/daemon/protocol.ts`, `src/daemon/handlers.ts` — `history.list`, `history.turns`, `history.clear`, `history.setEnabled`, `chat.newChat`.
- Tests in `test/chat/chatService.test.ts`, `test/daemon/handlers.test.ts`.

app (CompanionCore)
- Modify `Daemon/DaemonAPI.swift`, `Daemon/DaemonClient.swift`, `Daemon/DaemonModels.swift` — history types and methods.
- Modify `Chat/Conversation.swift` — restore from history, `sentAt`, `contextTurnId`.
- Modify `Model/AppModel.swift` (+ new `Model/AppModel+History.swift`) — load current chat, new chat, history list, past chat, context lookup, status line.
- Create `Text/CopyFormat.swift` — Markdown / plain / conversation export.
- Create `Text/CodeHighlighter.swift` — tokenizer.
- Modify `Text/ReplyMarkdown.swift` — `attributed(blocks:)` for one selectable prose run.
- Tests: `CopyFormatTests.swift`, `CodeHighlighterTests.swift`, `HistoryTests.swift`, `FakeDaemon.swift`.

app (CompanionApp)
- Create `Views/Design.swift` — spacing, radii, motion tokens, shared styles.
- Rewrite `Views/SidebarView.swift`, `HeaderView.swift`, `ChatView.swift`, `ReplyView.swift`, `InputBar.swift`, `CenterMessage.swift`, `BannerStack.swift` (→ status line), `PreviewSheet.swift`, `SentSheet.swift` (removed; replaced by the inline disclosure).
- Create `Views/MessageViews.swift`, `Views/CodeBlockView.swift`, `Views/ContextSentView.swift`, `Views/HistoryView.swift`, `Views/EmptyStateView.swift`, `Views/StatusLine.swift`.
- Modify `SidePanel.swift` (R7), `CompanionApp.swift` (commands ⌘K, ⌘⇧C), `AppDelegate.swift` (demo connector).
- Create `Demo/DemoDaemon.swift` (`#if DEBUG`).

docs: `docs/manual/m8-checklist.md`, README status, spec v3.7 note, `docs/screenshots/m8/*.png`.

---

### Task 1: Context ranking (companiond)

**Files:** Modify `companiond/src/context/contextBuilder.ts`; Create `companiond/test/context/ranking.test.ts`; adjust note expectations in `companiond/test/context/contextBuilder.test.ts` only where the note wording changes.

**Interfaces:** Produces `buildPreview` with the same signature and `ContextPreview` shape. `items` stay in transcript order (tracker "Subagent summary" items last, in `preview.subagents` order — `sentSubagents` depends on it). New exported `const TIER: Record<PreviewItemKind, 1|2|3|4>`.

- [ ] **Step 1: Write the failing fixture test** (`test/context/ranking.test.ts`)

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildPreview, DEFAULT_CAPS } from "../../src/context/contextBuilder.ts";
import type { TranscriptEvent } from "../../src/transcript/parser.ts";
import type { SubagentUpdate } from "../../src/transcript/subagents.ts";

// Synthetic shape of the owner's real session: 817 older items, mostly tool chatter and subagent output.
function fixture(): { events: TranscriptEvent[]; subagents: SubagentUpdate[] } {
  const events: TranscriptEvent[] = [];
  let n = 0;
  const base = { isSidechain: false, timestamp: null } as const;
  for (let turn = 0; turn < 40; turn++) {
    events.push({ ...base, kind: "user_text", uuid: `u${n++}`, text: `Synthetic question ${turn}: please fix the widget parser` } as TranscriptEvent);
    for (let k = 0; k < 12; k++) {
      events.push({ ...base, kind: "tool_result", uuid: `t${n++}`, command: `npm test -- widget${k}`, exitCode: 0, failure: null,
        stdout: "ok ".repeat(400), stderr: "", text: "" } as unknown as TranscriptEvent);
    }
    events.push({ ...base, kind: "subagent_summary", uuid: `s${n++}`, text: "Subagent explored files. ".repeat(60) } as TranscriptEvent);
    events.push({ ...base, kind: "assistant_text", uuid: `a${n++}`, text: `Synthetic reply ${turn}: changed parser.ts` } as TranscriptEvent);
  }
  const subagents: SubagentUpdate[] = Array.from({ length: 60 }, (_, i) => ({ agentId: `ag${i}`, records: 3, summary: "Tracker summary text. ".repeat(80) }) as SubagentUpdate);
  return { events, subagents };
}

test("user messages and Claude replies outrank subagent and tool chatter under the 12 KB cap", () => {
  const { events, subagents } = fixture();
  const p = buildPreview({ events, hadCursor: false, cursorFound: false, subagents });
  const kinds = p.items.map((i) => i.kind);
  assert.ok(p.bytes <= DEFAULT_CAPS.totalBytes);
  assert.ok(kinds.filter((k) => k === "user").length >= 10, "keeps many user messages");
  assert.ok(kinds.includes("assistant"));
  assert.ok(p.items.some((i) => i.text.includes("Synthetic question 39")), "newest question kept");
  assert.ok(p.items.some((i) => i.text.includes("Synthetic reply 39")), "newest reply kept");
  assert.ok(kinds.filter((k) => k === "subagent").length <= 2, "subagent output gets only leftovers");
  assert.ok(p.omitted > 0);
  assert.match(p.notes.join(" "), /left out/);
});

test("items keep transcript order", () => {
  const { events, subagents } = fixture();
  const p = buildPreview({ events, hadCursor: false, cursorFound: false, subagents });
  const order = p.items.filter((i) => i.kind === "user").map((i) => Number(/question (\d+)/.exec(i.text)?.[1]));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("when everything fits nothing is reordered or dropped", () => {
  const events = [
    { kind: "user_text", uuid: "1", text: "q", isSidechain: false },
    { kind: "subagent_summary", uuid: "2", text: "s", isSidechain: false },
    { kind: "assistant_text", uuid: "3", text: "a", isSidechain: false },
  ] as unknown as TranscriptEvent[];
  const p = buildPreview({ events, hadCursor: false, cursorFound: false });
  assert.deepEqual(p.items.map((i) => i.kind), ["user", "subagent", "assistant"]);
  assert.equal(p.omitted, 0);
});
```

(Implementer: match the real `TranscriptEvent` field names from `src/transcript/parser.ts`; the casts are only for brevity.)

- [ ] **Step 2: Run** `cd companiond && node --test test/context/ranking.test.ts` — expect the first test to FAIL (only tracker summaries kept).
- [ ] **Step 3: Implement** in `buildPreview`: keep drafts with their index; compute `size` per draft; skip drafts with `size > budget` (count `tooBig`); pass A over tiers 1–2 newest-first while `bytes + size <= 0.75 * budget` (skip, not stop, on a miss); pass B over tier 3, tier 4, then remaining tiers 1–2, each newest-first, while it fits and `picked < maxItems`; sort picked by index. `omitted = drafts.length - picked.length`. Note: `"<n> item(s) left out to stay under 12 KB (kept your messages and Claude's replies first; left out: <k> subagent, <m> tool)."` or the item-limit variant `"(40-item limit)"`. Keep `bytes` = sum of picked item bytes + notes.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; update only the note-wording assertions in `contextBuilder.test.ts` that change (keep every other assertion).
- [ ] **Step 5: Commit** `feat(m8): rank context by kind under the 12 KB cap`.

### Task 2: History store (companiond)

**Files:** Modify `companiond/src/store/store.ts`; Create `companiond/test/store/history.test.ts`.

**Interfaces (Produces):**

```ts
export interface TurnItem { kind: string; label: string; text: string; redactions: number }
export interface TurnRow {
  turnId: string; sessionId: string; threadId: string; sessionTitle: string | null; mode: SharingMode;
  question: string; contextBlock: string; items: TurnItem[]; omitted: number;
  answer: string; status: "running" | "completed" | "interrupted" | "failed" | "abandoned"; error: string | null;
  sentAt: number; completedAt: number | null;
}
export interface ChatSummary { sessionId: string; threadId: string; sessionTitle: string | null; firstQuestion: string; turns: number; startedAt: number; lastAt: number }
Store.insertTurn(t: Omit<TurnRow, "answer" | "status" | "error" | "completedAt">): void   // redacts question
Store.finishTurn(turnId: string, f: { answer: string; status: TurnRow["status"]; error: string | null }): void // redacts answer, caps 64 KB
Store.abandonRunningTurns(): number            // running → abandoned (daemon start)
Store.turnsForThread(threadId: string, limit = 200): TurnRow[]   // oldest → newest
Store.listChats(limit = 100): ChatSummary[]    // newest lastAt first
Store.deleteChat(threadId: string): number; Store.deleteAllHistory(): number
Store.historyEnabled(): boolean; Store.setHistoryEnabled(on: boolean): void   // settings row "history_enabled"
Store.clearThread(sessionId: string): void      // used by chat.newChat
export const SCHEMA_VERSION = 2
```

Schema v2 adds:

```sql
CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, thread_id TEXT NOT NULL, session_title TEXT,
  mode TEXT NOT NULL, question TEXT NOT NULL, context_block TEXT NOT NULL, items TEXT NOT NULL, omitted INTEGER NOT NULL,
  answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error TEXT, sent_at INTEGER NOT NULL, completed_at INTEGER) STRICT;
CREATE INDEX IF NOT EXISTS turns_thread ON turns (thread_id, sent_at);
```

Retention after each insert: delete the oldest rows beyond 200 per thread and beyond 2,000 overall. A v1 database upgrades in place (CREATE IF NOT EXISTS + `user_version = 2`).

- [ ] **Step 1:** Tests: insert → turnsForThread round-trip; question with `sk-…`-shaped secret is stored redacted; finishTurn caps answer at 64 KB and redacts; abandonRunningTurns; listChats grouping and order; retention 200/thread; deleteChat; v1 file upgrades (open a DB with `user_version = 1` and the v1 tables, reopen with Store); historyEnabled default true.
- [ ] **Step 2:** Run, see FAIL. **Step 3:** Implement. **Step 4:** `npm test && npm run typecheck`. **Step 5:** Commit `feat(m8): keep chat turns in companion.db (schema v2)`.

### Task 3: Record turns, new chat, history methods (companiond)

**Files:** Modify `src/chat/chatService.ts`, `src/daemon/protocol.ts`, `src/daemon/handlers.ts`; tests in `test/chat/chatService.test.ts`, `test/daemon/handlers.test.ts`.

**Interfaces:**
- Consumes Task 2 store methods.
- `ChatService` subscribes to host `delta` events (`{type:"delta", threadId, turnId, itemId, text}` — check `HostEvent` in `codexHost.ts`) and accumulates text per turn as the app does (items in first-seen order, joined with `"\n\n"`), bounded at 64 KB.
- After `startTurn` succeeds: `store.insertTurn(...)` when `store.historyEnabled()`, with `items` = sent preview items (removed ones excluded), `omitted`, `contextBlock`, `mode`, `sessionTitle` = `p.sessionTitle`.
- On `turnCompleted` (any status) → `store.finishTurn(turnId, { answer, status: completed|interrupted|failed, error })`. `reconcile()` → `finishTurn(..., status "abandoned")`. Constructor calls `store.abandonRunningTurns()`.
- `ChatService.newChat(sessionId)`: throws `TurnBusyError` while a turn runs or sends for that session; else closes the open thread (if any), `store.clearThread(sessionId)`, `store.clearCursor(sessionId)`, clears repo note and subagent tracker for the session.
- `chat.sent` keeps its shape, now served from `turnsForThread(store.getThread(sessionId))` mapped to `SentRecord`.
- New methods in `METHODS`: `"history.list"` → `{ chats: ChatSummary[], currentThreads: Record<sessionId, threadId> }` (current = `store.getThread` for sessions in the snapshot); `"history.turns"` params `{ threadId }` or `{ sessionId }` (current thread; empty list when none) → `{ threadId: string | null, turns: TurnRow[] }`; `"history.clear"` params `{ threadId: string | null }` → `{ deleted: number }`; `"history.setEnabled"` `{ enabled: boolean }` → `{ enabled }`; `"chat.newChat"` `{ sessionId }` → `{}`.

- [ ] Step 1: failing tests (records a completed turn with answer from deltas; failed/interrupted statuses; removed items not stored; disabled history writes nothing; newChat clears thread + cursor and refuses while busy; handlers return shapes above; METHODS includes the five names).
- [ ] Step 2: run FAIL. Step 3: implement. Step 4: `npm test && npm run typecheck`. Step 5: commit `feat(m8): record turns, history methods and chat.newChat`.

### Task 4: App core — history API, conversation restore, model actions

**Files:** `app/Sources/CompanionCore/Daemon/{DaemonAPI,DaemonClient,DaemonModels}.swift`, `Chat/Conversation.swift`, `Model/AppModel.swift`, new `Model/AppModel+History.swift`; tests `app/Tests/CompanionCoreTests/{FakeDaemon,HistoryTests}.swift`.

**Interfaces (Produces):**

```swift
public struct TurnItem: Decodable, Sendable, Equatable, Identifiable { kind, label, text: String; redactions: Int; id: label+index }
public struct TurnRecord: Decodable, Sendable, Equatable, Identifiable {
  turnId, sessionId, threadId: String; sessionTitle: String?; mode: SharingMode; question, contextBlock: String
  items: [TurnItem]; omitted: Int; answer: String; status: String; error: String?; sentAt: Double; completedAt: Double?
}
public struct ChatSummary: Decodable, Sendable, Equatable, Identifiable { sessionId, threadId: String; sessionTitle: String?; firstQuestion: String; turns: Int; startedAt, lastAt: Double; id = threadId }
public struct HistoryList: Decodable, Sendable, Equatable { chats: [ChatSummary]; currentThreads: [String: String] }
public struct HistoryTurns: Decodable, Sendable, Equatable { threadId: String?; turns: [TurnRecord] }
DaemonAPI: historyList(), historyTurns(sessionId:), historyTurns(threadId:), historyClear(threadId:), historySetEnabled(_:), chatNewChat(sessionId:)
Conversation.restore(_ turns: [TurnRecord])     // prepends done/failed message pairs; ChatMessage gains sentAt: Date?
AppModel: records: [String: TurnRecord] (by turnId), history: HistoryList?, pastChat: PastChat?, statusItems: [StatusItem]
  loadCurrentChat(sessionId:) on selection change (once per session per connection)
  refreshRecord(turnId:) after turnCompleted (fills records for the Context sent disclosure)
  newChat() (⌘K), loadHistory(), openPastChat(_ ChatSummary), closePastChat(), clearHistory(threadId:)
  conversationText(includeContext: Bool) -> String   // via CopyFormat
```

- [ ] Steps: failing tests with FakeDaemon (restore after reconnect shows earlier turns; newChat calls chat.newChat and empties messages; refusing while answering; openPastChat loads turns read-only; records filled after turnCompleted); implement; `cd app && swift test`; commit `feat(m8): app history, new chat and past chats`.

### Task 5: Copy formatting and code highlighting (CompanionCore)

**Files:** Create `app/Sources/CompanionCore/Text/CopyFormat.swift`, `Text/CodeHighlighter.swift`; tests `CopyFormatTests.swift`, `CodeHighlighterTests.swift`; extend `ReplyMarkdown.swift` with `public static func plainText(_ markdown: String) -> String`.

**Interfaces:**

```swift
public enum CopyFormat {
  public static func markdown(_ message: ChatMessage) -> String           // raw text as written
  public static func plain(_ message: ChatMessage) -> String              // headings/bullets/quotes flattened, inline marks removed, code kept verbatim
  public static func conversation(_ messages: [ChatMessage], records: [String: TurnRecord], title: String?, includeContext: Bool) -> String
}
public enum CodeToken: Sendable, Equatable { case keyword, string, comment, number, type, plain }
public enum CodeHighlighter { public static func tokens(_ code: String, language: String?) -> [(range: Range<String.Index>, kind: CodeToken)] }
```

Conversation format:

```
# GPT chat — <title>

## You
<question>

<details><summary>Context sent (N items)</summary>

```text
<contextBlock>
```
</details>

## GPT
<answer markdown>
```

- [ ] Steps: tests first (plain strips `**bold**`, `` `x` ``, `# H`, keeps code; conversation with and without context; highlighter finds swift keyword `func`, string, `//` comment, number, and is a no-op for unknown language; never crashes on unterminated string); implement; `swift test`; commit `feat(m8): copy formats and code highlighting`.

### Task 6: Visual system, panel and states (CompanionApp)

**Files:** `Views/Design.swift`, `SidebarView.swift`, `HeaderView.swift`, `StatusLine.swift` (replaces BannerStack), `CenterMessage.swift` (gate states), `EmptyStateView.swift`, `InputBar.swift`, `SidePanel.swift`, `CompanionApp.swift`, `Demo/DemoDaemon.swift`, `AppDelegate.swift`.

Spec:
- Header (glass, `GlassEffectContainer`): session menu button (status dot + title, opens picker), trailing icon buttons History (clock), New chat (square.and.pencil, ⌘K), More menu (Refresh ⌘R, Pin/Unpin, Copy conversation ⌘⇧C, Settings…). Second row: repo chip (`folder` + `repo · branch`, lock glyph, `.help(fullPath)`), context mode menu chip (`Context: Ask/Off/Automatic`, automatic confirmation kept).
- Status line: one compact row (icon + one line + action + "1 of N" + dismiss), highest priority first: security alert > repo unavailable (Approve…) > desktop records error > focus moved (Switch) > pinned missing (Unpin) > thread replaced > sync problem > repo changed.
- Gate states: large SF Symbol, title, one sentence, one prominent button: connecting / host starting (progress), daemon down (Restart companiond), host failed (Try again), security stop (unchanged wording + acknowledge), signed out (Sign in with ChatGPT), auth error (Retry), unsupported, no session (Refresh).
- Empty chat: symbol, "Ask GPT about this session", one line, suggested prompts (Explain Claude's last message; Review Claude's latest change for bugs; What is Claude stuck on?; Summarize this session so far) — context-dependent ones hidden in Off.
- Composer: floating glass rounded rect, multi-line `TextField`, placeholder "Ask GPT…", Return sends, ⇧Return / ⌥Return newline, ⌘↩ sends, mic, send/stop button; context hint row ("Context: Ask · you'll check before sending").
- `SidePanel`: `isMovableByWindowBackground = false` (R7).
- Demo connector (`#if DEBUG`): scenes `empty`, `chat`, `context`, `history`, `streaming`, `signedOut`, `daemonDown`, `ask` selected by `COMPANION_DEMO`; synthetic session "Refactor widget parser" in repo `acme-widgets` on branch `fix/parser`.
- Motion tokens in `Design.Motion` (`quick 0.12`, `standard 0.18`, `emphasized 0.24`, `.smooth`), honoring `accessibilityReduceMotion`.

- [ ] Steps: implement; `swift build`; run each demo scene, screenshot light and dark; fix; `swift test`; commit `feat(m8): redesigned panel, header, status line and states`.

### Task 7: Messages, copy, context sent, history (CompanionApp)

**Files:** `Views/ChatView.swift`, `MessageViews.swift`, `ReplyView.swift`, `CodeBlockView.swift`, `ContextSentView.swift`, `HistoryView.swift`, `PreviewSheet.swift`; delete `SentSheet.swift`.

Spec:
- Turn layout: question bubble (trailing, quiet fill, selectable), "Context sent · N items · X KB" disclosure (collapsed; expands to the exact items with label, masked count, selectable mono text, plus "Copy context" and "Show raw block"), answer full-width, selectable as one `Text` per prose run, code blocks with header (language + Copy, confirmation "Copied"), footer actions (Copy ▾ Markdown/Plain text, Read aloud, timestamp) visible on hover and always reachable by keyboard/VoiceOver.
- Streaming: typing indicator (three dots, static under reduce motion) before first delta, then text with a "Stop" in composer; tool activity row "Reading the repository…".
- Failed/interrupted: inline row with reason + "Send again" when retryable.
- History: popover/sheet list of chats (session title, first question, turns, relative date), search field, current chat marked, "Clear…" per chat and all; opening shows the past chat read-only with a bar "Past chat · read-only · Back to current".
- Preview sheet: selectable item text (no Toggle wrapping the text: checkbox column + selectable text), same Send/Cancel, same notice and redaction text.
- Every control has `accessibilityLabel`; messages are `accessibilityElement(children: .combine)` with "You said" / "GPT answered".

- [ ] Steps: implement; demo scenes; screenshots; `swift test`; commit `feat(m8): selectable, copyable turns with context sent and history`.

### Task 8: Verification, docs, PR

- [ ] Real bundle: `scripts/build-app.sh`, `scripts/smoke-bundle.sh`, `scripts/package-app.sh`, `scripts/test-packaging.sh`, `scripts/check-repo.sh`; launch locally with sharing Off; drag-select and ⌘C inside a reply; copy buttons; ⌘K; relaunch shows history.
- [ ] Screenshots (demo scenes, light + dark) into `docs/screenshots/m8/`; before shots from v0.7.0 views with the same demo connector.
- [ ] `docs/manual/m8-checklist.md`, README status row, spec note.
- [ ] Push, draft PR with before/after, all CI green.

---

## Owner additions (2026-11-05, same day)

Owner asks added after the plan was written; in scope.

- **Journey review (Tasks 6–7):** every control is labelled or explained: the context mode menu says what each mode sends (one line per option), "Pin" becomes "Keep this session" with a tooltip ("Stay on this session even when you switch sessions in Claude"), the focus/sync line becomes plain words ("Following Claude's focused session · transcript up to date"), the read-only chip has a tooltip and is part of the new **What GPT can see** popover (opened from an `eye` button in the header and from the empty state): your question; with Ask/Automatic the recent Claude conversation (redacted, ≤12 KB, previewed in Ask); read-only repository tools only for approved repositories (never writes, never secret files); Jira read-only if set up; nothing else (no Claude credentials, no other apps). The session button says "Choose session" in its tooltip and opens the picker. Sign-in and first launch states explain why sign-in is needed (ChatGPT plan, no API key). Loading states for every async region (connecting, host starting, session list loading, history loading, context preview preparing).
- **Task 9: App icon.** Original macOS 26 icon (no OpenAI/Anthropic marks): Icon Composer `.icon` document when `ictool` is available (it is, Xcode 27 toolchain locally; CI `macos-26` may lack it), plus a committed fallback `AppIcon.icns` built from layered PNGs drawn by a script. `build-app.sh` copies `AppIcon.icns` into `Contents/Resources` and Info.plist gets `CFBundleIconFile = AppIcon` (and `CFBundleIconName` when an Assets.car is produced). Verify with `NSWorkspace.icon(forFile:)` rendered to PNG for the built app; the Dock screenshot needs Screen Recording permission (see Task 8).
- **Task 10: Read Aloud voice.** Pick the best installed voice for the user's language: Premium > Enhanced > default quality, never novelty voices (`AVSpeechSynthesisVoice.voiceTraits.contains(.isNoveltyVoice)`), Personal Voice excluded. Settings › Speech: voice picker grouped by quality with a Preview button; when no Premium/Enhanced voice is installed, a one-line hint with a button that opens System Settings › Accessibility › Spoken Content (`x-apple.systempreferences:com.apple.preference.universalaccess?SpokenContent`). Natural delivery: rate default ~0.9× of AVSpeechUtteranceDefaultSpeechRate mapped so the 1.0× setting sounds unhurried, pitch 1.0, one utterance per sentence with `postUtteranceDelay` 0.12 s and 0.45 s at paragraph breaks (SpeechText keeps paragraph boundaries), lists read item by item, no Markdown symbols, URLs replaced by "link", code blocks "Code block omitted." unless Read code is on. Pause/resume/stop and a visible speaking state on the message (Task 7 UI). Tests: voice ranking with fake voice descriptors, SpeechText sentences/paragraphs/lists/URLs. Verify by rendering a sample answer to an audio file with `AVSpeechSynthesizer.write` (DEBUG/scratch tool, not shipped) and note voice + settings before/after in the report.
- **Task 8 additions:** build, install (copy to /Applications from the DMG or the built bundle — owner's machine, confirm the old app is replaced, not data), launch, inspect; Dock icon check.
