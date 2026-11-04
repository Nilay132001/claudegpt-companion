# M3 — Session Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `companiond` finds Claude Desktop sessions, picks the selected one (focus, pin, picker), tails its transcript into typed events, and resolves its exact worktree — read-only — with the §12.2 session sync suite green on synthetic fixtures.

**Architecture:** Four layers under `companiond/src/`. `claude/` reads Claude's files through a `ReadFs` interface that has no write method; base directories come in as a `ClaudePaths` parameter. `transcript/` turns bytes into events: `LineBuffer` → `TranscriptTail` (offset, inode, truncation) → `TranscriptParser` → `TranscriptReader` (rolling event window, uuid index, counts). `worktree/` asks M2's `SafeGit` (`locate`, `open`, `branch`) and never falls back. `bridge/` ties them together in `SessionBridge`, the one place that wraps `ReadFs` in the `.key` guard; it polls every 2 s (fs.watch is only a hint) and emits typed events for M4/M5.

**Tech Stack:** Node ≥ 24 running TypeScript by type stripping, `node --test`, `tsc --noEmit`, M2's `SafeGit` for every git call, `/bin/ps` for process start times. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md` (§3, §6.1–6.4, §7.3, §7.5, §7.7, §10, §12.2, §13, §14 M3, §16). Findings: `docs/findings/2026-11-03-phase1-poc.md` (§4 file locations and fields; "M1 spike results" Q7). M2 plan: `docs/superpowers/plans/2026-11-04-m2-safegit-jail.md` (Task 3 fixtures, Task 4 SafeGit, "Interfaces produced for M4").

## Global Constraints

- **M3 starts after M2 is merged.** It consumes M2's `SafeGit` (`src/git/safeGit.ts`), including `SafeGit.locate`, `SafeGit#branch` and `LocateError`, which M2 adds by controller ruling, and M2's test fixtures (`test/helpers/fixtures.ts`).
- Read-only on all Claude data. Never write under `~/.claude` or `~/Library/Application Support/Claude`. Install nothing into Claude; never change Claude Desktop or Claude Code configuration (spec §7.7).
- Read only `<digits>.json` running files in `~/.claude/sessions/`; never open `*.key`, never read or connect to `messagingSocketPath` (spec §6.1).
- Claude's files are read only through `ReadFs` (no write method). The one other `node:fs` use is `watch` in `bridge/watcher.ts`, which only gives change hints. A static test scans `src/claude`, `src/transcript`, `src/worktree`, `src/bridge` for write, delete, network and socket APIs, and allows `node:child_process` only in `claude/processProbe.ts` (`/bin/ps`).
- **M3 never spawns git.** Every git question goes through M2's `SafeGit` with an absolute `gitPath`: production passes `discoverToolchain().gitPath` (M2, M4 wiring); tests pass `testGitPath()` (M2 fixtures). So the §7.3 config gate runs on every resolution.
- Base directories are parameters (`ClaudePaths`). Only production wiring (M4) calls `defaultClaudePaths(os.homedir())`. Tests never read the real `~/.claude` or Claude's Application Support.
- Tests use synthetic fixtures only, built in fresh temp dirs with M2's `tempDir()`; every file they write carries `SYNTHETIC FIXTURE` (`MARK`). Every test file that creates dirs calls `after(removeTempDirs)`. M3 commits no `.jsonl` files.
- No personal data in the repo: no real session ids, titles, paths, usernames. Fixture ids look like `local_syn-a` / `cli-a` (they do not match check-repo's `local_<uuid>` pattern).
- Exact worktree (spec §6.3): if the candidate `cwd` is not itself the top folder of an existing, approved git work tree that SafeGit's gate accepts, the result is `unavailable` with a reason. No fallback to a parent repo, the main checkout, another branch or the last good root.
- fs.watch is a hint. Correctness comes from polling (`tick()`), which tests call directly. No test depends on real fs.watch timing.
- Tests must also pass on CI (`ubuntu-latest`, Node 24): git via `testGitPath()` (`/usr/bin/git` there), and `/bin/ps`.
- TypeScript: `erasableSyntaxOnly` — no `enum`, `namespace` or constructor parameter properties. Imports use `.ts` extensions and `import type` for types.
- Feature branch `feat/m3-session-bridge` from an up-to-date `main`, PR, never push to `main`. Conventional Commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `bash scripts/check-repo.sh` before every commit. Stage explicit paths. Edit files with the editor tools (no heredocs, `sed -i` or `cat >`).

## File structure

```
companiond/
  src/
    lineBuffer.ts                  (modify) cap, chunk list, strict UTF-8, counters
    jail/mcpServer.ts              (modify, M2's file) reply to lines LineBuffer drops
    claude/
      readFs.ts                    ReadFs, nodeReadFs, guardReadFs (.key refused, onRefused hook), readJsonFile
      paths.ts                     ClaudePaths, defaultClaudePaths, encodeCwd, isSafeId, toEpochMs
      desktopRecords.ts            readDesktopRecords → DesktopRecord[] (deduped)
      runningFiles.ts              readRunningFiles, ProcessProbe, checkRunningFile, liveStates, cacheStartTimes
      processProbe.ts              nodeProcessProbe (kill(pid,0) + /bin/ps lstart)
      transcriptLocator.ts         locateTranscript (sessionId check, collision rejection)
    transcript/
      terminal.ts                  detectFailure (test/build/command failures)
      parser.ts                    TranscriptParser → TranscriptEvent
      tail.ts                      TranscriptTail (offset, inode, truncation, partial lines)
      reader.ts                    TranscriptReader → TranscriptBatch, SyncStats (rolling window)
      subagents.ts                 SubagentTails → SubagentUpdate
    worktree/
      resolver.ts                  resolveWorktree (via SafeGit) → WorktreeResolution, describeChange
    bridge/
      selection.ts                 status, focus, pin, picker groups
      watcher.ts                   WatchFactory, nodeWatchFactory
      transcriptOnly.ts            listTranscripts (desktop records unreadable)
      sessionBridge.ts             SessionBridge → BridgeEvent
  test/
    helpers/fixtures.ts            (modify, M2's file) append Claude builders
    lineBuffer.test.ts             (modify)
    jail/stdioFraming.test.ts      new
    claude/*.test.ts  transcript/*.test.ts  worktree/*.test.ts  bridge/*.test.ts
spikes/m3/shape-probe.mjs          read-only key/type probe (Task 1, throwaway, owner runs it)
```

`node --test` takes files or globs, not folders. The M3 run used below is:

```bash
node --test "test/claude/*.test.ts" "test/transcript/*.test.ts" "test/worktree/*.test.ts" "test/bridge/*.test.ts" test/lineBuffer.test.ts test/jail/stdioFraming.test.ts
```

---

### Task 1: Precondition and shape check of fields M1 did not record

The findings list key names but not value formats. M3 depends on `procStart` (running file), `lastFocusedAt`/`lastActivityAt` (records), Bash `toolUseResult` keys and the exit-code form, record `type` names (parser `KNOWN_SILENT`), how often the transcript `cwd` moves, whether latest `cwd`s are git top folders, and the subagent file shape. The code is tolerant of the likely forms; this probe confirms them. It prints key names, bucketed values and counts only. **The owner runs it** on their Mac and pastes the counts; the implementer never runs it against real data.

**Files:**
- Create: `spikes/m3/shape-probe.mjs`
- Modify: `docs/findings/2026-11-03-phase1-poc.md` (append `## M3 shape check`)

**Interfaces:**
- Consumes: M2's `SafeGit.locate`, `LocateError` (`companiond/src/git/safeGit.ts`) and `discoverToolchain` (`companiond/src/launch/toolchain.ts`).
- Produces: a findings section later tasks rely on (value kinds), no product code.

- [ ] **Step 1: Check M2 is merged, then branch from an up-to-date main**

```bash
git switch main && git pull --ff-only
test -f companiond/src/git/safeGit.ts && grep -q "static async locate" companiond/src/git/safeGit.ts && grep -q "class LocateError" companiond/src/git/safeGit.ts && grep -qE "async branch\(\)" companiond/src/git/safeGit.ts \
  && grep -q "export function discoverToolchain" companiond/src/launch/toolchain.ts \
  && grep -q "export function makeWorktree" companiond/test/helpers/fixtures.ts && grep -q "export function testGitPath" companiond/test/helpers/fixtures.ts && grep -q "export function removeTempDirs" companiond/test/helpers/fixtures.ts \
  && echo "M2 merged"
git switch -c feat/m3-session-bridge
```

Expected: `M2 merged`. If not, stop: M3 cannot start before M2 (SafeGit with `locate`, `branch` and `LocateError`; `discoverToolchain`; the fixture helpers) is on `main`.

- [ ] **Step 2: Write the probe** — `spikes/m3/shape-probe.mjs`:

```js
// Read-only, run by the OWNER on their Mac. Prints key names, value kinds and counts only:
// no titles, paths, ids, times, branch names, commands or content. Status, entrypoint and record type
// values are bucketed to an allow-list or a safe shape, else "other".
// Reads: desktop records, `~/.claude/sessions/<digits>.json` (never *.key), the 40 newest transcripts
// (streamed line by line) and their subagent files. Git questions go through M2's SafeGit (config gate first).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { LocateError, SafeGit } from "../../companiond/src/git/safeGit.ts";
import { discoverToolchain } from "../../companiond/src/launch/toolchain.ts";

const home = os.homedir();
const desktop = path.join(home, "Library/Application Support/Claude/claude-code-sessions");
const projects = path.join(home, ".claude/projects");
const running = path.join(home, ".claude/sessions");
const gitPath = discoverToolchain().gitPath;

const kind = (v) => {
  if (v === undefined) return "absent";
  if (v === null) return "null";
  if (typeof v === "number") return v > 1e11 ? "epoch-ms" : "epoch-s";
  if (typeof v === "string") return /^\d+$/.test(v) ? "numeric-string" : Number.isFinite(Date.parse(v)) ? "date-string" : "other-string";
  return typeof v;
};
const bucket = (v, allowed) => (typeof v === "string" && allowed.includes(v) ? v : v === undefined ? "absent" : "other");
const typeName = (v) => (typeof v === "string" && /^[a-z][a-z0-9_-]{0,40}$/.test(v) ? v : "other");
const bump = (m, k) => (m[k] = (m[k] ?? 0) + 1);
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const statOrNull = (p) => { try { return fs.statSync(p); } catch { return null; } }; // tolerates broken symlinks

const out = {
  records: { n: 0, keys: {}, lastFocusedAt: {}, lastActivityAt: {} },
  running: { n: 0, keys: {}, procStart: {}, status: {}, entrypoint: {} },
  transcripts: {
    n: 0, types: {}, bashResultKeys: {}, bashExitCodeKey: 0, bashErrors: 0, bashErrorTextStartsExitCode: 0,
    subagentResultKeys: {}, moreThanOneCwd: 0, sidechainRecords: 0,
    latestCwd: { none: 0, missing: 0, notDir: 0, notGit: 0, refused: 0, gitFailed: 0, subfolder: 0, toplevel: 0 },
    subagents: { dirs: 0, files: 0, nameAgentDash: 0, nameOther: 0, firstSessionId: { parent: 0, other: 0, absent: 0 } },
  },
};

for (const org of ls(desktop)) for (const acct of ls(path.join(desktop, org))) {
  const d = path.join(desktop, org, acct);
  if (!statOrNull(d)?.isDirectory()) continue;
  for (const f of ls(d)) {
    if (!/^local_.*\.json$/.test(f)) continue;
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); } catch { continue; }
    out.records.n++;
    for (const k of Object.keys(r)) bump(out.records.keys, k);
    bump(out.records.lastFocusedAt, kind(r.lastFocusedAt));
    bump(out.records.lastActivityAt, kind(r.lastActivityAt));
  }
}

for (const f of ls(running)) {
  if (!/^[0-9]+\.json$/.test(f)) continue; // never *.key, never the socket
  let r;
  try { r = JSON.parse(fs.readFileSync(path.join(running, f), "utf8")); } catch { continue; }
  out.running.n++;
  for (const k of Object.keys(r)) bump(out.running.keys, k);
  bump(out.running.procStart, kind(r.procStart));
  bump(out.running.status, bucket(r.status, ["busy", "idle"]));
  bump(out.running.entrypoint, bucket(r.entrypoint, ["claude-desktop", "cli"]));
}

async function* records(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    try { yield JSON.parse(line); } catch { /* malformed: skip */ }
  }
}

async function classifyCwd(cwd) {
  const st = statOrNull(cwd);
  if (!st) return "missing";
  if (!st.isDirectory()) return "notDir";
  const real = fs.realpathSync.native(cwd);
  try {
    const dirs = await SafeGit.locate({ gitPath, cwd: real });
    return dirs.toplevel === real ? "toplevel" : "subfolder";
  } catch (e) {
    if (e instanceof LocateError) return e.kind === "refused" ? "refused" : e.kind === "not_git" ? "notGit" : "gitFailed";
    return "gitFailed";
  }
}

const files = [];
for (const d of ls(projects)) {
  const dir = path.join(projects, d);
  if (!statOrNull(dir)?.isDirectory()) continue;
  for (const f of ls(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const st = statOrNull(path.join(dir, f));
    if (st?.isFile()) files.push({ file: path.join(dir, f), mtime: st.mtimeMs });
  }
}
files.sort((a, b) => b.mtime - a.mtime);
const T = out.transcripts;
for (const { file } of files.slice(0, 40)) {
  T.n++;
  const id = path.basename(file, ".jsonl");
  const tools = new Map();
  const cwds = new Set();
  let latestCwd = null;
  for await (const r of records(file)) {
    bump(T.types, typeName(r.type));
    if (r.isSidechain === true) T.sidechainRecords++;
    else if (typeof r.cwd === "string") { cwds.add(r.cwd); latestCwd = r.cwd; }
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use") tools.set(b.id, b.name);
      if (b?.type !== "tool_result") continue;
      const name = tools.get(b.tool_use_id);
      const tur = r.toolUseResult;
      if (name === "Bash") {
        if (tur && typeof tur === "object") for (const k of Object.keys(tur)) bump(T.bashResultKeys, k);
        if (tur && typeof tur === "object" && "exitCode" in tur) T.bashExitCodeKey++;
        if (b.is_error === true) {
          T.bashErrors++;
          const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text ?? "").join("\n") : "";
          if (/^Exit code \d+/.test(text)) T.bashErrorTextStartsExitCode++;
        }
      }
      if ((name === "Task" || name === "Agent") && tur && typeof tur === "object") for (const k of Object.keys(tur)) bump(T.subagentResultKeys, k);
    }
  }
  if (cwds.size > 1) T.moreThanOneCwd++;
  T.latestCwd[latestCwd === null ? "none" : await classifyCwd(latestCwd)]++;
  const subDir = path.join(path.dirname(file), id, "subagents");
  if (!statOrNull(subDir)?.isDirectory()) continue;
  T.subagents.dirs++;
  for (const f of ls(subDir)) {
    if (!f.endsWith(".jsonl")) continue;
    T.subagents.files++;
    if (/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(f)) T.subagents.nameAgentDash++;
    else T.subagents.nameOther++;
    let first = null;
    for await (const r of records(path.join(subDir, f))) { first = r; break; }
    const sid = first?.sessionId;
    T.subagents.firstSessionId[sid === undefined ? "absent" : sid === id ? "parent" : "other"]++;
  }
}
console.log(JSON.stringify(out, null, 2));
```

Check: `node --check spikes/m3/shape-probe.mjs` exits 0.

- [ ] **Step 3: Owner runs it (read-only) and pastes the counts**

Owner runs: `node spikes/m3/shape-probe.mjs`
Expected: JSON with key names, bucket names and counts only. The owner checks by eye that there are no titles, paths, ids or times before pasting it.

- [ ] **Step 4: Record the result** — append to the findings doc:

```markdown
## M3 shape check

Date: <date>. Ran (owner): `node spikes/m3/shape-probe.mjs` (read-only; key names, bucketed values, counts).
- Records: `lastFocusedAt` kinds <…>, `lastActivityAt` kinds <…>.
- Running files: keys <…>; `procStart` kinds <…>; `status` buckets <…>; `entrypoint` buckets <…>.
- Transcripts (40 newest): record types <…>; Bash `toolUseResult` keys <…>; `exitCode` key in <n>;
  error text starts `Exit code N` in <n>/<m>; transcripts with more than one main-chain cwd <n>;
  sidechain records <n>; latest cwd: toplevel <n>, subfolder <n>, not git <n>, refused <n>, git failed <n>,
  missing <n>, not a folder <n>, none <n>.
- Subagents: folders <n>, files <n>; names `agent-*` <n> / other <n>; first record sessionId = parent <n>,
  other <n>, absent <n>.
- Known limit (by design, spec §6.4 detects only shrink or new inode): an in-place rewrite of a transcript
  to the same or a larger size is not detected.
- Verdict: <matches the M3 plan's parsing | differs: …>.
```

Fill the `<…>` from the probe output (counts, bucket and key names only).

- [ ] **Step 5: Decide**

- `procStart` kind is `epoch-ms`, `epoch-s`, `numeric-string` or `date-string` → `toEpochMs` (Task 4) handles it; continue.
- `procStart` is `absent`, `null`, `other-string` or `object` in any running file → **stop and report to the owner**: busy/idle detection (spec §6.2) cannot match start times, and those running files would read as stale.
- `status` shows `other` → continue: an unknown status from a live, matching desktop process counts as **busy** (`checkRunningFile`, Task 6). Note it in the PR.
- Record types other than those in `KNOWN_SILENT` (Task 9) plus `user`/`assistant` appear → add them to `KNOWN_SILENT` in Task 9 if they carry no conversation content; otherwise they are counted as unknown.
- `latestCwd.subfolder` > 0 → those sessions will show Unavailable (`not_worktree_root`, Task 12). Note the count in the PR for the owner's §6.3 ruling.
- Bash results show neither an `exitCode` key nor an `Exit code N` text prefix → continue; `exitCode` will be `null` for failed commands and Task 9 tests still hold (synthetic shapes). Note it in the PR.
- Subagent first-record `sessionId` is `other` or `absent` → continue (`SubagentTails` does not check it); note it.

- [ ] **Step 6: Commit**

```bash
bash scripts/check-repo.sh
git add spikes/m3/shape-probe.mjs docs/findings/2026-11-03-phase1-poc.md
git commit -m "docs(findings): record M3 shape check of record and transcript fields" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Harden `LineBuffer`

Leftovers from the M0 review: a cap on the partial tail, a chunk list instead of `Buffer.concat` on every push, strict UTF-8 with a malformed-line count (spec §6.4 "skipped and counted"), and tests for a CR split across chunks and a lone CRLF line. `push` keeps its signature. M2's jail scans `lineBuffer.ts` for write and network code; the file still imports nothing.

**Files:**
- Modify: `companiond/src/lineBuffer.ts` (whole file)
- Modify: `companiond/test/lineBuffer.test.ts` (whole file)

**Interfaces:**
- Consumes: nothing.
- Produces: `class LineBuffer { constructor(options?: { maxLineBytes?: number }); push(chunk: Buffer): string[]; get pendingBytes(): number; get invalidUtf8Lines(): number; get oversizedLines(): number; reset(): void }` and `DEFAULT_MAX_LINE_BYTES = 16 MiB`. Lines are split on `\n`, a trailing `\r` is stripped, empty lines dropped, invalid UTF-8 lines dropped and counted, lines over the cap dropped and counted (the line after survives). Pushed bytes are copied. **Behaviour change for M2's jail:** an invalid UTF-8 line no longer comes out as a string with U+FFFD; it is dropped and counted. Task 3 makes the jail reply to it.

- [ ] **Step 1: Write the failing tests** — replace `companiond/test/lineBuffer.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { LineBuffer } from "../src/lineBuffer.ts";

const b = (s: string) => Buffer.from(s, "utf8");

test("returns complete lines and keeps the partial tail", () => {
  const lb = new LineBuffer();
  assert.deepEqual(lb.push(b('{"a":1}\n{"b":')), ['{"a":1}']);
  assert.equal(lb.pendingBytes, 5);
  assert.deepEqual(lb.push(b('2}\n')), ['{"b":2}']);
  assert.equal(lb.pendingBytes, 0);
});

test("keeps a UTF-8 character split across chunks intact", () => {
  const lb = new LineBuffer();
  const bytes = b("café\n");
  assert.deepEqual(lb.push(bytes.subarray(0, 4)), []);
  assert.deepEqual(lb.push(bytes.subarray(4)), ["café"]);
});

test("strips CR and drops empty lines", () => {
  const lb = new LineBuffer();
  assert.deepEqual(lb.push(b("one\r\n\n\ntwo\n")), ["one", "two"]);
});

test("reset discards the partial tail", () => {
  const lb = new LineBuffer();
  lb.push(b("half"));
  lb.reset();
  assert.equal(lb.pendingBytes, 0);
  assert.deepEqual(lb.push(b("whole\n")), ["whole"]);
});

test("a CR split from its LF across chunks is still stripped", () => {
  const lb = new LineBuffer();
  assert.deepEqual(lb.push(b("one\r")), []);
  assert.deepEqual(lb.push(b("\ntwo\n")), ["one", "two"]);
});

test("a lone CRLF line is dropped as empty", () => {
  const lb = new LineBuffer();
  assert.deepEqual(lb.push(b("\r\n")), []);
  assert.deepEqual(lb.push(b("a\n\r\nb\n")), ["a", "b"]);
});

test("a line split over many chunks is joined once", () => {
  const lb = new LineBuffer();
  for (const ch of "abcdef") assert.deepEqual(lb.push(b(ch)), []);
  assert.equal(lb.pendingBytes, 6);
  assert.deepEqual(lb.push(b("\n")), ["abcdef"]);
});

test("invalid UTF-8 lines are skipped and counted", () => {
  const lb = new LineBuffer();
  const bad = Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]);
  assert.deepEqual(lb.push(Buffer.concat([bad, b("ok\n")])), ["ok"]);
  assert.equal(lb.invalidUtf8Lines, 1);
});

test("a line longer than the cap is dropped and counted, the next line survives", () => {
  const lb = new LineBuffer({ maxLineBytes: 8 });
  assert.deepEqual(lb.push(b("0123456")), []);
  assert.deepEqual(lb.push(b("789abc")), []);
  assert.equal(lb.pendingBytes, 0);
  assert.deepEqual(lb.push(b("def\nshort\n")), ["short"]);
  assert.equal(lb.oversizedLines, 1);
});

test("an over-cap line inside one chunk is dropped and counted", () => {
  const lb = new LineBuffer({ maxLineBytes: 4 });
  assert.deepEqual(lb.push(b("toolong\nok\n")), ["ok"]);
  assert.equal(lb.oversizedLines, 1);
});

test("pushed bytes are copied, so reusing the caller's buffer is safe", () => {
  const lb = new LineBuffer();
  const buf = b("abc");
  lb.push(buf);
  buf.fill(0x78);
  assert.deepEqual(lb.push(b("\n")), ["abc"]);
});
```

- [ ] **Step 2: Run them**

Run: `cd companiond && node --test test/lineBuffer.test.ts`
Expected: FAIL in "invalid UTF-8 lines are skipped and counted" and both cap tests. The CR, CRLF, many-chunks and copy tests already pass; they pin current behaviour.

- [ ] **Step 3: Implement** — replace `companiond/src/lineBuffer.ts` with:

```ts
export interface LineBufferOptions {
  /** Longest line kept, in bytes. Longer lines are dropped and counted. */
  maxLineBytes?: number;
}

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

export class LineBuffer {
  #chunks: Buffer[] = [];
  #pending = 0;
  #discarding = false;
  #invalidUtf8 = 0;
  #oversized = 0;
  readonly #max: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(options: LineBufferOptions = {}) {
    this.#max = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    let nl = chunk.indexOf(0x0a, start);
    while (nl !== -1) {
      const piece = chunk.subarray(start, nl);
      if (this.#discarding) {
        this.#discarding = false;
      } else if (this.#pending + piece.length > this.#max) {
        this.#oversized++;
      } else {
        const bytes = this.#chunks.length
          ? Buffer.concat([...this.#chunks, piece], this.#pending + piece.length)
          : piece;
        this.#emit(bytes, lines);
      }
      this.#chunks = [];
      this.#pending = 0;
      start = nl + 1;
      nl = chunk.indexOf(0x0a, start);
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0 && !this.#discarding) {
      if (this.#pending + rest.length > this.#max) {
        this.#oversized++;
        this.#discarding = true;
        this.#chunks = [];
        this.#pending = 0;
      } else {
        this.#chunks.push(Buffer.from(rest));
        this.#pending += rest.length;
      }
    }
    return lines;
  }

  #emit(bytes: Buffer, lines: string[]): void {
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === 0x0d) end--;
    if (end === 0) return;
    try {
      lines.push(this.#decoder.decode(bytes.subarray(0, end)));
    } catch {
      this.#invalidUtf8++;
    }
  }

  get pendingBytes(): number {
    return this.#pending;
  }

  /** Complete lines dropped because they were not valid UTF-8. */
  get invalidUtf8Lines(): number {
    return this.#invalidUtf8;
  }

  /** Lines dropped because they exceeded maxLineBytes. */
  get oversizedLines(): number {
    return this.#oversized;
  }

  reset(): void {
    this.#chunks = [];
    this.#pending = 0;
    this.#discarding = false;
  }
}
```

- [ ] **Step 4: Run tests, M2's jail tests, and type-check**

Run: `cd companiond && node --test test/lineBuffer.test.ts && node --test "test/jail/*.test.ts" && npm run typecheck`
Expected: 11 pass in `lineBuffer.test.ts`; every M2 jail test still passes (including `noWrites.test.ts`, which scans `lineBuffer.ts`); `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/lineBuffer.ts companiond/test/lineBuffer.test.ts
git commit -m "feat(companiond): cap, chunk-list and strict UTF-8 in LineBuffer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Keep the jail's framing replies with the new `LineBuffer`

M2's `serveStdio` (`src/jail/mcpServer.ts`) replies `-32700 Parse error` to a line that is not JSON and `-32700 Message too large` when `pendingBytes` passes 1 MiB. After Task 2, an invalid UTF-8 line is dropped inside `LineBuffer`, so without this change the client would get no reply at all. This task makes the jail reply to every line `LineBuffer` drops, and moves the 1 MiB cap into `LineBuffer`.

**Files:**
- Modify: `companiond/src/jail/mcpServer.ts` (M2's file; the `serveStdio` function only)
- Test: `companiond/test/jail/stdioFraming.test.ts`

**Interfaces:**
- Consumes: `LineBuffer` (Task 2); M2's `serveStdio(state, input, output)`, `ServerState`.
- Produces: no new API. Behaviour: each invalid UTF-8 line → one `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`; each line over 1 MiB → one `-32700 "Message too large"`; later lines are still served.

- [ ] **Step 1: Write the failing test** — `companiond/test/jail/stdioFraming.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serveStdio } from "../../src/jail/mcpServer.ts";

async function run(chunks: Buffer[]): Promise<Array<{ id: unknown; error?: { code: number; message: string } }>> {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (c: Buffer) => {
    text += c.toString("utf8");
  });
  const done = serveStdio({ kind: "refused", reason: "SYNTHETIC FIXTURE" }, input, output);
  for (const c of chunks) input.write(c);
  input.end();
  await done;
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("an invalid UTF-8 line still gets a -32700 Parse error reply", async () => {
  const replies = await run([Buffer.from([0x7b, 0xff, 0x7d, 0x0a])]);
  assert.deepEqual(replies, [{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }]);
});

test("a line over 1 MiB gets one 'Message too large' reply and the next request is still served", async () => {
  const big = Buffer.alloc(1024 * 1024 + 10, 0x61);
  const next = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) + "\n");
  const replies = await run([big, Buffer.from("\n"), next]);
  const tooLarge = replies.filter((r) => r.error?.message === "Message too large");
  assert.equal(tooLarge.length, 1);
  assert.equal(tooLarge[0].error?.code, -32700);
  assert.equal(replies.filter((r) => r.id === 7).length, 1);
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/jail/stdioFraming.test.ts`
Expected: FAIL in the first test (no reply arrives, `replies` is `[]`).

- [ ] **Step 3: Implement** — in `companiond/src/jail/mcpServer.ts`, inside `serveStdio`, replace

```ts
  const lb = new LineBuffer();
```

with

```ts
  const lb = new LineBuffer({ maxLineBytes: MAX_LINE_BYTES });
  let repliedInvalid = 0;
  let repliedOversized = 0;
```

and replace the `data` handler

```ts
    input.on("data", (chunk: Buffer) => {
      for (const line of lb.push(chunk)) chain = chain.then(() => handleLine(line));
      if (lb.pendingBytes > MAX_LINE_BYTES) {
        lb.reset();
        chain = chain.then(() => send(rpcError(null, -32700, "Message too large")));
      }
    });
```

with

```ts
    input.on("data", (chunk: Buffer) => {
      for (const line of lb.push(chunk)) chain = chain.then(() => handleLine(line));
      // Lines LineBuffer drops still get a reply, so a client never waits forever.
      while (repliedInvalid < lb.invalidUtf8Lines) {
        repliedInvalid++;
        chain = chain.then(() => send(rpcError(null, -32700, "Parse error")));
      }
      while (repliedOversized < lb.oversizedLines) {
        repliedOversized++;
        chain = chain.then(() => send(rpcError(null, -32700, "Message too large")));
      }
    });
```

- [ ] **Step 4: Run the jail tests and type-check**

Run: `cd companiond && node --test "test/jail/*.test.ts" && npm run typecheck`
Expected: 2 pass in `stdioFraming.test.ts`; every other M2 jail test still passes; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/jail/mcpServer.ts companiond/test/jail/stdioFraming.test.ts
git commit -m "fix(jail): reply to lines dropped by the stricter LineBuffer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Read-only file access, Claude paths and Claude fixture builders

**Files:**
- Create: `companiond/src/claude/readFs.ts`
- Create: `companiond/src/claude/paths.ts`
- Modify: `companiond/test/helpers/fixtures.ts` (M2's file: add two imports, append Claude builders)
- Test: `companiond/test/claude/readFs.test.ts`

**Interfaces:**
- Consumes: M2 fixtures `MARK`, `tempDir`, `removeTempDirs`, `makeRepo`, `makeWorktree`.
- Produces:
  - `interface FileStat { dev: number; ino: number; size: number; mtimeMs: number; isFile(): boolean; isDirectory(): boolean }`
  - `interface RangeRead { buf: Buffer; dev: number; ino: number }` — identity from `fstat` of the open handle.
  - `interface ReadFs { readdir(dir: string): Promise<string[]>; stat(p: string): Promise<FileStat>; readRange(file: string, position: number, length: number): Promise<RangeRead>; realpath(p: string): Promise<string> }`
  - `const nodeReadFs: ReadFs`; `guardReadFs(inner: ReadFs, onRefused?: (basename: string) => void): ReadFs` (throws `RefusedPathError` for a `*.key` basename, case-insensitive, before calling inner, and for a realpath result that lands on one); `class RefusedPathError extends Error`; `readJsonFile(fs: ReadFs, file: string): Promise<unknown>` (null if missing, > 1 MiB, or not JSON; rethrows `RefusedPathError`); `MAX_JSON_FILE_BYTES`.
  - `interface ClaudePaths { desktopSessionsDir: string; projectsDir: string; runningDir: string }`; `defaultClaudePaths(home: string): ClaudePaths`; `encodeCwd(cwd: string): string`; `isSafeId(id: unknown): id is string` (`/^[A-Za-z0-9_-]{1,128}$/`); `toEpochMs(v: unknown): number | null` (numbers below 1e11 are seconds).
  - Test helpers added to `test/helpers/fixtures.ts`: `claudeTree()` → `ClaudePaths & { root }`, `RecordFields`, `writeRecord(p, fields, org?, account?)`, `writeRunning(p, pid, fields)`, `userLine(sessionId, cwd, text, extra?)`, `assistantLine(sessionId, cwd, content, extra?)`, `markerLine(sessionId)`, `transcriptPath(p, cwd, cliSessionId, folder?)`, `writeTranscript(file, sessionId, lines)`, `appendLines(file, lines)`, `repoWithWorktree()` → `{ main, worktree }` (thin wrapper: `makeRepo()` + `makeWorktree(main, "feature-a")`).

- [ ] **Step 1: Extend the fixture builders** — in `companiond/test/helpers/fixtures.ts` (from M2), add below the existing imports:

```ts
import type { ClaudePaths } from "../../src/claude/paths.ts";
import { encodeCwd } from "../../src/claude/paths.ts";
```

and append at the end of the file:

```ts
// ---- M3: Claude data builders (SYNTHETIC FIXTURE). Everything goes into tempDir() folders. ----

export function claudeTree(): ClaudePaths & { root: string } {
  const root = tempDir("cgc-claude-");
  const p = {
    root,
    desktopSessionsDir: path.join(root, "desktop", "claude-code-sessions"),
    projectsDir: path.join(root, "home", ".claude", "projects"),
    runningDir: path.join(root, "home", ".claude", "sessions"),
  };
  for (const d of [p.desktopSessionsDir, p.projectsDir, p.runningDir]) fs.mkdirSync(d, { recursive: true });
  return p;
}

export interface RecordFields {
  sessionId: string;
  cliSessionId: string;
  cwd: string;
  title?: string;
  lastFocusedAt?: number | string;
  lastActivityAt?: number | string;
  isArchived?: boolean;
  branch?: string;
}

export function writeRecord(p: ClaudePaths, r: RecordFields, org = "org-syn", account = "acct-syn"): string {
  const dir = path.join(p.desktopSessionsDir, org, account);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${r.sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify({ _fixture: MARK, title: `${MARK} ${r.sessionId}`, ...r }));
  return file;
}

export function writeRunning(p: ClaudePaths, pid: number, fields: Record<string, unknown>): string {
  const file = path.join(p.runningDir, `${pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ _fixture: MARK, pid, ...fields }));
  return file;
}

let uuidSeq = 0;
export function userLine(sessionId: string, cwd: string, text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    uuid: `u-${++uuidSeq}`,
    sessionId,
    cwd,
    gitBranch: "syn-branch",
    timestamp: "2026-11-04T10:00:00.000Z",
    message: { role: "user", content: text },
    ...extra,
  });
}

export function assistantLine(sessionId: string, cwd: string, content: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `a-${++uuidSeq}`,
    sessionId,
    cwd,
    timestamp: "2026-11-04T10:00:01.000Z",
    message: { role: "assistant", content },
    ...extra,
  });
}

export function markerLine(sessionId: string): string {
  return JSON.stringify({ type: "custom-title", sessionId, customTitle: MARK });
}

/** `<projectsDir>/<encoded cwd>/<cliSessionId>.jsonl`. */
export function transcriptPath(p: ClaudePaths, cwd: string, cliSessionId: string, folder = encodeCwd(cwd)): string {
  return path.join(p.projectsDir, folder, `${cliSessionId}.jsonl`);
}

/** First line carries the marker. */
export function writeTranscript(file: string, sessionId: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [markerLine(sessionId), ...lines].map((l) => l + "\n").join(""));
}

export function appendLines(file: string, lines: string[]): void {
  fs.appendFileSync(file, lines.map((l) => l + "\n").join(""));
}

/** M2's makeRepo + makeWorktree, with the worktree on branch `feature-a`. */
export function repoWithWorktree(): { main: string; worktree: string } {
  const main = makeRepo();
  return { main, worktree: makeWorktree(main, "feature-a") };
}
```

- [ ] **Step 2: Write the failing test** — `companiond/test/claude/readFs.test.ts`:

```ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardReadFs, nodeReadFs, readJsonFile, RefusedPathError } from "../../src/claude/readFs.ts";
import { encodeCwd, isSafeId, toEpochMs } from "../../src/claude/paths.ts";
import { MARK, removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);

test("readRange returns the slice, fewer bytes at end of file, and the handle's identity", async () => {
  const dir = tempDir();
  const f = path.join(dir, "a.txt");
  fs.writeFileSync(f, `${MARK}-0123456789`);
  const off = MARK.length + 1;
  const r = await nodeReadFs.readRange(f, off, 4);
  assert.equal(r.buf.toString(), "0123");
  assert.equal(r.ino, fs.statSync(f).ino);
  assert.equal((await nodeReadFs.readRange(f, off + 8, 100)).buf.toString(), "89");
});

test("guardReadFs refuses .key files before touching them and reports the basename", async () => {
  const dir = tempDir();
  const key = path.join(dir, "123.key");
  fs.writeFileSync(key, MARK);
  const refused: string[] = [];
  const g = guardReadFs(nodeReadFs, (b) => refused.push(b));
  await assert.rejects(g.readRange(key, 0, 10), RefusedPathError);
  await assert.rejects(g.stat(path.join(dir, "X.KEY")), RefusedPathError);
  await assert.rejects(readJsonFile(g, key), RefusedPathError);
  assert.deepEqual(refused, ["123.key", "X.KEY", "123.key"]);
});

test("guardReadFs refuses a realpath that lands on a .key file", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "9.key"), MARK);
  fs.symlinkSync(path.join(dir, "9.key"), path.join(dir, "innocent.json"));
  await assert.rejects(guardReadFs(nodeReadFs).realpath(path.join(dir, "innocent.json")), RefusedPathError);
});

test("readJsonFile returns null for missing, non-JSON and oversized files", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "bad.json"), `{not json ${MARK}`);
  fs.writeFileSync(path.join(dir, "big.json"), JSON.stringify({ m: MARK, pad: "x".repeat(1024 * 1024) }));
  fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ m: MARK }));
  assert.equal(await readJsonFile(nodeReadFs, path.join(dir, "missing.json")), null);
  assert.equal(await readJsonFile(nodeReadFs, path.join(dir, "bad.json")), null);
  assert.equal(await readJsonFile(nodeReadFs, path.join(dir, "big.json")), null);
  assert.deepEqual(await readJsonFile(nodeReadFs, path.join(dir, "ok.json")), { m: MARK });
});

test("encodeCwd replaces every non-alphanumeric character", () => {
  assert.equal(encodeCwd("/tmp/a b/c.d_e"), "-tmp-a-b-c-d-e");
});

test("isSafeId accepts only plain ids", () => {
  assert.ok(isSafeId("cli-syn-1"));
  for (const bad of ["", "../x", "a/b", "a.b", 7, null, "x".repeat(129)]) assert.equal(isSafeId(bad), false);
});

test("toEpochMs reads ms, seconds, numeric strings and ISO strings", () => {
  assert.equal(toEpochMs(1793800000000), 1793800000000);
  assert.equal(toEpochMs(1793800000), 1793800000000);
  assert.equal(toEpochMs("1793800000000"), 1793800000000);
  assert.equal(toEpochMs("2026-11-04T10:00:00.000Z"), Date.UTC(2026, 10, 4, 10));
  assert.equal(toEpochMs("never"), null);
  assert.equal(toEpochMs(undefined), null);
});

// ---- Static checks over the M3 folders (spec §6.1, §7.7) ----

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const M3_DIRS = ["claude", "transcript", "worktree", "bridge"];
const m3Files = M3_DIRS.flatMap((d) =>
  fs.existsSync(path.join(src, d)) ? fs.readdirSync(path.join(src, d)).filter((f) => f.endsWith(".ts")).map((f) => path.join(d, f)) : [],
);
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const WRITE_NAMES =
  "writeFile|appendFile|createWriteStream|rename|unlink|rm|rmdir|mkdir|mkdtemp|copyFile|cp|symlink|link|" +
  "truncate|ftruncate|chmod|fchmod|lchmod|chown|fchown|lchown|utimes|futimes|lutimes|write|writev";
const FORBIDDEN: Array<[string, RegExp]> = [
  ["write call", new RegExp(`\\.(${WRITE_NAMES})(Sync)?\\s*\\(`)],
  ["named write import", new RegExp(`import\\s*\\{[^}]*\\b(${WRITE_NAMES})(Sync)?\\b[^}]*\\}\\s*from\\s*["']node:fs(/promises)?["']`)],
  ["write open flag", /\bO_(WRONLY|RDWR|CREAT|TRUNC|APPEND)\b/],
  ["string write flag", /open(Sync)?\([^)]*,\s*["'`](w|a|r\+|wx|ax|as|rs\+)/],
  ["network module", /["'](node:)?(net|dgram|tls|http2?|https|dns)["']/],
  ["fetch or websocket", /\bfetch\s*\(|\bWebSocket\b/],
  ["connect call", /\.connect\s*\(|createConnection\s*\(/],
];

test("the M3 folders are scanned", () => {
  for (const f of ["claude/readFs.ts", "claude/paths.ts"]) assert.ok(m3Files.includes(f), f);
});

test("M3 code has no write, delete, network or socket calls", () => {
  for (const f of m3Files) {
    const text = stripComments(fs.readFileSync(path.join(src, f), "utf8"));
    for (const [what, re] of FORBIDDEN) assert.doesNotMatch(text, re, `${f}: ${what}`);
    assert.doesNotMatch(text, /messagingSocketPath/, `${f}: messagingSocketPath`);
  }
});

test("only claude/processProbe.ts imports node:child_process (M3 never spawns git)", () => {
  for (const f of m3Files) {
    const text = fs.readFileSync(path.join(src, f), "utf8");
    if (f === path.join("claude", "processProbe.ts")) continue;
    assert.doesNotMatch(text, /["']node:child_process["']|["']child_process["']/, f);
  }
});

test("lineBuffer.ts imports nothing", () => {
  assert.doesNotMatch(fs.readFileSync(path.join(src, "lineBuffer.ts"), "utf8"), /^\s*import\s/m);
});
```

- [ ] **Step 3: Run it**

Run: `cd companiond && node --test test/claude/readFs.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/claude/readFs.ts`.

- [ ] **Step 4: Implement** — `companiond/src/claude/readFs.ts`:

```ts
import * as fsp from "node:fs/promises";
import path from "node:path";

export interface FileStat {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface RangeRead {
  /** Up to `length` bytes; fewer at end of file. */
  buf: Buffer;
  /** Identity of the file actually read (fstat of the open handle). */
  dev: number;
  ino: number;
}

/** The only file-system surface the session code gets. It has no write method. */
export interface ReadFs {
  readdir(dir: string): Promise<string[]>;
  stat(p: string): Promise<FileStat>;
  readRange(file: string, position: number, length: number): Promise<RangeRead>;
  realpath(p: string): Promise<string>;
}

export const nodeReadFs: ReadFs = {
  readdir: (dir) => fsp.readdir(dir),
  stat: (p) => fsp.stat(p),
  async readRange(file, position, length) {
    const fh = await fsp.open(file, "r");
    try {
      const st = await fh.stat();
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      return { buf: buf.subarray(0, bytesRead), dev: st.dev, ino: st.ino };
    } finally {
      await fh.close();
    }
  },
  realpath: (p) => fsp.realpath(p),
};

export class RefusedPathError extends Error {}

/** Credential files Claude keeps next to running files (spec §6.1). Never opened. */
const REFUSED = /\.key$/i;

/**
 * Wraps a ReadFs so any `.key` file is refused before the call (and a realpath that lands on one is refused
 * after it). `onRefused` gets the basename only. SessionBridge is the one place that wraps; lower-level
 * readers take whatever ReadFs they are given.
 */
export function guardReadFs(inner: ReadFs, onRefused: (basename: string) => void = () => {}): ReadFs {
  const check = (p: string): void => {
    const base = path.basename(p);
    if (REFUSED.test(base)) {
      onRefused(base);
      throw new RefusedPathError(`refused credential file: ${base}`);
    }
  };
  return {
    readdir: (dir) => inner.readdir(dir),
    stat: async (p) => (check(p), inner.stat(p)),
    readRange: async (f, pos, len) => (check(f), inner.readRange(f, pos, len)),
    async realpath(p) {
      check(p);
      const real = await inner.realpath(p);
      check(real);
      return real;
    },
  };
}

export const MAX_JSON_FILE_BYTES = 1024 * 1024;

/** Reads and parses a small JSON file. Returns null if missing, too big, or not JSON. */
export async function readJsonFile(fs: ReadFs, file: string): Promise<unknown> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_JSON_FILE_BYTES) return null;
    const { buf } = await fs.readRange(file, 0, st.size);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch (err) {
    if (err instanceof RefusedPathError) throw err;
    return null;
  }
}
```

`companiond/src/claude/paths.ts`:

```ts
import path from "node:path";

/** Base directories for Claude's data. Tests pass temp dirs; production passes defaultClaudePaths(os.homedir()). */
export interface ClaudePaths {
  /** `~/Library/Application Support/Claude/claude-code-sessions` — `<org>/<account>/local_<id>.json` */
  desktopSessionsDir: string;
  /** `~/.claude/projects` — `<encoded cwd>/<cliSessionId>.jsonl` */
  projectsDir: string;
  /** `~/.claude/sessions` — `<pid>.json` running files (and `*.key` files we never open) */
  runningDir: string;
}

export function defaultClaudePaths(home: string): ClaudePaths {
  return {
    desktopSessionsDir: path.join(home, "Library", "Application Support", "Claude", "claude-code-sessions"),
    projectsDir: path.join(home, ".claude", "projects"),
    runningDir: path.join(home, ".claude", "sessions"),
  };
}

/** Claude's folder name for a cwd: every non-alphanumeric character becomes "-" (lossy, spec §6.1). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Ids from Claude's files are data. Only these are ever used to build a path. */
export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** Accepts epoch ms, epoch seconds, a numeric string, or an ISO/date string. */
export function toEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return toEpochMs(n);
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
```

- [ ] **Step 5: Run tests and type-check**

Run: `cd companiond && node --test test/claude/readFs.test.ts && npm test && npm run typecheck`
Expected: 11 pass in `readFs.test.ts`; the full `npm test` passes (M2's suites still use the same fixtures); `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/claude/readFs.ts companiond/src/claude/paths.ts companiond/test/helpers/fixtures.ts companiond/test/claude/readFs.test.ts
git commit -m "feat(companiond): read-only file access and Claude paths" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Desktop records

**Files:**
- Create: `companiond/src/claude/desktopRecords.ts`
- Test: `companiond/test/claude/desktopRecords.test.ts`

**Interfaces:**
- Consumes: `ReadFs`, `readJsonFile`, `isSafeId`, `toEpochMs` (Task 4).
- Produces: `interface DesktopRecord { sessionId: string; cliSessionId: string | null; cwd: string | null; branch: string | null; title: string; lastFocusedAt: number | null; lastActivityAt: number | null; isArchived: boolean; recordPath: string }`; `interface DesktopRecordsResult { records: DesktopRecord[]; error: string | null; skipped: number; duplicates: number }`; `readDesktopRecords(fs: ReadFs, dir: string): Promise<DesktopRecordsResult>` (one record per `sessionId`; across org/account folders the latest `lastActivityAt` wins); `toDesktopRecord(raw: unknown, recordPath: string): DesktopRecord | null`; `DESKTOP_NOT_FOUND = "Claude Desktop sessions not found"`.

- [ ] **Step 1: Write the failing test** — `companiond/test/claude/desktopRecords.test.ts`:

```ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DESKTOP_NOT_FOUND, readDesktopRecords } from "../../src/claude/desktopRecords.ts";
import { nodeReadFs } from "../../src/claude/readFs.ts";
import { claudeTree, MARK, removeTempDirs, writeRecord } from "../helpers/fixtures.ts";

after(removeTempDirs);

const T0 = Date.UTC(2026, 10, 4, 9);

test("reads records across org and account folders", async () => {
  const p = claudeTree();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 + 2000, lastActivityAt: T0 + 1000 });
  writeRecord(p, { sessionId: "local_syn-b", cliSessionId: "cli-b", cwd: "/syn/b", isArchived: true }, "org-2", "acct-2");
  const res = await readDesktopRecords(nodeReadFs, p.desktopSessionsDir);
  assert.equal(res.error, null);
  const byId = new Map(res.records.map((r) => [r.sessionId, r]));
  assert.equal(byId.get("local_syn-a")?.cliSessionId, "cli-a");
  assert.equal(byId.get("local_syn-a")?.lastFocusedAt, T0 + 2000);
  assert.equal(byId.get("local_syn-b")?.isArchived, true);
});

test("accepts ISO timestamps", async () => {
  const p = claudeTree();
  writeRecord(p, { sessionId: "local_syn-iso", cliSessionId: "cli-iso", cwd: "/syn", lastFocusedAt: "2026-11-04T10:00:00Z" });
  const [r] = (await readDesktopRecords(nodeReadFs, p.desktopSessionsDir)).records;
  assert.equal(r.lastFocusedAt, Date.UTC(2026, 10, 4, 10));
});

test("the same sessionId in two account folders is kept once, latest activity wins", async () => {
  const p = claudeTree();
  writeRecord(p, { sessionId: "local_syn-d", cliSessionId: "cli-old", cwd: "/syn", lastActivityAt: T0 }, "org-1", "acct-1");
  writeRecord(p, { sessionId: "local_syn-d", cliSessionId: "cli-new", cwd: "/syn", lastActivityAt: T0 + 5 }, "org-2", "acct-2");
  const res = await readDesktopRecords(nodeReadFs, p.desktopSessionsDir);
  assert.deepEqual(res.records.map((r) => r.cliSessionId), ["cli-new"]);
  assert.equal(res.duplicates, 1);
});

test("skips broken files and ignores other names; unsafe cliSessionId becomes null", async () => {
  const p = claudeTree();
  const dir = path.dirname(writeRecord(p, { sessionId: "local_syn-ok", cliSessionId: "../escape", cwd: "/syn" }));
  fs.writeFileSync(path.join(dir, "local_syn-bad.json"), `{${MARK}`);
  fs.writeFileSync(path.join(dir, "notes.json"), JSON.stringify({ sessionId: MARK }));
  const res = await readDesktopRecords(nodeReadFs, p.desktopSessionsDir);
  assert.equal(res.records.length, 1);
  assert.equal(res.records[0].cliSessionId, null);
  assert.equal(res.skipped, 1);
});

test("a missing records directory reports 'Claude Desktop sessions not found'", async () => {
  const p = claudeTree();
  fs.rmSync(p.desktopSessionsDir, { recursive: true });
  const res = await readDesktopRecords(nodeReadFs, p.desktopSessionsDir);
  assert.equal(res.error, DESKTOP_NOT_FOUND);
  assert.deepEqual(res.records, []);
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/claude/desktopRecords.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/claude/desktopRecords.ts`.

- [ ] **Step 3: Implement** — `companiond/src/claude/desktopRecords.ts`:

```ts
import path from "node:path";
import type { ReadFs } from "./readFs.ts";
import { readJsonFile } from "./readFs.ts";
import { isSafeId, toEpochMs } from "./paths.ts";

export interface DesktopRecord {
  /** Desktop session id (`local_…`). Stable for the life of the desktop session. */
  sessionId: string;
  /** Current CLI session id; names the transcript file. Null if absent or unsafe. */
  cliSessionId: string | null;
  cwd: string | null;
  branch: string | null;
  title: string;
  lastFocusedAt: number | null;
  lastActivityAt: number | null;
  isArchived: boolean;
  recordPath: string;
}

export interface DesktopRecordsResult {
  records: DesktopRecord[];
  /** Set when the records directory cannot be read at all (spec §6.2). */
  error: string | null;
  /** Record files that were not valid records. */
  skipped: number;
  /** Records dropped because another org/account folder had the same sessionId (latest activity kept). */
  duplicates: number;
}

export const DESKTOP_NOT_FOUND = "Claude Desktop sessions not found";

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function toDesktopRecord(raw: unknown, recordPath: string): DesktopRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sessionId = str(r.sessionId);
  if (sessionId === null) return null;
  return {
    sessionId,
    cliSessionId: isSafeId(r.cliSessionId) ? r.cliSessionId : null,
    cwd: str(r.cwd),
    branch: str(r.branch),
    title: str(r.title) ?? "Untitled session",
    lastFocusedAt: toEpochMs(r.lastFocusedAt),
    lastActivityAt: toEpochMs(r.lastActivityAt),
    isArchived: r.isArchived === true,
    recordPath,
  };
}

async function listDirs(fs: ReadFs, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await fs.readdir(dir)) {
    try {
      if ((await fs.stat(path.join(dir, name))).isDirectory()) out.push(name);
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

/** Reads `<dir>/<org>/<account>/local_*.json`. Read-only. */
export async function readDesktopRecords(fs: ReadFs, dir: string): Promise<DesktopRecordsResult> {
  let orgs: string[];
  try {
    orgs = await listDirs(fs, dir);
  } catch {
    return { records: [], error: DESKTOP_NOT_FOUND, skipped: 0, duplicates: 0 };
  }
  const byId = new Map<string, DesktopRecord>();
  let skipped = 0;
  let duplicates = 0;
  for (const org of orgs.sort()) {
    let accounts: string[] = [];
    try {
      accounts = await listDirs(fs, path.join(dir, org));
    } catch {
      continue;
    }
    for (const account of accounts) {
      const accDir = path.join(dir, org, account);
      let names: string[] = [];
      try {
        names = await fs.readdir(accDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/^local_[A-Za-z0-9_-]+\.json$/.test(name)) continue;
        const file = path.join(accDir, name);
        const rec = toDesktopRecord(await readJsonFile(fs, file), file);
        if (!rec) {
          skipped++;
          continue;
        }
        const prev = byId.get(rec.sessionId);
        if (prev) {
          duplicates++;
          if ((rec.lastActivityAt ?? -Infinity) <= (prev.lastActivityAt ?? -Infinity)) continue;
        }
        byId.set(rec.sessionId, rec);
      }
    }
  }
  return { records: [...byId.values()], error: null, skipped, duplicates };
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `cd companiond && node --test test/claude/desktopRecords.test.ts && npm run typecheck`
Expected: 5 pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/claude/desktopRecords.ts companiond/test/claude/desktopRecords.test.ts
git commit -m "feat(companiond): read Claude Desktop session records" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Running files and busy/idle status

Spec §6.2: a running file counts only if the pid is alive, its start time matches `procStart`, and `entrypoint == "claude-desktop"`. `process.kill(pid, 0)` sends no signal; it only checks the pid. pids ≤ 1 are refused before any call (0 and -1 address process groups). The pid comes from the file name; a body `pid` that disagrees means the file is skipped. An unknown `status` from a live, matching process counts as busy. `cacheStartTimes` runs `ps` once per live pid.

**Files:**
- Create: `companiond/src/claude/runningFiles.ts`
- Create: `companiond/src/claude/processProbe.ts`
- Test: `companiond/test/claude/runningFiles.test.ts`

**Interfaces:**
- Consumes: `ReadFs`, `readJsonFile`, `toEpochMs` (Task 4).
- Produces: `interface RunningFile { pid: number; sessionId: string; status: string; entrypoint: string; procStartMs: number | null; file: string }`; `interface ProcessProbe { isAlive(pid: number): boolean; startTimeMs(pid: number): Promise<number | null> }`; `type LiveState = "busy" | "idle"`; `type StaleReason = "bad_pid" | "dead_pid" | "start_unknown" | "start_mismatch" | "not_desktop"`; `type RunningCheck = { live: true; state: LiveState } | { live: false; reason: StaleReason }`; `readRunningFiles(fs, dir): Promise<RunningFile[]>` (only `<digits>.json`); `checkRunningFile(rf, probe): Promise<RunningCheck>`; `liveStates(files, probe): Promise<Map<string, LiveState>>` (key = cliSessionId, busy wins); `cacheStartTimes(probe): ProcessProbe`; `START_TOLERANCE_MS = 2000`; `nodeProcessProbe: ProcessProbe`.

- [ ] **Step 1: Write the failing test** — `companiond/test/claude/runningFiles.test.ts`:

```ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ProcessProbe, RunningFile } from "../../src/claude/runningFiles.ts";
import { cacheStartTimes, checkRunningFile, liveStates, readRunningFiles } from "../../src/claude/runningFiles.ts";
import { nodeProcessProbe } from "../../src/claude/processProbe.ts";
import { guardReadFs, nodeReadFs } from "../../src/claude/readFs.ts";
import { claudeTree, MARK, removeTempDirs, writeRunning } from "../helpers/fixtures.ts";

after(removeTempDirs);

const START = Date.UTC(2026, 10, 4, 9);

function fakeProbe(procs: Record<number, number>): ProcessProbe {
  return {
    isAlive: (pid) => pid in procs,
    startTimeMs: async (pid) => procs[pid] ?? null,
  };
}

const rf = (over: Partial<RunningFile> = {}): RunningFile => ({
  pid: 4242,
  sessionId: "cli-a",
  status: "busy",
  entrypoint: "claude-desktop",
  procStartMs: START,
  file: "/syn/4242.json",
  ...over,
});

test("lists only <pid>.json and never opens .key files or keeps the socket path", async () => {
  const p = claudeTree();
  writeRunning(p, 4242, { sessionId: "cli-a", status: "busy", entrypoint: "claude-desktop", procStart: START, messagingSocketPath: "/syn/sock" });
  fs.writeFileSync(path.join(p.runningDir, "4242.key"), MARK);
  fs.writeFileSync(path.join(p.runningDir, "notes.json"), JSON.stringify({ sessionId: MARK }));
  const opened: string[] = [];
  const spy = guardReadFs({
    ...nodeReadFs,
    readRange: (f, pos, len) => (opened.push(f), nodeReadFs.readRange(f, pos, len)),
  });
  const files = await readRunningFiles(spy, p.runningDir);
  assert.equal(files.length, 1);
  assert.deepEqual(opened.map((f) => path.basename(f)), ["4242.json"]);
  assert.equal(files[0].procStartMs, START);
  assert.equal(JSON.stringify(files).includes("/syn/sock"), false);
});

test("a body pid that disagrees with the file name is skipped", async () => {
  const p = claudeTree();
  fs.writeFileSync(path.join(p.runningDir, "500.json"), JSON.stringify({ _fixture: MARK, pid: 501, sessionId: "cli-a" }));
  assert.deepEqual(await readRunningFiles(nodeReadFs, p.runningDir), []);
});

test("§12.2 stale running file: dead pid", async () => {
  assert.deepEqual(await checkRunningFile(rf(), fakeProbe({})), { live: false, reason: "dead_pid" });
});

test("§12.2 stale running file: reused pid with a different start time", async () => {
  const c = await checkRunningFile(rf(), fakeProbe({ 4242: START + 60_000 }));
  assert.deepEqual(c, { live: false, reason: "start_mismatch" });
});

test("§12.2 stale running file: CLI entrypoint", async () => {
  const c = await checkRunningFile(rf({ entrypoint: "cli" }), fakeProbe({ 4242: START }));
  assert.deepEqual(c, { live: false, reason: "not_desktop" });
});

test("pid 0, 1 and negatives are never probed", async () => {
  for (const pid of [0, 1, -1]) assert.deepEqual(await checkRunningFile(rf({ pid }), fakeProbe({ [pid]: START })), { live: false, reason: "bad_pid" });
});

test("a live desktop file within tolerance gives busy or idle; unknown status counts as busy", async () => {
  assert.deepEqual(await checkRunningFile(rf(), fakeProbe({ 4242: START + 999 })), { live: true, state: "busy" });
  assert.deepEqual(await checkRunningFile(rf({ status: "idle" }), fakeProbe({ 4242: START })), { live: true, state: "idle" });
  assert.deepEqual(await checkRunningFile(rf({ status: "waiting" }), fakeProbe({ 4242: START })), { live: true, state: "busy" });
});

test("liveStates maps cliSessionId to state and prefers busy", async () => {
  const m = await liveStates(
    [rf({ pid: 10, status: "idle" }), rf({ pid: 11, status: "busy" }), rf({ pid: 12, sessionId: "cli-b", status: "idle" })],
    fakeProbe({ 10: START, 11: START, 12: START }),
  );
  assert.equal(m.get("cli-a"), "busy");
  assert.equal(m.get("cli-b"), "idle");
});

test("cacheStartTimes asks once per live pid and forgets dead pids", async () => {
  const procs: Record<number, number> = { 7: START };
  let asked = 0;
  const probe = cacheStartTimes({ isAlive: (pid) => pid in procs, startTimeMs: async (pid) => (asked++, procs[pid] ?? null) });
  for (let i = 0; i < 3; i++) assert.deepEqual(await checkRunningFile(rf({ pid: 7 }), probe), { live: true, state: "busy" });
  assert.equal(asked, 1);
  delete procs[7];
  assert.equal(probe.isAlive(7), false);
  procs[7] = START + 60_000;
  assert.deepEqual(await checkRunningFile(rf({ pid: 7 }), probe), { live: false, reason: "start_mismatch" });
  assert.equal(asked, 2);
});

test("the real probe sees this process alive with a plausible start time", async () => {
  assert.equal(nodeProcessProbe.isAlive(process.pid), true);
  const started = await nodeProcessProbe.startTimeMs(process.pid);
  assert.ok(started !== null);
  const expected = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(started - expected) < 5000, `start ${started} vs ${expected}`);
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/claude/runningFiles.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/claude/runningFiles.ts`.

- [ ] **Step 3: Implement** — `companiond/src/claude/runningFiles.ts`:

```ts
import path from "node:path";
import type { ReadFs } from "./readFs.ts";
import { readJsonFile } from "./readFs.ts";
import { toEpochMs } from "./paths.ts";

export interface RunningFile {
  pid: number;
  /** Equals the desktop record's cliSessionId. */
  sessionId: string;
  status: string;
  entrypoint: string;
  /** Process start time from the file, in epoch ms; null if absent or unparseable. */
  procStartMs: number | null;
  file: string;
}

export interface ProcessProbe {
  isAlive(pid: number): boolean;
  /** Start time of a live process in epoch ms, or null if unknown. */
  startTimeMs(pid: number): Promise<number | null>;
}

export type LiveState = "busy" | "idle";
export type StaleReason = "bad_pid" | "dead_pid" | "start_unknown" | "start_mismatch" | "not_desktop";
export type RunningCheck = { live: true; state: LiveState } | { live: false; reason: StaleReason };

/** `ps -o lstart` has 1 s resolution and truncates. */
export const START_TOLERANCE_MS = 2000;

/** Only `<digits>.json`. `*.key` and every other name are never listed or opened (spec §6.1). */
const RUNNING_NAME = /^[1-9][0-9]{0,9}\.json$/;

export async function readRunningFiles(fs: ReadFs, dir: string): Promise<RunningFile[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: RunningFile[] = [];
  for (const name of names) {
    if (!RUNNING_NAME.test(name)) continue;
    const file = path.join(dir, name);
    const raw = await readJsonFile(fs, file);
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.sessionId !== "string") continue;
    const filePid = Number(name.slice(0, -5));
    // A body pid that disagrees with the file name is a corrupt or foreign file: skip it.
    if (r.pid !== undefined && r.pid !== filePid) continue;
    // Only the fields below are kept; the socket path field is never read (spec §6.1).
    out.push({
      pid: filePid,
      sessionId: r.sessionId,
      status: typeof r.status === "string" ? r.status : "",
      entrypoint: typeof r.entrypoint === "string" ? r.entrypoint : "",
      procStartMs: toEpochMs(r.procStart),
      file,
    });
  }
  return out;
}

/** Spec §6.2: live only if pid alive, start time matches procStart, and entrypoint is claude-desktop. */
export async function checkRunningFile(rf: RunningFile, probe: ProcessProbe): Promise<RunningCheck> {
  if (!Number.isSafeInteger(rf.pid) || rf.pid <= 1) return { live: false, reason: "bad_pid" };
  if (rf.entrypoint !== "claude-desktop") return { live: false, reason: "not_desktop" };
  if (!probe.isAlive(rf.pid)) return { live: false, reason: "dead_pid" };
  const actual = await probe.startTimeMs(rf.pid);
  if (actual === null || rf.procStartMs === null) return { live: false, reason: "start_unknown" };
  if (Math.abs(actual - rf.procStartMs) > START_TOLERANCE_MS) return { live: false, reason: "start_mismatch" };
  return { live: true, state: rf.status === "idle" ? "idle" : "busy" };
}

/**
 * Caches start times of live pids so `ps` runs once per process, not once per poll. An entry is dropped as
 * soon as its pid is seen dead, so pid reuse is caught unless the pid dies and is reused within one poll.
 */
export function cacheStartTimes(probe: ProcessProbe): ProcessProbe {
  const cache = new Map<number, number | null>();
  return {
    isAlive(pid) {
      const alive = probe.isAlive(pid);
      if (!alive) cache.delete(pid);
      return alive;
    },
    async startTimeMs(pid) {
      if (cache.has(pid)) return cache.get(pid) ?? null;
      const t = await probe.startTimeMs(pid);
      if (t !== null) cache.set(pid, t);
      return t;
    },
  };
}

/** cliSessionId → live state, from every running file that passes checkRunningFile. */
export async function liveStates(files: RunningFile[], probe: ProcessProbe): Promise<Map<string, LiveState>> {
  const out = new Map<string, LiveState>();
  for (const rf of files) {
    const c = await checkRunningFile(rf, probe);
    if (!c.live) continue;
    if (out.get(rf.sessionId) !== "busy") out.set(rf.sessionId, c.state);
  }
  return out;
}
```

`companiond/src/claude/processProbe.ts`:

```ts
import { execFile } from "node:child_process";
import type { ProcessProbe } from "./runningFiles.ts";

/**
 * Real probe. `process.kill(pid, 0)` sends no signal; it only checks the pid exists
 * (EPERM means it exists but belongs to someone else). Start time comes from `/bin/ps -o lstart=`.
 * This is the only file in the M3 folders that may import node:child_process; it never runs git.
 */
export const nodeProcessProbe: ProcessProbe = {
  isAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  startTimeMs(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1) return Promise.resolve(null);
    const env: NodeJS.ProcessEnv = { LC_ALL: "C" };
    if (process.env.TZ) env.TZ = process.env.TZ;
    return new Promise((resolve) => {
      execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env, timeout: 2000 }, (err, stdout) => {
        if (err) return resolve(null);
        const ms = Date.parse(String(stdout).trim().replace(/\s+/g, " "));
        resolve(Number.isFinite(ms) ? ms : null);
      });
    });
  },
};
```

- [ ] **Step 4: Run tests and type-check**

Run: `cd companiond && node --test test/claude/runningFiles.test.ts test/claude/readFs.test.ts && npm run typecheck`
Expected: 10 pass in `runningFiles.test.ts`, 11 in `readFs.test.ts` (the static scan now covers these files); `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/claude/runningFiles.ts companiond/src/claude/processProbe.ts companiond/test/claude/runningFiles.test.ts
git commit -m "feat(companiond): busy/idle from running files with pid and start-time checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Transcript location with the `sessionId` check

Spec §6.1: try the encoded-cwd folder, else search every project folder; accept a file only if records in it carry `sessionId == cliSessionId`. M1 Q7 confirmed the check holds (248/248). Ids from Claude's files are validated by `isSafeId` before they become part of a path. The head check reads 64 KB, and up to 1 MiB when the first line is longer; a last line with no newline counts only at end of file.

**Files:**
- Create: `companiond/src/claude/transcriptLocator.ts`
- Test: `companiond/test/claude/transcriptLocator.test.ts`

**Interfaces:**
- Consumes: `ReadFs`, `encodeCwd`, `isSafeId` (Task 4).
- Produces: `type TranscriptLocation = { kind: "found"; path: string; via: "encoded_cwd" | "search" } | { kind: "missing"; reason: "invalid_id" | "not_found" | "session_id_mismatch" }`; `locateTranscript(fs, projectsDir, cwd: string | null, cliSessionId: string | null): Promise<TranscriptLocation>`; `transcriptHasSessionId(fs, file, id): Promise<boolean>`; `HEAD_BYTES`, `HEAD_MAX_BYTES`, `HEAD_LINES`.

- [ ] **Step 1: Write the failing test** — `companiond/test/claude/transcriptLocator.test.ts`:

```ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { locateTranscript, transcriptHasSessionId } from "../../src/claude/transcriptLocator.ts";
import { nodeReadFs } from "../../src/claude/readFs.ts";
import { claudeTree, MARK, removeTempDirs, tempDir, transcriptPath, userLine, writeTranscript } from "../helpers/fixtures.ts";

after(removeTempDirs);

test("finds the transcript in the encoded-cwd folder", async () => {
  const p = claudeTree();
  const f = transcriptPath(p, "/syn/repo", "cli-a");
  writeTranscript(f, "cli-a", [userLine("cli-a", "/syn/repo", "hi")]);
  assert.deepEqual(await locateTranscript(nodeReadFs, p.projectsDir, "/syn/repo", "cli-a"), { kind: "found", path: f, via: "encoded_cwd" });
});

test("falls back to searching every project folder", async () => {
  const p = claudeTree();
  const f = transcriptPath(p, "/syn/elsewhere", "cli-a");
  writeTranscript(f, "cli-a", []);
  assert.deepEqual(await locateTranscript(nodeReadFs, p.projectsDir, "/syn/repo", "cli-a"), { kind: "found", path: f, via: "search" });
});

test("§12.2 folder-name collision is rejected by the sessionId check", async () => {
  const p = claudeTree();
  // "/syn/a-b" and "/syn/a.b" encode to the same folder; the file there belongs to another session.
  writeTranscript(transcriptPath(p, "/syn/a.b", "cli-a"), "cli-other", []);
  const right = transcriptPath(p, "/syn/x", "cli-a");
  writeTranscript(right, "cli-a", []);
  assert.deepEqual(await locateTranscript(nodeReadFs, p.projectsDir, "/syn/a-b", "cli-a"), { kind: "found", path: right, via: "search" });
});

test("a collision with no other match is reported, not accepted", async () => {
  const p = claudeTree();
  writeTranscript(transcriptPath(p, "/syn/a.b", "cli-a"), "cli-other", []);
  assert.deepEqual(await locateTranscript(nodeReadFs, p.projectsDir, "/syn/a-b", "cli-a"), { kind: "missing", reason: "session_id_mismatch" });
});

test("§12.2 record whose transcript is missing", async () => {
  const p = claudeTree();
  assert.deepEqual(await locateTranscript(nodeReadFs, p.projectsDir, "/syn/repo", "cli-none"), { kind: "missing", reason: "not_found" });
});

test("unsafe ids never reach the file system", async () => {
  const p = claudeTree();
  assert.deepEqual(await locateTranscript(nodeReadFs, p.projectsDir, "/syn", "../../etc/x"), { kind: "missing", reason: "invalid_id" });
  assert.deepEqual(await locateTranscript(nodeReadFs, p.projectsDir, "/syn", null), { kind: "missing", reason: "invalid_id" });
});

test("a first line longer than 64 KB and a last line without a newline are still checked", async () => {
  const dir = tempDir();
  const long = path.join(dir, "long.jsonl");
  fs.writeFileSync(long, JSON.stringify({ type: "user", sessionId: "cli-a", note: MARK, pad: "x".repeat(100_000) }) + "\n");
  assert.equal(await transcriptHasSessionId(nodeReadFs, long, "cli-a"), true);
  const open = path.join(dir, "open.jsonl");
  fs.writeFileSync(open, JSON.stringify({ type: "user", sessionId: "cli-a", note: MARK }));
  assert.equal(await transcriptHasSessionId(nodeReadFs, open, "cli-a"), true);
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/claude/transcriptLocator.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/claude/transcriptLocator.ts`.

- [ ] **Step 3: Implement** — `companiond/src/claude/transcriptLocator.ts`:

```ts
import path from "node:path";
import type { ReadFs } from "./readFs.ts";
import { encodeCwd, isSafeId } from "./paths.ts";

export type TranscriptLocation =
  | { kind: "found"; path: string; via: "encoded_cwd" | "search" }
  | { kind: "missing"; reason: "invalid_id" | "not_found" | "session_id_mismatch" };

/** How much of a transcript's head is read to check `sessionId`. */
export const HEAD_BYTES = 64 * 1024;
/** A first line longer than HEAD_BYTES is read up to this size. */
export const HEAD_MAX_BYTES = 1024 * 1024;
export const HEAD_LINES = 30;

/**
 * True if one of the first lines is a record whose `sessionId` equals `id`. Reads 64 KB; if that holds no
 * newline, reads up to 1 MiB. A last line without a newline counts only when the read reached end of file.
 */
export async function transcriptHasSessionId(fs: ReadFs, file: string, id: string): Promise<boolean> {
  let head: Buffer;
  try {
    head = (await fs.readRange(file, 0, HEAD_BYTES)).buf;
    if (head.length === HEAD_BYTES && head.indexOf(0x0a) === -1) head = (await fs.readRange(file, 0, HEAD_MAX_BYTES)).buf;
  } catch {
    return false;
  }
  const atEof = head.length < (head.length > HEAD_BYTES ? HEAD_MAX_BYTES : HEAD_BYTES);
  const end = atEof ? head.length : head.lastIndexOf(0x0a);
  if (end <= 0) return false;
  const lines = head.subarray(0, end).toString("utf8").split("\n").slice(0, HEAD_LINES);
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as { sessionId?: unknown };
      if (rec && rec.sessionId === id) return true;
    } catch {
      // malformed head line: keep looking
    }
  }
  return false;
}

async function isFile(fs: ReadFs, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Spec §6.1: try `<projectsDir>/<encoded cwd>/<id>.jsonl`, else any `<projectsDir>/<dir>/<id>.jsonl`.
 * A file is accepted only if records inside carry `sessionId == id` (the folder name is lossy).
 */
export async function locateTranscript(
  fs: ReadFs,
  projectsDir: string,
  cwd: string | null,
  cliSessionId: string | null,
): Promise<TranscriptLocation> {
  if (!isSafeId(cliSessionId)) return { kind: "missing", reason: "invalid_id" };
  const fileName = `${cliSessionId}.jsonl`;
  let sawMismatch = false;
  const tried = new Set<string>();
  if (cwd !== null) {
    const candidate = path.join(projectsDir, encodeCwd(cwd), fileName);
    tried.add(candidate);
    if (await isFile(fs, candidate)) {
      if (await transcriptHasSessionId(fs, candidate, cliSessionId)) return { kind: "found", path: candidate, via: "encoded_cwd" };
      sawMismatch = true;
    }
  }
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(projectsDir)).sort();
  } catch {
    return { kind: "missing", reason: "not_found" };
  }
  for (const d of dirs) {
    const candidate = path.join(projectsDir, d, fileName);
    if (tried.has(candidate) || !(await isFile(fs, candidate))) continue;
    if (await transcriptHasSessionId(fs, candidate, cliSessionId)) return { kind: "found", path: candidate, via: "search" };
    sawMismatch = true;
  }
  return { kind: "missing", reason: sawMismatch ? "session_id_mismatch" : "not_found" };
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `cd companiond && node --test test/claude/transcriptLocator.test.ts && npm run typecheck`
Expected: 7 pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/claude/transcriptLocator.ts companiond/test/claude/transcriptLocator.test.ts
git commit -m "feat(companiond): locate transcripts and reject folder-name collisions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Terminal failure detection

Spec §10 and §14 M3: recognise test and build failures in Bash results. Only a failed command is examined (non-zero exit or an error result), so a passing script that prints `# fail 1` is not a failure. Patterns are matched on the untrimmed output; test patterns win over build patterns; a failed command with no known pattern is `command_failed`. Bare `error: ` lines (git and many tools print them) are not build failures.

**Files:**
- Create: `companiond/src/transcript/terminal.ts`
- Test: `companiond/test/transcript/terminal.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface TerminalFailure { kind: "test_failure" | "build_failure" | "command_failed"; summary: string }` (summary ≤ 200 chars, the matching line); `interface CommandOutcome { exitCode: number | null; isError: boolean; stdout: string; stderr: string }`; `detectFailure(o: CommandOutcome): TerminalFailure | null`.

- [ ] **Step 1: Write the failing test** — `companiond/test/transcript/terminal.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFailure } from "../../src/transcript/terminal.ts";

const run = (stdout: string, exitCode: number | null = 1, stderr = "") => detectFailure({ exitCode, isError: exitCode !== 0, stdout, stderr });

test("recognises test runners", () => {
  for (const [out, line] of [
    ["# tests 3\n# fail 1\n", "# fail 1"],
    ["ℹ tests 3\nℹ fail 2\n", "ℹ fail 2"],
    ["Tests:       1 failed, 4 passed, 5 total", "Tests:       1 failed, 4 passed, 5 total"],
    ["==== 2 failed, 10 passed in 0.31s ====", "==== 2 failed, 10 passed in 0.31s ===="],
    ["--- FAIL: TestSynthetic (0.00s)", "--- FAIL: TestSynthetic (0.00s)"],
    ["test result: FAILED. 1 passed; 1 failed", "test result: FAILED. 1 passed; 1 failed"],
  ] as const) {
    assert.deepEqual(run(out), { kind: "test_failure", summary: line }, out);
  }
});

test("recognises build errors, in stdout or stderr", () => {
  assert.deepEqual(run("src/a.ts(3,1): error TS2304: Cannot find name 'x'."), {
    kind: "build_failure",
    summary: "src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
  });
  assert.equal(run("", 1, "Sources/A.swift:4:2: error: cannot find 'y' in scope")?.kind, "build_failure");
  assert.equal(run("", 101, "error[E0425]: cannot find value `x`")?.kind, "build_failure");
});

test("a bare 'error: ' line is only command_failed, not a build failure", () => {
  assert.deepEqual(run("error: pathspec 'x' did not match", 1), { kind: "command_failed", summary: "exit code 1" });
});

test("output of a successful command is never a failure, whatever it prints", () => {
  assert.equal(run("# tests 3\n# fail 0\n", 0), null);
  assert.equal(run("# fail 1\nerror TS2304: x", 0), null);
  assert.equal(detectFailure({ exitCode: null, isError: false, stdout: "# fail 1", stderr: "" }), null);
});

test("a plain non-zero exit is command_failed", () => {
  assert.deepEqual(run("nothing useful", 2), { kind: "command_failed", summary: "exit code 2" });
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/transcript/terminal.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/transcript/terminal.ts`.

- [ ] **Step 3: Implement** — `companiond/src/transcript/terminal.ts`:

```ts
export interface TerminalFailure {
  kind: "test_failure" | "build_failure" | "command_failed";
  /** One line, at most 200 characters. */
  summary: string;
}

export interface CommandOutcome {
  exitCode: number | null;
  isError: boolean;
  stdout: string;
  stderr: string;
}

const TEST_PATTERNS: RegExp[] = [
  /^# fail [1-9]\d*/m, // node:test TAP
  /^ℹ fail [1-9]\d*/m, // node:test spec reporter
  /^Tests?:\s+.*\b[1-9]\d* failed/m, // jest, vitest
  /^=+ .*\b[1-9]\d* failed\b.*=+$/m, // pytest summary line
  /^FAILED \S+/m, // pytest
  /^--- FAIL: /m, // go test
  /^test result: FAILED/m, // cargo test
  /^✘ Test .* failed/m, // swift-testing
  /Executed \d+ tests?, with [1-9]\d* failures?/, // XCTest
];

const BUILD_PATTERNS: RegExp[] = [
  /error TS\d{4,5}:/, // tsc
  /^\S+:\d+:\d+: (fatal )?error: /m, // swiftc, clang, gcc
  /^error\[E\d{4}\]: /m, // rustc
  /^error: could not compile /m, // cargo
  /^error: (emit-module command failed|build had \d+ command failures?|fatalError)/m, // swift build
  /^npm (ERR!|error) /m,
  /\bBUILD FAILED\b/,
  /^SyntaxError: /m,
];

function firstLine(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m) return "";
  const start = text.lastIndexOf("\n", m.index) + 1;
  const end = text.indexOf("\n", m.index);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 200);
}

/**
 * Recognises test and build failures in a Bash result (spec §10). Only a failed command is examined
 * (non-zero exit or an error result), so "# fail 1" printed by a passing script is not a failure.
 */
export function detectFailure(o: CommandOutcome): TerminalFailure | null {
  const failed = o.isError || (o.exitCode !== null && o.exitCode !== 0);
  if (!failed) return null;
  const text = `${o.stdout}\n${o.stderr}`;
  for (const re of TEST_PATTERNS) if (re.test(text)) return { kind: "test_failure", summary: firstLine(text, re) };
  for (const re of BUILD_PATTERNS) if (re.test(text)) return { kind: "build_failure", summary: firstLine(text, re) };
  return { kind: "command_failed", summary: o.exitCode !== null ? `exit code ${o.exitCode}` : "command failed" };
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `cd companiond && node --test test/transcript/terminal.test.ts && npm run typecheck`
Expected: 5 pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/transcript/terminal.ts companiond/test/transcript/terminal.test.ts
git commit -m "feat(companiond): recognise test and build failures in Bash output" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Transcript parser

JSONL record → typed events (spec §3): user text, assistant text, tool call, tool result (trimmed stdout/stderr, exit code, failure), file edit, subagent summary. Unknown record types parse with no events and `known: false` so the reader can count them (spec §16). Each parsed line also reports `cwd`, `gitBranch`, `isSidechain` and `timestamp`, so the reader can ignore sidechain records for the worktree candidate. Record shapes follow the findings (§4) and Claude Code's message format; Task 1 confirms the Bash result keys and record types (add any silent type it finds to `KNOWN_SILENT`).

**Files:**
- Create: `companiond/src/transcript/parser.ts`
- Test: `companiond/test/transcript/parser.test.ts`

**Interfaces:**
- Consumes: `detectFailure`, `TerminalFailure` (Task 8).
- Produces: `interface EventBase { uuid: string | null; timestamp: string | null; isSidechain: boolean }`; `type TranscriptEvent` (see "Interfaces produced for M4/M5"); `type ParsedLine = { ok: true; type: string; known: boolean; uuid: string | null; cwd: string | null; gitBranch: string | null; isSidechain: boolean; timestamp: string | null; events: TranscriptEvent[] } | { ok: false }`; `class TranscriptParser { parseLine(line: string): ParsedLine }` (stateful: tool_use id → name/command, bounded to 5,000); `trimText(s, max)` (¼ head, ¾ tail, never splits a surrogate pair); `TEXT_MAX = 20000`, `TOOL_OUTPUT_MAX = 4000`, `INPUT_PREVIEW_MAX = 500`.

- [ ] **Step 1: Write the failing test** — `companiond/test/transcript/parser.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TranscriptParser, trimText, TOOL_OUTPUT_MAX } from "../../src/transcript/parser.ts";
import { assistantLine, MARK, markerLine, userLine } from "../helpers/fixtures.ts";

const S = "cli-a";
const CWD = "/syn/repo";

function bashPair(p: TranscriptParser, id: string, command: string, result: Record<string, unknown>, isError = false, text = "") {
  p.parseLine(assistantLine(S, CWD, [{ type: "tool_use", id, name: "Bash", input: { command } }]));
  const line = userLine(S, CWD, "", {
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] },
    toolUseResult: result,
  });
  const parsed = p.parseLine(line);
  assert.ok(parsed.ok);
  return parsed.events[0];
}

test("user and assistant text", () => {
  const p = new TranscriptParser();
  const u = p.parseLine(userLine(S, CWD, `${MARK} question`));
  assert.ok(u.ok);
  assert.equal(u.cwd, CWD);
  assert.equal(u.gitBranch, "syn-branch");
  assert.deepEqual(u.events.map((e) => e.kind), ["user_text"]);
  const a = p.parseLine(assistantLine(S, CWD, [{ type: "thinking", thinking: "x" }, { type: "text", text: `${MARK} answer` }]));
  assert.ok(a.ok);
  assert.deepEqual(a.events.map((e) => [e.kind, "text" in e ? e.text : ""]), [["assistant_text", `${MARK} answer`]]);
});

test("meta user records give no text", () => {
  const p = new TranscriptParser();
  const r = p.parseLine(userLine(S, CWD, `${MARK} caveat`, { isMeta: true }));
  assert.ok(r.ok);
  assert.deepEqual(r.events, []);
});

test("Bash tool call and result carry command, output, exit code and failure", () => {
  const p = new TranscriptParser();
  const e = bashPair(p, "tu-1", "npm test", { stdout: "# fail 1\n", stderr: "", interrupted: false }, true, "Exit code 1\n# fail 1");
  assert.equal(e.kind, "tool_result");
  if (e.kind !== "tool_result") return;
  assert.equal(e.command, "npm test");
  assert.equal(e.exitCode, 1);
  assert.equal(e.failure?.kind, "test_failure");
});

test("a successful Bash result has exit code 0 and no failure", () => {
  const p = new TranscriptParser();
  const e = bashPair(p, "tu-2", "ls", { stdout: "a\n", stderr: "", interrupted: false });
  assert.ok(e.kind === "tool_result" && e.exitCode === 0 && e.failure === null);
});

test("long tool output is trimmed, keeping the tail", () => {
  const p = new TranscriptParser();
  const big = "x".repeat(10_000) + "END";
  const e = bashPair(p, "tu-3", "cat", { stdout: big, stderr: "" });
  assert.ok(e.kind === "tool_result");
  if (e.kind !== "tool_result") return;
  assert.ok(e.stdout.length < TOOL_OUTPUT_MAX + 100);
  assert.ok(e.stdout.endsWith("END"));
});

test("edit tools also produce a file_edit event", () => {
  const p = new TranscriptParser();
  const r = p.parseLine(assistantLine(S, CWD, [{ type: "tool_use", id: "tu-4", name: "Edit", input: { file_path: "/syn/repo/a.ts", old_string: "a", new_string: "b" } }]));
  assert.ok(r.ok);
  assert.deepEqual(r.events.map((e) => e.kind), ["tool_call", "file_edit"]);
  assert.equal(r.events[1].kind === "file_edit" && r.events[1].filePath, "/syn/repo/a.ts");
});

test("a subagent tool result becomes a subagent_summary", () => {
  const p = new TranscriptParser();
  p.parseLine(assistantLine(S, CWD, [{ type: "tool_use", id: "tu-5", name: "Task", input: { prompt: MARK } }]));
  const r = p.parseLine(
    userLine(S, CWD, "", {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-5", content: [{ type: "text", text: `${MARK} done` }] }] },
      toolUseResult: { status: "completed", content: [{ type: "text", text: `${MARK} summary` }] },
    }),
  );
  assert.ok(r.ok);
  assert.deepEqual(r.events.map((e) => [e.kind, "text" in e ? e.text : ""]), [["subagent_summary", `${MARK} summary`]]);
});

test("unknown record types parse with no events and known=false; known silent types are known", () => {
  const p = new TranscriptParser();
  const u = p.parseLine(JSON.stringify({ type: "future-thing", uuid: "z", note: MARK }));
  assert.ok(u.ok && !u.known && u.events.length === 0);
  const k = p.parseLine(markerLine(S));
  assert.ok(k.ok && k.known);
});

test("malformed lines are reported, not thrown", () => {
  const p = new TranscriptParser();
  for (const bad of ["{", "[]", "42", '"x"']) assert.deepEqual(p.parseLine(bad), { ok: false });
});

test("trimText keeps short text as is", () => {
  assert.equal(trimText("abc", 10), "abc");
});

test("trimText never splits a surrogate pair", () => {
  const s = "😀".repeat(50);
  const t = trimText(s, 21);
  assert.equal(t.isWellFormed(), true);
  assert.ok(t.startsWith("😀") && t.endsWith("😀"));
});

test("sidechain records are flagged", () => {
  const p = new TranscriptParser();
  const r = p.parseLine(userLine(S, "/syn/other", "sub", { isSidechain: true }));
  assert.ok(r.ok && r.isSidechain);
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/transcript/parser.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/transcript/parser.ts`.

- [ ] **Step 3: Implement** — `companiond/src/transcript/parser.ts`:

```ts
import type { TerminalFailure } from "./terminal.ts";
import { detectFailure } from "./terminal.ts";

export interface EventBase {
  /** Record `uuid`; the cursor key (spec §6.4). Null for records without one. */
  uuid: string | null;
  timestamp: string | null;
  isSidechain: boolean;
}

export type TranscriptEvent =
  | (EventBase & { kind: "user_text"; text: string })
  | (EventBase & { kind: "assistant_text"; text: string })
  | (EventBase & { kind: "tool_call"; toolUseId: string; name: string; inputPreview: string; command: string | null })
  | (EventBase & {
      kind: "tool_result";
      toolUseId: string;
      toolName: string | null;
      command: string | null;
      isError: boolean;
      /** Trimmed (TOOL_OUTPUT_MAX). Empty for non-Bash tools. */
      stdout: string;
      stderr: string;
      exitCode: number | null;
      interrupted: boolean;
      /** Trimmed text content of the tool result block. */
      text: string;
      failure: TerminalFailure | null;
    })
  | (EventBase & { kind: "file_edit"; toolUseId: string; tool: string; filePath: string })
  | (EventBase & { kind: "subagent_summary"; toolUseId: string; text: string })
  | (EventBase & { kind: "cwd_change"; from: string; to: string });

export type ParsedLine =
  | {
      ok: true;
      type: string;
      known: boolean;
      uuid: string | null;
      cwd: string | null;
      gitBranch: string | null;
      /** Sidechain (subagent) records never move the worktree candidate (spec §6.3). */
      isSidechain: boolean;
      timestamp: string | null;
      events: TranscriptEvent[];
    }
  | { ok: false };

export const TEXT_MAX = 20_000;
export const TOOL_OUTPUT_MAX = 4_000;
export const INPUT_PREVIEW_MAX = 500;

/** Record types seen on disk (findings §4) that carry nothing for the context. Task 1 may add more. */
const KNOWN_SILENT = new Set([
  "attachment",
  "custom-title",
  "agent-name",
  "last-prompt",
  "file-history-snapshot",
  "queue-operation",
  "summary",
  "system",
]);

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Keeps the head (¼) and tail (¾) of long text, with a marker between. Never splits a surrogate pair. */
export function trimText(s: string, max: number): string {
  if (s.length <= max) return s;
  let head = Math.floor(max / 4);
  let tailStart = s.length - (max - head);
  if (head > 0 && isHigh(s.charCodeAt(head - 1))) head--;
  if (tailStart < s.length && isLow(s.charCodeAt(tailStart))) tailStart++;
  return `${s.slice(0, head)}\n… [${tailStart - head} characters trimmed] …\n${s.slice(tailStart)}`;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter((t) => t !== "")
    .join("\n");
}

/**
 * Stateful: remembers tool_use ids → name/command so results can be labelled.
 * One parser per transcript file; make a new one when the file is re-read from 0.
 */
export class TranscriptParser {
  #tools = new Map<string, { name: string; command: string | null }>();
  static readonly MAX_TOOLS = 5_000;

  parseLine(line: string): ParsedLine {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return { ok: false };
    }
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) return { ok: false };
    const r = rec as Record<string, unknown>;
    const type = str(r.type) ?? "";
    const base: EventBase = { uuid: str(r.uuid), timestamp: str(r.timestamp), isSidechain: r.isSidechain === true };
    const head = {
      ok: true as const,
      type,
      uuid: base.uuid,
      cwd: str(r.cwd),
      gitBranch: str(r.gitBranch),
      isSidechain: base.isSidechain,
      timestamp: base.timestamp,
    };
    if (type === "user") return { ...head, known: true, events: this.#user(r, base) };
    if (type === "assistant") return { ...head, known: true, events: this.#assistant(r, base) };
    return { ...head, known: KNOWN_SILENT.has(type) || type.startsWith("api-request"), events: [] };
  }

  #remember(id: string, name: string, command: string | null): void {
    if (this.#tools.size >= TranscriptParser.MAX_TOOLS) {
      const oldest = this.#tools.keys().next().value;
      if (oldest !== undefined) this.#tools.delete(oldest);
    }
    this.#tools.set(id, { name, command });
  }

  #assistant(r: Record<string, unknown>, base: EventBase): TranscriptEvent[] {
    const content = (r.message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") return content.trim() ? [{ ...base, kind: "assistant_text", text: trimText(content, TEXT_MAX) }] : [];
    if (!Array.isArray(content)) return [];
    const out: TranscriptEvent[] = [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({ ...base, kind: "assistant_text", text: trimText(b.text, TEXT_MAX) });
      } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
        const command = b.name === "Bash" ? str(input.command) : null;
        this.#remember(b.id, b.name, command);
        out.push({ ...base, kind: "tool_call", toolUseId: b.id, name: b.name, inputPreview: trimText(JSON.stringify(input), INPUT_PREVIEW_MAX), command });
        const filePath = str(input.file_path) ?? str(input.notebook_path);
        if (EDIT_TOOLS.has(b.name) && filePath) out.push({ ...base, kind: "file_edit", toolUseId: b.id, tool: b.name, filePath });
      }
      // "thinking" and unknown blocks are ignored on purpose.
    }
    return out;
  }

  #user(r: Record<string, unknown>, base: EventBase): TranscriptEvent[] {
    const content = (r.message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") {
      return content.trim() && r.isMeta !== true ? [{ ...base, kind: "user_text", text: trimText(content, TEXT_MAX) }] : [];
    }
    if (!Array.isArray(content)) return [];
    const out: TranscriptEvent[] = [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim() && r.isMeta !== true) {
        out.push({ ...base, kind: "user_text", text: trimText(b.text, TEXT_MAX) });
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        out.push(this.#toolResult(b, r.toolUseResult, base));
      }
    }
    return out;
  }

  #toolResult(b: Record<string, unknown>, tur: unknown, base: EventBase): TranscriptEvent {
    const id = b.tool_use_id as string;
    const tool = this.#tools.get(id) ?? null;
    const text = blockText(b.content);
    const isError = b.is_error === true;
    if (tool && SUBAGENT_TOOLS.has(tool.name)) {
      const t = tur && typeof tur === "object" ? blockText((tur as { content?: unknown }).content) : "";
      return { ...base, kind: "subagent_summary", toolUseId: id, text: trimText(t || text, TOOL_OUTPUT_MAX) };
    }
    const res = (tur && typeof tur === "object" ? tur : {}) as Record<string, unknown>;
    const isBash = tool?.name === "Bash";
    const stdout = isBash ? (str(res.stdout) ?? "") : "";
    const stderr = isBash ? (str(res.stderr) ?? "") : "";
    let exitCode: number | null = typeof res.exitCode === "number" ? res.exitCode : null;
    if (exitCode === null && isBash) {
      const m = /^Exit code (\d+)/.exec(text);
      exitCode = m ? Number(m[1]) : isError ? null : 0;
    }
    const interrupted = res.interrupted === true;
    const failure = isBash ? detectFailure({ exitCode, isError, stdout, stderr: stderr || (isError ? text : "") }) : null;
    return {
      ...base,
      kind: "tool_result",
      toolUseId: id,
      toolName: tool?.name ?? null,
      command: tool?.command ?? null,
      isError,
      stdout: trimText(stdout, TOOL_OUTPUT_MAX),
      stderr: trimText(stderr, TOOL_OUTPUT_MAX),
      exitCode,
      interrupted,
      text: trimText(text, TOOL_OUTPUT_MAX),
      failure,
    };
  }
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `cd companiond && node --test test/transcript/parser.test.ts && npm run typecheck`
Expected: 12 pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/transcript/parser.ts companiond/test/transcript/parser.test.ts
git commit -m "feat(companiond): parse transcript records into typed events" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Transcript tail

Spec §6.4: per-file byte offset; bytes after the last `\n` are buffered, never parsed. Re-read from 0 when the size drops below the offset (`truncated`), when `dev:ino` changes at stat time or at read time (from the open handle) (`replaced`), and when the file comes back after being missing (`replaced`). Missing resets offset, identity and the partial line; a read that fails (file deleted between stat and open) counts as missing, so it never aborts a pass. Polling only; each poll reads at most `maxReadBytes` (default 8 MiB) in 256 KB slices and reports `more`. Known limit, documented in the code and the PR: an in-place rewrite to the same or a larger size is not detected.

**Files:**
- Create: `companiond/src/transcript/tail.ts`
- Test: `companiond/test/transcript/tail.test.ts`

**Interfaces:**
- Consumes: `ReadFs`, `RangeRead` (Task 4), `LineBuffer` (Task 2).
- Produces: `type ResetReason = "truncated" | "replaced"`; `type TailRead = { kind: "missing" } | { kind: "data"; reset: ResetReason | null; lines: string[]; more: boolean }`; `interface TailOptions { maxLineBytes?: number; maxReadBytes?: number }`; `class TranscriptTail { constructor(path: string, fs: ReadFs, opts?: TailOptions); readonly path: string; get offset(): number; get stats(): { invalidUtf8Lines: number; oversizedLines: number }; poll(): Promise<TailRead> }`.

- [ ] **Step 1: Write the failing test** — `companiond/test/transcript/tail.test.ts`:

```ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TranscriptTail } from "../../src/transcript/tail.ts";
import type { ReadFs } from "../../src/claude/readFs.ts";
import { nodeReadFs } from "../../src/claude/readFs.ts";
import { MARK, removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);

function file(content: string | Buffer): string {
  const f = path.join(tempDir(), "t.jsonl");
  fs.writeFileSync(f, content);
  return f;
}

test("missing file reports missing", async () => {
  const t = new TranscriptTail(path.join(tempDir(), "none.jsonl"), nodeReadFs);
  assert.deepEqual(await t.poll(), { kind: "missing" });
});

test("§12.2 partial line split across writes is held until its newline", async () => {
  const f = file(`{"m":"${MARK}"}\n{"half":`);
  const t = new TranscriptTail(f, nodeReadFs);
  assert.deepEqual(await t.poll(), { kind: "data", reset: null, lines: [`{"m":"${MARK}"}`], more: false });
  fs.appendFileSync(f, "1}");
  assert.deepEqual(await t.poll(), { kind: "data", reset: null, lines: [], more: false });
  fs.appendFileSync(f, "\n");
  const r = await t.poll();
  assert.ok(r.kind === "data");
  assert.deepEqual(r.lines, ['{"half":1}']);
});

test("§12.2 truncation re-reads from 0", async () => {
  const f = file(`{"m":"${MARK}"}\n{"a":1}\n{"b":2}\n`);
  const t = new TranscriptTail(f, nodeReadFs);
  await t.poll();
  fs.truncateSync(f, 0);
  fs.appendFileSync(f, '{"c":3}\n');
  const r = await t.poll();
  assert.deepEqual(r, { kind: "data", reset: "truncated", lines: ['{"c":3}'], more: false });
});

test("§12.2 replacement (new inode) re-reads from 0 even when larger", async () => {
  const dir = tempDir();
  const f = path.join(dir, "t.jsonl");
  fs.writeFileSync(f, `{"m":"${MARK}"}\n`);
  const t = new TranscriptTail(f, nodeReadFs);
  await t.poll();
  const tmp = path.join(dir, "t.jsonl.new");
  fs.writeFileSync(tmp, `{"m":"${MARK}"}\n{"x":1}\n{"y":2}\n`);
  fs.renameSync(tmp, f);
  const r = await t.poll();
  assert.ok(r.kind === "data");
  assert.equal(r.reset, "replaced");
  assert.equal(r.lines.length, 3);
});

test("a file that goes missing and comes back is re-read from 0 as replaced, with no stale partial line", async () => {
  const f = file(`{"m":"${MARK}"}\n{"partial":`);
  const t = new TranscriptTail(f, nodeReadFs);
  await t.poll();
  fs.rmSync(f);
  assert.deepEqual(await t.poll(), { kind: "missing" });
  assert.equal(t.offset, 0);
  fs.writeFileSync(f, `{"m":"${MARK}"}\n{"new":1}\n`);
  assert.deepEqual(await t.poll(), { kind: "data", reset: "replaced", lines: [`{"m":"${MARK}"}`, '{"new":1}'], more: false });
});

test("a file swapped between stat and read is detected from the read handle", async () => {
  const f = file(`{"m":"${MARK}"}\n`);
  let swap = false;
  const fsSwap: ReadFs = {
    ...nodeReadFs,
    readRange: async (p, pos, len) => {
      const r = await nodeReadFs.readRange(p, pos, len);
      return swap ? { ...r, ino: r.ino + 1 } : r;
    },
  };
  const t = new TranscriptTail(f, fsSwap);
  await t.poll();
  fs.appendFileSync(f, '{"more":1}\n');
  swap = true;
  assert.deepEqual(await t.poll(), { kind: "data", reset: "replaced", lines: [], more: true });
  swap = false;
  const r = await t.poll();
  assert.ok(r.kind === "data" && r.lines.length === 2);
});

test("a file deleted between stat and read is reported as missing, then re-read as replaced", async () => {
  const f = file(`{"m":"${MARK}"}\n`);
  let gone = false;
  const racy: ReadFs = {
    ...nodeReadFs,
    readRange: async (p, pos, len) => {
      if (gone) throw Object.assign(new Error("synthetic"), { code: "ENOENT" });
      return nodeReadFs.readRange(p, pos, len);
    },
  };
  const t = new TranscriptTail(f, racy);
  await t.poll();
  fs.appendFileSync(f, '{"more":1}\n');
  gone = true;
  assert.deepEqual(await t.poll(), { kind: "missing" });
  assert.equal(t.offset, 0);
  gone = false;
  const r = await t.poll();
  assert.ok(r.kind === "data" && r.reset === "replaced" && r.lines.length === 2);
});

test("reads in bounded slices and says when more is waiting", async () => {
  const f = file(`{"m":"${MARK}"}\n` + '{"n":1}\n'.repeat(100));
  const t = new TranscriptTail(f, nodeReadFs, { maxReadBytes: 64 });
  const first = await t.poll();
  assert.ok(first.kind === "data" && first.more);
  let total = first.lines.length;
  for (;;) {
    const r = await t.poll();
    assert.ok(r.kind === "data");
    total += r.lines.length;
    if (!r.more) break;
  }
  assert.equal(total, 101);
});

test("invalid UTF-8 and oversized lines are counted in stats", async () => {
  const f = file(Buffer.concat([Buffer.from(`{"m":"${MARK}"}\n`), Buffer.from([0xff, 0x0a]), Buffer.from("y".repeat(50) + "\n")]));
  const t = new TranscriptTail(f, nodeReadFs, { maxLineBytes: 40 });
  const r = await t.poll();
  assert.ok(r.kind === "data");
  assert.equal(r.lines.length, 1);
  assert.deepEqual(t.stats, { invalidUtf8Lines: 1, oversizedLines: 1 });
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/transcript/tail.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/transcript/tail.ts`.

- [ ] **Step 3: Implement** — `companiond/src/transcript/tail.ts`:

```ts
import type { ReadFs } from "../claude/readFs.ts";
import { LineBuffer } from "../lineBuffer.ts";

export type ResetReason = "truncated" | "replaced";

export type TailRead =
  | { kind: "missing" }
  | {
      kind: "data";
      /** Set when the file shrank, was replaced, or came back after missing: `lines` start from the top. */
      reset: ResetReason | null;
      lines: string[];
      /** True when more bytes are waiting than one poll reads (maxReadBytes). Poll again. */
      more: boolean;
    };

export interface TailOptions {
  maxLineBytes?: number;
  /** Bytes read per poll at most. */
  maxReadBytes?: number;
}

const CHUNK = 256 * 1024;

/**
 * Per-file byte offset + partial-line buffer (spec §6.4). Polling only: callers decide when to poll
 * (fs.watch hint, 2 s timer, manual refresh). Bytes after the last "\n" are buffered, never returned.
 *
 * Detects: size < offset (truncated), a new dev:ino at stat or at read time (replaced), and the file
 * coming back after being missing (replaced). Known limit: an in-place rewrite (same inode) to the same
 * or a larger size is not detected; the reader then sees only the bytes past its old offset.
 */
export class TranscriptTail {
  readonly path: string;
  readonly #fs: ReadFs;
  readonly #opts: TailOptions;
  #offset = 0;
  #identity: string | null = null;
  #wasMissing = false;
  #lines: LineBuffer;

  constructor(path: string, fs: ReadFs, opts: TailOptions = {}) {
    this.path = path;
    this.#fs = fs;
    this.#opts = opts;
    this.#lines = new LineBuffer({ maxLineBytes: opts.maxLineBytes });
  }

  get offset(): number {
    return this.#offset;
  }

  /** Counts since the last reset (a reset re-reads the file, so counts start again). */
  get stats(): { invalidUtf8Lines: number; oversizedLines: number } {
    return { invalidUtf8Lines: this.#lines.invalidUtf8Lines, oversizedLines: this.#lines.oversizedLines };
  }

  #restart(): void {
    this.#offset = 0;
    this.#identity = null;
    this.#lines = new LineBuffer({ maxLineBytes: this.#opts.maxLineBytes });
  }

  async poll(): Promise<TailRead> {
    let st;
    try {
      st = await this.#fs.stat(this.path);
    } catch {
      st = null;
    }
    if (st === null || !st.isFile()) {
      if (this.#identity !== null || this.#offset > 0) this.#wasMissing = true;
      this.#restart();
      return { kind: "missing" };
    }
    const identity = `${st.dev}:${st.ino}`;
    let reset: ResetReason | null = null;
    if (this.#wasMissing || (this.#identity !== null && identity !== this.#identity)) reset = "replaced";
    else if (st.size < this.#offset) reset = "truncated";
    this.#wasMissing = false;
    if (reset) this.#restart();
    this.#identity = identity;
    const budget = this.#opts.maxReadBytes ?? 8 * 1024 * 1024;
    const lines: string[] = [];
    let read = 0;
    while (this.#offset < st.size && read < budget) {
      const want = Math.min(CHUNK, st.size - this.#offset, budget - read);
      let r;
      try {
        r = await this.#fs.readRange(this.path, this.#offset, want);
      } catch {
        // Deleted or unreadable between stat and read: the same as missing.
        this.#restart();
        this.#wasMissing = true;
        return { kind: "missing" };
      }
      if (`${r.dev}:${r.ino}` !== identity) {
        // Replaced between stat and read: drop what we have and start over on the next poll.
        this.#restart();
        return { kind: "data", reset: "replaced", lines: [], more: true };
      }
      if (r.buf.length === 0) break;
      this.#offset += r.buf.length;
      read += r.buf.length;
      for (const l of this.#lines.push(r.buf)) lines.push(l);
    }
    return { kind: "data", reset, lines, more: this.#offset < st.size };
  }
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `cd companiond && node --test test/transcript/tail.test.ts && npm run typecheck`
Expected: 9 pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/transcript/tail.ts companiond/test/transcript/tail.test.ts
git commit -m "feat(companiond): tail transcripts with truncation and replacement detection" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Transcript reader and subagent tails

The reader owns a **rolling window** of events for one file: the newest 2,000 events or ~8 MiB of text, whichever is smaller. The uuid index keeps every record read since the last reset, so M4's cursor lookups work for events that left the window. First poll → `reset` with cause `initial`; later → `append`; truncation, replacement, or coming back after missing → `reset` with the rebuilt window (M4 restores its cursor by `uuid` with `hasUuid`; an unknown uuid means "cursor reset", spec §6.4). A reset seen in any slice of a multi-slice poll is reported. Slices are ingested as they arrive, yielding to the event loop between slices. `cwd` changes between **main-chain** records become `cwd_change` events; sidechain records never move the candidate. Subagent files (`<cliSessionId>/subagents/*.jsonl`) use the same reader; only the latest assistant text leaves as a summary (spec §6.4).

**Files:**
- Create: `companiond/src/transcript/reader.ts`
- Create: `companiond/src/transcript/subagents.ts`
- Test: `companiond/test/transcript/reader.test.ts`

**Interfaces:**
- Consumes: `TranscriptTail`, `TailOptions`, `ResetReason` (Task 10); `TranscriptParser`, `TranscriptEvent`, `trimText` (Task 9); `ReadFs` (Task 4).
- Produces: `interface SyncStats { records; malformedLines; invalidUtf8Lines; oversizedLines; unknownRecords; droppedEvents }` (numbers); `type ResetCause = "initial" | "truncated" | "replaced" | "session_id_changed"`; `type TranscriptBatch`; `interface ReaderOptions extends TailOptions { maxEvents?: number; maxEventBytes?: number }`; `MAX_WINDOW_EVENTS = 2000`, `MAX_WINDOW_BYTES = 8 MiB`; `class TranscriptReader { constructor(path, fs, opts?: ReaderOptions); readonly path; get events(): readonly TranscriptEvent[]; hasUuid(uuid: string): boolean; get latestCwd(): string | null; get latestGitBranch(): string | null; get stats(): SyncStats; poll(): Promise<TranscriptBatch | null> }`; `interface SubagentUpdate { agentId: string; summary: string; records: number }`; `subagentDir(transcriptPath): string`; `class SubagentTails { constructor(transcriptPath, fs); readonly dir; poll(): Promise<SubagentUpdate[]> }`; `SUBAGENT_SUMMARY_MAX = 2000`.

- [ ] **Step 1: Write the failing test** — `companiond/test/transcript/reader.test.ts`:

```ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TranscriptReader } from "../../src/transcript/reader.ts";
import { SubagentTails, subagentDir } from "../../src/transcript/subagents.ts";
import { nodeReadFs } from "../../src/claude/readFs.ts";
import { appendLines, assistantLine, MARK, removeTempDirs, tempDir, userLine, writeTranscript } from "../helpers/fixtures.ts";

after(removeTempDirs);

const S = "cli-a";

function setup(lines: string[]) {
  const f = path.join(tempDir(), "proj", `${S}.jsonl`);
  writeTranscript(f, S, lines);
  return f;
}

const texts = (events: readonly { kind: string }[]) => events.map((e) => ("text" in e ? (e as { text: string }).text : e.kind));

test("first poll is a reset 'initial' with every event, then appends", async () => {
  const f = setup([userLine(S, "/syn/a", "one")]);
  const r = new TranscriptReader(f, nodeReadFs);
  const first = await r.poll();
  assert.ok(first?.kind === "reset" && first.cause === "initial" && first.dropped === 0);
  assert.equal(first.events.length, 1);
  assert.equal(await r.poll(), null);
  appendLines(f, [assistantLine(S, "/syn/a", [{ type: "text", text: "two" }])]);
  const next = await r.poll();
  assert.ok(next?.kind === "append");
  assert.deepEqual(next.events.map((e) => e.kind), ["assistant_text"]);
});

test("§12.2 malformed lines are skipped and counted; unknown types counted", async () => {
  const f = setup(["{broken", userLine(S, "/syn/a", "ok"), JSON.stringify({ type: "future-type", note: MARK })]);
  const r = new TranscriptReader(f, nodeReadFs);
  await r.poll();
  assert.deepEqual(r.stats, { records: 3, malformedLines: 1, unknownRecords: 1, droppedEvents: 0, invalidUtf8Lines: 0, oversizedLines: 0 });
});

test("cwd changes become cwd_change events; sidechain records never move the candidate", async () => {
  const f = setup([
    userLine(S, "/syn/a", "one"),
    userLine(S, "/syn/sub", "subagent", { isSidechain: true }),
    userLine(S, "/syn/b", "two"),
  ]);
  const r = new TranscriptReader(f, nodeReadFs);
  const b = await r.poll();
  assert.ok(b?.kind === "reset");
  assert.deepEqual(b.events.map((e) => e.kind), ["user_text", "user_text", "cwd_change", "user_text"]);
  const change = b.events[2];
  assert.ok(change.kind === "cwd_change" && change.from === "/syn/a" && change.to === "/syn/b");
  assert.equal(r.latestCwd, "/syn/b");
});

test("§12.2 truncation rebuilds the event list; uuids answer cursor lookups", async () => {
  const keep = userLine(S, "/syn/a", "keep");
  const drop = userLine(S, "/syn/a", "drop");
  const f = setup([keep, drop]);
  const r = new TranscriptReader(f, nodeReadFs);
  await r.poll();
  fs.writeFileSync(f, "");
  writeTranscript(f, S, [keep]);
  const b = await r.poll();
  assert.ok(b?.kind === "reset" && b.cause === "truncated");
  assert.deepEqual(texts(b.events), ["keep"]);
  assert.ok(r.hasUuid(JSON.parse(keep).uuid));
  assert.equal(r.hasUuid(JSON.parse(drop).uuid), false);
});

test("missing is sent once; coming back is a 'replaced' reset with only the new content", async () => {
  const f = setup([userLine(S, "/syn/a", "old")]);
  const r = new TranscriptReader(f, nodeReadFs);
  await r.poll();
  fs.rmSync(f);
  assert.deepEqual(await r.poll(), { kind: "missing" });
  assert.equal(await r.poll(), null);
  writeTranscript(f, S, [userLine(S, "/syn/a", "back")]);
  const b = await r.poll();
  assert.ok(b?.kind === "reset" && b.cause === "replaced");
  assert.deepEqual(texts(b.events), ["back"]);
});

test("the window keeps the newest events; the uuid index keeps them all", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => userLine(S, "/syn/a", `m${i}`));
  const f = setup(lines);
  const r = new TranscriptReader(f, nodeReadFs, { maxEvents: 10, maxReadBytes: 512 });
  const b = await r.poll();
  assert.ok(b?.kind === "reset" && b.dropped === 20);
  assert.deepEqual(texts(b.events), Array.from({ length: 10 }, (_, i) => `m${i + 20}`));
  assert.ok(r.hasUuid(JSON.parse(lines[0]).uuid));
  assert.equal(r.stats.droppedEvents, 20);
});

test("§12.2 subagent files are tailed and only their latest assistant text is reported", async () => {
  const f = setup([userLine(S, "/syn/a", "main")]);
  const dir = subagentDir(f);
  fs.mkdirSync(dir, { recursive: true });
  const sub = path.join(dir, "agent-syn1.jsonl");
  writeTranscript(sub, S, [assistantLine(S, "/syn/a", [{ type: "text", text: `${MARK} step 1` }])]);
  fs.writeFileSync(path.join(dir, "notes.txt"), MARK);
  const tails = new SubagentTails(f, nodeReadFs);
  assert.deepEqual(await tails.poll(), [{ agentId: "agent-syn1", summary: `${MARK} step 1`, records: 2 }]);
  assert.deepEqual(await tails.poll(), []);
  appendLines(sub, [assistantLine(S, "/syn/a", [{ type: "text", text: `${MARK} step 2` }])]);
  assert.deepEqual((await tails.poll()).map((u) => u.summary), [`${MARK} step 2`]);
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/transcript/reader.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/transcript/reader.ts`.

- [ ] **Step 3: Implement** — `companiond/src/transcript/reader.ts`:

```ts
import type { ReadFs } from "../claude/readFs.ts";
import type { TranscriptEvent } from "./parser.ts";
import { TranscriptParser } from "./parser.ts";
import type { ResetReason, TailOptions } from "./tail.ts";
import { TranscriptTail } from "./tail.ts";

export interface SyncStats {
  records: number;
  /** Complete lines that were not a JSON object (spec §6.4 "skipped and counted"). */
  malformedLines: number;
  invalidUtf8Lines: number;
  oversizedLines: number;
  /** Records of a type the parser does not know (spec §16). */
  unknownRecords: number;
  /** Events that fell out of the front of the window since the file was (re)read. */
  droppedEvents: number;
}

export type ResetCause = "initial" | "truncated" | "replaced" | "session_id_changed";

export type TranscriptBatch =
  /** New events appended since the last batch (at most the window size; older ones were dropped). */
  | { kind: "append"; events: TranscriptEvent[] }
  /**
   * The current window, rebuilt. Restore cursors by `uuid` with hasUuid(); a uuid that is not known means
   * the cursor is gone (spec §6.4). `dropped` events came before the window and are not resent.
   */
  | { kind: "reset"; cause: ResetCause; events: TranscriptEvent[]; dropped: number }
  /** The file is gone or unreadable. Sent once per transition. */
  | { kind: "missing" };

export interface ReaderOptions extends TailOptions {
  /** Window size: newest events kept in memory (default 2,000). */
  maxEvents?: number;
  /** Window size by approximate text size (default 8 MiB). */
  maxEventBytes?: number;
}

export const MAX_WINDOW_EVENTS = 2_000;
export const MAX_WINDOW_BYTES = 8 * 1024 * 1024;

function approxSize(e: TranscriptEvent): number {
  let n = 64;
  for (const v of Object.values(e)) if (typeof v === "string") n += v.length;
  return n;
}

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Tail + parser + a rolling window of events for one transcript file. The uuid index covers every record
 * read since the last reset, including events that left the window.
 */
export class TranscriptReader {
  readonly path: string;
  readonly #tail: TranscriptTail;
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  #parser = new TranscriptParser();
  #events: TranscriptEvent[] = [];
  #sizes: number[] = [];
  #bytes = 0;
  #dropped = 0;
  #uuids = new Set<string>();
  #lastCwd: string | null = null;
  #lastBranch: string | null = null;
  #malformed = 0;
  #unknown = 0;
  #records = 0;
  #started = false;
  #missing = false;

  constructor(path: string, fs: ReadFs, opts: ReaderOptions = {}) {
    this.path = path;
    this.#tail = new TranscriptTail(path, fs, opts);
    this.#maxEvents = opts.maxEvents ?? MAX_WINDOW_EVENTS;
    this.#maxBytes = opts.maxEventBytes ?? MAX_WINDOW_BYTES;
  }

  /** The window: newest events, oldest first. */
  get events(): readonly TranscriptEvent[] {
    return this.#events;
  }

  hasUuid(uuid: string): boolean {
    return this.#uuids.has(uuid);
  }

  /** `cwd` of the latest main-chain (non-sidechain) record that has one (spec §6.3 candidate). */
  get latestCwd(): string | null {
    return this.#lastCwd;
  }

  get latestGitBranch(): string | null {
    return this.#lastBranch;
  }

  get stats(): SyncStats {
    return {
      records: this.#records,
      malformedLines: this.#malformed,
      unknownRecords: this.#unknown,
      droppedEvents: this.#dropped,
      ...this.#tail.stats,
    };
  }

  /** Reads everything new, one slice at a time, yielding between slices. Returns null when nothing changed. */
  async poll(): Promise<TranscriptBatch | null> {
    let r = await this.#tail.poll();
    if (r.kind === "missing") return this.#goneMissing();
    const wasMissing = this.#missing;
    this.#missing = false;
    let cause: ResetReason | null = r.reset ?? (wasMissing ? "replaced" : null);
    if (cause) this.#clear();
    let fresh = this.#ingest(r.lines);
    while (r.more) {
      await yieldNow();
      r = await this.#tail.poll();
      if (r.kind === "missing") return this.#goneMissing();
      if (r.reset) {
        this.#clear();
        cause = r.reset;
        fresh = [];
      }
      fresh = fresh.concat(this.#ingest(r.lines));
    }
    if (!this.#started) {
      this.#started = true;
      return { kind: "reset", cause: "initial", events: [...this.#events], dropped: this.#dropped };
    }
    if (cause) return { kind: "reset", cause, events: [...this.#events], dropped: this.#dropped };
    if (fresh.length === 0) return null;
    return { kind: "append", events: fresh.length > this.#events.length ? fresh.slice(-this.#events.length) : fresh };
  }

  #goneMissing(): TranscriptBatch | null {
    if (this.#missing) return null;
    this.#missing = true;
    return { kind: "missing" };
  }

  #clear(): void {
    this.#parser = new TranscriptParser();
    this.#events = [];
    this.#sizes = [];
    this.#bytes = 0;
    this.#dropped = 0;
    this.#uuids.clear();
    this.#lastCwd = null;
    this.#lastBranch = null;
    this.#malformed = 0;
    this.#unknown = 0;
    this.#records = 0;
  }

  #push(e: TranscriptEvent): void {
    const size = approxSize(e);
    this.#events.push(e);
    this.#sizes.push(size);
    this.#bytes += size;
  }

  #trimWindow(): void {
    let n = 0;
    let bytes = this.#bytes;
    while (this.#events.length - n > this.#maxEvents || (bytes > this.#maxBytes && this.#events.length - n > 1)) {
      bytes -= this.#sizes[n];
      n++;
    }
    if (n === 0) return;
    this.#events.splice(0, n);
    this.#sizes.splice(0, n);
    this.#bytes = bytes;
    this.#dropped += n;
  }

  #ingest(lines: string[]): TranscriptEvent[] {
    const fresh: TranscriptEvent[] = [];
    for (const line of lines) {
      const p = this.#parser.parseLine(line);
      if (!p.ok) {
        this.#malformed++;
        continue;
      }
      this.#records++;
      if (!p.known) this.#unknown++;
      if (p.uuid) this.#uuids.add(p.uuid);
      if (p.cwd && !p.isSidechain) {
        if (this.#lastCwd !== null && p.cwd !== this.#lastCwd) {
          fresh.push({ kind: "cwd_change", from: this.#lastCwd, to: p.cwd, uuid: p.uuid, timestamp: p.timestamp, isSidechain: false });
        }
        this.#lastCwd = p.cwd;
      }
      if (p.gitBranch && !p.isSidechain) this.#lastBranch = p.gitBranch;
      for (const e of p.events) fresh.push(e);
    }
    for (const e of fresh) this.#push(e);
    this.#trimWindow();
    return fresh;
  }
}
```

`companiond/src/transcript/subagents.ts`:

```ts
import path from "node:path";
import type { ReadFs } from "../claude/readFs.ts";
import { trimText } from "./parser.ts";
import { TranscriptReader } from "./reader.ts";

export interface SubagentUpdate {
  /** File name without `.jsonl`. */
  agentId: string;
  /** Latest assistant text of that subagent, trimmed. Only this enters context (spec §6.4). */
  summary: string;
  records: number;
}

export const SUBAGENT_SUMMARY_MAX = 2_000;

/** `<transcript dir>/<cliSessionId>/subagents/` for a transcript path. */
export function subagentDir(transcriptPath: string): string {
  return path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"), "subagents");
}

/** Tails every `*.jsonl` under a session's subagents folder with the same reader as the main transcript. */
export class SubagentTails {
  readonly dir: string;
  readonly #fs: ReadFs;
  readonly #readers = new Map<string, TranscriptReader>();
  readonly #last = new Map<string, string>();

  constructor(transcriptPath: string, fs: ReadFs) {
    this.dir = subagentDir(transcriptPath);
    this.#fs = fs;
  }

  async poll(): Promise<SubagentUpdate[]> {
    let names: string[] = [];
    try {
      names = await this.#fs.readdir(this.dir);
    } catch {
      return [];
    }
    const updates: SubagentUpdate[] = [];
    for (const name of names.filter((n) => /^[A-Za-z0-9_-]+\.jsonl$/.test(n)).sort()) {
      let reader = this.#readers.get(name);
      if (!reader) {
        reader = new TranscriptReader(path.join(this.dir, name), this.#fs);
        this.#readers.set(name, reader);
      }
      let batch;
      try {
        batch = await reader.poll();
      } catch {
        // Unreadable subagent file: drop its reader; the next poll starts it again.
        this.#readers.delete(name);
        continue;
      }
      if (batch === null || batch.kind === "missing") continue;
      const texts = reader.events.filter((e) => e.kind === "assistant_text");
      const latest = texts.length ? trimText(texts[texts.length - 1].text, SUBAGENT_SUMMARY_MAX) : "";
      if (latest === "" || this.#last.get(name) === latest) continue;
      this.#last.set(name, latest);
      updates.push({ agentId: name.slice(0, -6), summary: latest, records: reader.stats.records });
    }
    return updates;
  }
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `cd companiond && node --test test/transcript/reader.test.ts && npm run typecheck`
Expected: 7 pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/transcript/reader.ts companiond/src/transcript/subagents.ts companiond/test/transcript/reader.test.ts
git commit -m "feat(companiond): transcript reader with a rolling window and subagent summaries" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Exact worktree resolver over SafeGit

Spec §6.3, controller ruling. Flow: candidate = main-chain transcript `cwd`, else the record's `cwd` → `stat` + `realpath` through `ReadFs` → `SafeGit.locate({ gitPath, cwd })` (config gate first, then rev-parse; `LocateError.kind` maps `not_git` → `not_git`, `git_failed` → `git_failed`, `refused` → `repo_refused`) → the candidate's real path must **equal** `toplevel`, else `not_worktree_root` with `root` and `gitCommonDir` filled → `isApproved(toplevel, commonDir)` → `SafeGit.open({ root: toplevel, gitPath })` + `branch()` (`RepoRefusedError` → `repo_refused`; `GitError`, a spawn failure or anything else → `git_failed`). `git_failed` details are fixed text, never an error message (it could carry the git path or the folder); `repo_refused` carries the gate's `reason` (config key names). The equality check stops a worktree whose `.git` link is gone (git then walks up to the main checkout) from silently binding the main checkout. `describeChange` reports a move to another root and a change of state at the same root (for example approved → refused). The bridge caches one resolution per candidate (Task 15). Shape implemented to: M2's `SafeGit.locate` → `RepoDirs`, `SafeGit#branch()`, `LocateError`, `RepoRefusedError`, `GitError`, as added to M2 by controller ruling.

**Files:**
- Create: `companiond/src/worktree/resolver.ts`
- Test: `companiond/test/worktree/resolver.test.ts`

**Interfaces:**
- Consumes: `ReadFs` (Task 4); M2 `SafeGit.locate({ gitPath, cwd, timeoutMs? }): Promise<RepoDirs>`, `SafeGit.open({ root, gitPath })`, `SafeGit#branch(): Promise<string | null>`, `LocateError { kind: "not_git" | "git_failed" | "refused"; reason }`, `RepoRefusedError { reason }` (any other error from `open`/`branch` maps to `git_failed`); fixtures `makeRepo`, `fixtureGit`, `testGitPath`, `repoWithWorktree` (Task 4).
- Produces: `type CandidateSource = "transcript" | "desktop_record"`; `type UnavailableReason = "no_cwd" | "path_missing" | "not_directory" | "not_git" | "git_failed" | "repo_refused" | "not_worktree_root" | "not_approved"`; `type WorktreeResolution`; `type IsApproved = (root: string, gitCommonDir: string) => boolean`; `interface ResolveInput { transcriptCwd: string | null; recordCwd: string | null }`; `interface ResolveDeps { fs: ReadFs; gitPath: string; isApproved: IsApproved }`; `resolveWorktree(input, deps): Promise<WorktreeResolution>`; `interface RepoChange { from: string | null; to: string | null; banner: string; contextNote: string }`; `describeChange(prev, next): RepoChange | null`.

- [ ] **Step 1: Write the failing test** — `companiond/test/worktree/resolver.test.ts`:

```ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { IsApproved } from "../../src/worktree/resolver.ts";
import { describeChange, resolveWorktree } from "../../src/worktree/resolver.ts";
import { nodeReadFs } from "../../src/claude/readFs.ts";
import { fixtureGit, makeRepo, MARK, removeTempDirs, repoWithWorktree, tempDir, testGitPath } from "../helpers/fixtures.ts";

after(removeTempDirs);

const all: IsApproved = () => true;
const deps = (isApproved: IsApproved = all) => ({ fs: nodeReadFs, gitPath: testGitPath(), isApproved });

test("resolves a linked worktree exactly, with branch and common dir", async () => {
  const { main, worktree } = repoWithWorktree();
  const r = await resolveWorktree({ transcriptCwd: worktree, recordCwd: main }, deps());
  assert.equal(r.kind, "resolved");
  if (r.kind !== "resolved") return;
  assert.equal(r.root, worktree);
  assert.equal(r.isLinkedWorktree, true);
  assert.equal(r.gitCommonDir, path.join(main, ".git"));
  assert.equal(r.branch, "feature-a");
  assert.equal(r.candidateSource, "transcript");
});

test("the main checkout resolves as not a linked worktree", async () => {
  const { main } = repoWithWorktree();
  const r = await resolveWorktree({ transcriptCwd: null, recordCwd: main }, deps());
  assert.ok(r.kind === "resolved" && !r.isLinkedWorktree && r.candidateSource === "desktop_record");
});

test("§12.2 desktop/transcript cwd disagreement: the transcript wins", async () => {
  const { main, worktree } = repoWithWorktree();
  const r = await resolveWorktree({ transcriptCwd: worktree, recordCwd: main }, deps());
  assert.ok(r.kind === "resolved" && r.root === worktree);
});

test("§12.2 unapproved root → Unavailable with no fallback", async () => {
  const { main, worktree } = repoWithWorktree();
  const onlyMain: IsApproved = (root) => root === main;
  const r = await resolveWorktree({ transcriptCwd: worktree, recordCwd: main }, deps(onlyMain));
  assert.ok(r.kind === "unavailable" && r.reason === "not_approved" && r.root === worktree);
});

test("a repo whose config can run programs is repo_refused, with no fallback", async () => {
  const main = makeRepo();
  fixtureGit(main, ["config", "core.sshCommand", "/bin/false"]);
  const r = await resolveWorktree({ transcriptCwd: main, recordCwd: null }, deps());
  assert.ok(r.kind === "unavailable" && r.reason === "repo_refused", JSON.stringify(r));
  assert.equal(r.kind === "unavailable" && r.root, null);
});

test("a subfolder of a repo is never widened to the repo (no parent fallback)", async () => {
  const main = makeRepo();
  const sub = path.join(main, "sub");
  fs.mkdirSync(sub);
  const r = await resolveWorktree({ transcriptCwd: sub, recordCwd: null }, deps());
  assert.ok(r.kind === "unavailable" && r.reason === "not_worktree_root" && r.root === main);
});

test("a worktree whose .git link was removed is not resolved to the main checkout", async () => {
  const { main, worktree } = repoWithWorktree();
  const nested = path.join(main, "nested-wt");
  fixtureGit(main, ["worktree", "add", "-q", "-b", "nested", nested]);
  fs.rmSync(path.join(nested, ".git"));
  const r = await resolveWorktree({ transcriptCwd: nested, recordCwd: worktree }, deps());
  assert.ok(r.kind === "unavailable" && r.reason === "not_worktree_root" && r.root === main, JSON.stringify(r));
});

test("missing folder, file instead of folder, non-git folder, no cwd", async () => {
  const dir = tempDir();
  const file = path.join(dir, "f.txt");
  fs.writeFileSync(file, MARK);
  const reason = async (t: string | null) => {
    const r = await resolveWorktree({ transcriptCwd: t, recordCwd: null }, deps());
    return r.kind === "unavailable" ? r.reason : "resolved";
  };
  assert.equal(await reason(path.join(dir, "gone")), "path_missing");
  assert.equal(await reason(file), "not_directory");
  assert.equal(await reason(dir), "not_git");
  assert.equal(await reason(null), "no_cwd");
});

test("§12.2 worktree switch mid-session and move into another repo are never silent", async () => {
  const a = repoWithWorktree();
  const b = repoWithWorktree();
  const r1 = await resolveWorktree({ transcriptCwd: a.main, recordCwd: null }, deps());
  const r2 = await resolveWorktree({ transcriptCwd: a.worktree, recordCwd: null }, deps());
  const r3 = await resolveWorktree({ transcriptCwd: b.main, recordCwd: null }, deps((root) => root !== b.main));
  const c12 = describeChange(r1, r2);
  assert.ok(c12);
  assert.equal(c12.banner, `Claude is now in ${a.worktree} (feature-a)`);
  assert.equal(c12.contextNote, `Repository changed from ${a.main} to ${a.worktree}`);
  const c23 = describeChange(r2, r3);
  assert.ok(c23 && r3.kind === "unavailable" && r3.reason === "not_approved");
  assert.match(c23.banner, /unavailable/);
  assert.equal(describeChange(r2, r2), null);
  assert.equal(describeChange(null, r1), null);
});

test("the same root changing state (approved → refused) is a change too", async () => {
  const main = makeRepo();
  const ok = await resolveWorktree({ transcriptCwd: main, recordCwd: null }, deps());
  fixtureGit(main, ["config", "core.sshCommand", "/bin/false"]);
  const refused = await resolveWorktree({ transcriptCwd: main, recordCwd: null }, deps());
  const c = describeChange(ok, refused);
  assert.ok(c);
  assert.match(c.contextNote, /is now unavailable$/);
});

test("detached HEAD reports detached@<sha>", async () => {
  const main = makeRepo();
  fixtureGit(main, ["checkout", "-q", "--detach"]);
  const r = await resolveWorktree({ transcriptCwd: main, recordCwd: null }, deps());
  assert.ok(r.kind === "resolved");
  assert.match(r.branch ?? "", /^detached@[0-9a-f]+$/);
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/worktree/resolver.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/worktree/resolver.ts`.

- [ ] **Step 3: Implement** — `companiond/src/worktree/resolver.ts`:

```ts
import type { ReadFs } from "../claude/readFs.ts";
import { LocateError, RepoRefusedError, SafeGit } from "../git/safeGit.ts";

export type CandidateSource = "transcript" | "desktop_record";

export type UnavailableReason =
  | "no_cwd"
  | "path_missing"
  | "not_directory"
  | "not_git"
  | "git_failed"
  /** SafeGit's config gate refused the repo (program-valued git config, spec §7.3). */
  | "repo_refused"
  /** cwd is inside a work tree but is not its top level; we never widen to the parent. */
  | "not_worktree_root"
  | "not_approved";

export type WorktreeResolution =
  | {
      kind: "resolved";
      /** The bound root: the git toplevel, real path. */
      root: string;
      gitDir: string;
      gitCommonDir: string;
      /** True for a linked worktree (gitDir differs from gitCommonDir). */
      isLinkedWorktree: boolean;
      branch: string | null;
      candidate: string;
      candidateSource: CandidateSource;
    }
  | {
      kind: "unavailable";
      reason: UnavailableReason;
      /** Plain-language reason for the UI. */
      detail: string;
      candidate: string | null;
      candidateSource: CandidateSource | null;
      /** Filled when git answered (not_worktree_root, not_approved) so the UI can offer approval. */
      root: string | null;
      gitCommonDir: string | null;
    };

/** Approval lives in M4's Store/privacy model; the resolver only asks. */
export type IsApproved = (root: string, gitCommonDir: string) => boolean;

export interface ResolveInput {
  /** `cwd` of the latest main-chain transcript record that has one. */
  transcriptCwd: string | null;
  /** The desktop record's `cwd`; used only before the transcript has any. */
  recordCwd: string | null;
}

export interface ResolveDeps {
  fs: ReadFs;
  /** Absolute git path: M4 passes discoverToolchain().gitPath (M2); tests pass testGitPath(). */
  gitPath: string;
  isApproved: IsApproved;
}

/**
 * Spec §6.3. stat/realpath through ReadFs → SafeGit.locate (config gate, then rev-parse) → the candidate's
 * real path must equal the toplevel → approved → SafeGit.open(toplevel) + branch(). Any failure is
 * Unavailable with a reason. Never falls back to another root. M3 never runs git itself.
 */
export async function resolveWorktree(input: ResolveInput, deps: ResolveDeps): Promise<WorktreeResolution> {
  const candidate = input.transcriptCwd ?? input.recordCwd;
  const candidateSource: CandidateSource | null = input.transcriptCwd ? "transcript" : input.recordCwd ? "desktop_record" : null;
  const unavailable = (reason: UnavailableReason, detail: string, root: string | null = null, gitCommonDir: string | null = null): WorktreeResolution => ({
    kind: "unavailable",
    reason,
    detail,
    candidate,
    candidateSource,
    root,
    gitCommonDir,
  });
  if (candidate === null || candidateSource === null) return unavailable("no_cwd", "Claude has not reported a working folder yet");
  let real: string;
  try {
    const st = await deps.fs.stat(candidate);
    if (!st.isDirectory()) return unavailable("not_directory", "Claude's working folder is not a folder");
    real = await deps.fs.realpath(candidate);
  } catch {
    return unavailable("path_missing", "Claude's working folder no longer exists");
  }
  let dirs;
  try {
    dirs = await SafeGit.locate({ gitPath: deps.gitPath, cwd: real });
  } catch (err) {
    if (err instanceof LocateError) {
      if (err.kind === "refused") return unavailable("repo_refused", `Repository refused: ${err.reason}`);
      if (err.kind === "not_git") return unavailable("not_git", "Claude's working folder is not a Git repository");
    }
    // Fixed text: an error message could contain the git path or the folder.
    return unavailable("git_failed", "git could not read this folder");
  }
  if (dirs.toplevel !== real) {
    return unavailable("not_worktree_root", "Claude's working folder is inside a repository but is not its top folder", dirs.toplevel, dirs.commonDir);
  }
  if (!deps.isApproved(dirs.toplevel, dirs.commonDir)) return unavailable("not_approved", "This repository is not approved yet", dirs.toplevel, dirs.commonDir);
  let branch: string | null;
  try {
    const git = await SafeGit.open({ root: dirs.toplevel, gitPath: deps.gitPath });
    branch = await git.branch();
  } catch (err) {
    if (err instanceof RepoRefusedError) return unavailable("repo_refused", `Repository refused: ${err.reason}`, dirs.toplevel, dirs.commonDir);
    // GitError, a spawn failure or anything else: fixed text, never the error message.
    return unavailable("git_failed", "git could not read this repository", dirs.toplevel, dirs.commonDir);
  }
  return {
    kind: "resolved",
    root: dirs.toplevel,
    gitDir: dirs.gitDir,
    gitCommonDir: dirs.commonDir,
    isLinkedWorktree: dirs.gitDir !== dirs.commonDir,
    branch,
    candidate,
    candidateSource,
  };
}

export interface RepoChange {
  from: string | null;
  to: string | null;
  /** Banner text (spec §6.3). */
  banner: string;
  /** Line for the next turn's context block (spec §6.3). */
  contextNote: string;
}

const where = (r: WorktreeResolution): string | null => (r.kind === "resolved" ? r.root : (r.root ?? r.candidate));
const state = (r: WorktreeResolution): string => (r.kind === "resolved" ? "resolved" : `unavailable:${r.reason}`);

/** Non-null when the session moved, or its repository changed state (e.g. became refused). Never silent (spec §6.3). */
export function describeChange(prev: WorktreeResolution | null, next: WorktreeResolution): RepoChange | null {
  if (prev === null) return null;
  const from = where(prev);
  const to = where(next);
  if (from === to && state(prev) === state(next)) return null;
  const label = next.kind === "resolved" ? `${next.root} (${next.branch ?? "unknown branch"})` : `${to ?? "an unknown folder"} — unavailable: ${next.detail}`;
  const contextNote =
    from === to
      ? `Repository ${to ?? "none"} is now ${next.kind === "resolved" ? "available" : "unavailable"}`
      : `Repository changed from ${from ?? "none"} to ${to ?? "none"}`;
  return { from, to, banner: `Claude is now in ${label}`, contextNote };
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `cd companiond && node --test test/worktree/resolver.test.ts test/claude/readFs.test.ts && npm run typecheck`
Expected: 11 pass in `resolver.test.ts`; `readFs.test.ts` still passes (the static scan now covers `worktree/`, which imports no `child_process`); `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/worktree/resolver.ts companiond/test/worktree/resolver.test.ts
git commit -m "feat(companiond): resolve the exact worktree through SafeGit with no fallback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Status, focus, pin and picker

Pure functions for spec §6.2. Focus = highest `lastFocusedAt` among non-archived; ties → latest `lastActivityAt`; then `sessionId` (deterministic). Pin overrides focus; while pinned, a focus move only fills `focusMovedTo`. A pinned session that disappears stays pinned with `pinnedMissing`, never swapped silently. Picker rows carry `resolvedRoot` when known, and search matches it.

**Files:**
- Create: `companiond/src/bridge/selection.ts`
- Test: `companiond/test/bridge/selection.test.ts`

**Interfaces:**
- Consumes: `LiveState` (Task 6).
- Produces: `type SessionStatus`; `interface SessionSummary`; `RECENT_WINDOW_MS`; `FOCUS_LABEL = "Claude focus (from Claude's records)"`; `computeStatus(live, lastActivityAt, now): SessionStatus`; `focusedSessionId(sessions): string | null`; `interface Pin { sessionId; focusAtPin: string | null }`; `interface Selection`; `select(sessions, pin: Pin | null): Selection`; `interface PickerGroups { busy; idle; recent; older }`; `interface PickerOptions { includeArchived?; query? }`; `pickerGroups(sessions, opts?): PickerGroups`.

- [ ] **Step 1: Write the failing test** — `companiond/test/bridge/selection.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "../../src/bridge/selection.ts";
import { computeStatus, focusedSessionId, pickerGroups, RECENT_WINDOW_MS, select } from "../../src/bridge/selection.ts";
import { MARK } from "../helpers/fixtures.ts";

const NOW = Date.UTC(2026, 10, 4, 12);
const s = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  cliSessionId: `cli-${id}`,
  title: `${MARK} ${id}`,
  status: "recent",
  isArchived: false,
  lastFocusedAt: null,
  lastActivityAt: null,
  recordCwd: `/syn/${id}`,
  recordBranch: null,
  resolvedRoot: null,
  source: "desktop",
  transcriptPath: null,
  transcriptMissing: null,
  ...over,
});

test("status: live state wins, else recent within 24 h, else inactive", () => {
  assert.equal(computeStatus("busy", null, NOW), "busy");
  assert.equal(computeStatus("idle", null, NOW), "idle");
  assert.equal(computeStatus(null, NOW - RECENT_WINDOW_MS + 1, NOW), "recent");
  assert.equal(computeStatus(null, NOW - RECENT_WINDOW_MS - 1, NOW), "inactive");
  assert.equal(computeStatus(null, null, NOW), "inactive");
});

test("§12.2 multiple open sessions: focus is the highest lastFocusedAt", () => {
  assert.equal(focusedSessionId([s("a", { lastFocusedAt: 1 }), s("b", { lastFocusedAt: 3 }), s("c", { lastFocusedAt: 2 })]), "b");
});

test("focus ties go to the latest lastActivityAt", () => {
  assert.equal(focusedSessionId([s("a", { lastFocusedAt: 5, lastActivityAt: 1 }), s("b", { lastFocusedAt: 5, lastActivityAt: 9 })]), "b");
});

test("§12.2 archived records never take focus and are hidden from the picker by default", () => {
  const list = [s("a", { lastFocusedAt: 9, isArchived: true }), s("b", { lastFocusedAt: 1 })];
  assert.equal(focusedSessionId(list), "b");
  assert.deepEqual(pickerGroups(list).recent.map((x) => x.sessionId), ["b"]);
  assert.deepEqual(pickerGroups(list, { includeArchived: true }).recent.map((x) => x.sessionId).sort(), ["a", "b"]);
});

test("§12.2 lagging lastFocusedAt: focus follows Claude's records only, labelled as such", () => {
  // b is busier and more recent, but Claude's record still says a is focused.
  const list = [s("a", { lastFocusedAt: 10, lastActivityAt: 10 }), s("b", { lastFocusedAt: 5, lastActivityAt: 99, status: "busy" })];
  const sel = select(list, null);
  assert.equal(sel.sessionId, "a");
  assert.equal(sel.focusLabel, "Claude focus (from Claude's records)");
});

test("§12.2 pinned session ignores focus; a focus move shows the chip", () => {
  const before = [s("a", { lastFocusedAt: 10 }), s("b", { lastFocusedAt: 5 })];
  const pin = { sessionId: "b", focusAtPin: focusedSessionId(before) };
  assert.deepEqual(select(before, pin).focusMovedTo, null);
  const after = [s("a", { lastFocusedAt: 10 }), s("b", { lastFocusedAt: 5 }), s("c", { lastFocusedAt: 20 })];
  const sel = select(after, pin);
  assert.equal(sel.sessionId, "b");
  assert.equal(sel.via, "pin");
  assert.equal(sel.focusMovedTo, "c");
});

test("a pinned session that disappears stays pinned and is flagged", () => {
  const sel = select([s("a", { lastFocusedAt: 1 })], { sessionId: "gone", focusAtPin: "a" });
  assert.equal(sel.sessionId, "gone");
  assert.equal(sel.pinnedMissing, true);
});

test("picker groups by status and searches title, cwd and branch", () => {
  const list = [s("a", { status: "busy" }), s("b", { status: "idle", recordBranch: "feature-x" }), s("c"), s("d", { status: "inactive" })];
  const g = pickerGroups(list);
  assert.deepEqual([g.busy.length, g.idle.length, g.recent.length, g.older.length], [1, 1, 1, 0]);
  assert.deepEqual(pickerGroups(list, { query: "FEATURE-X" }).idle.map((x) => x.sessionId), ["b"]);
  assert.deepEqual(pickerGroups(list, { query: "/syn/d" }).older.map((x) => x.sessionId), ["d"]);
});

test("picker search also matches the resolved root", () => {
  const list = [s("a", { resolvedRoot: "/syn/wt/feature-z" })];
  assert.deepEqual(pickerGroups(list, { query: "feature-z" }).recent.map((x) => x.sessionId), ["a"]);
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/bridge/selection.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/bridge/selection.ts`.

- [ ] **Step 3: Implement** — `companiond/src/bridge/selection.ts`:

```ts
import type { LiveState } from "../claude/runningFiles.ts";

export type SessionStatus = "busy" | "idle" | "recent" | "inactive";

export interface SessionSummary {
  /** Stable key. Desktop `sessionId`, or `transcript:<cliSessionId>` when desktop records are unreadable. */
  sessionId: string;
  cliSessionId: string | null;
  title: string;
  status: SessionStatus;
  isArchived: boolean;
  lastFocusedAt: number | null;
  lastActivityAt: number | null;
  recordCwd: string | null;
  /** Branch as Claude's record last saw it. The live branch is in the worktree resolution. */
  recordBranch: string | null;
  /** Exact root once resolved (tailed sessions only); the picker shows it instead of recordCwd. */
  resolvedRoot: string | null;
  source: "desktop" | "transcript_only";
  transcriptPath: string | null;
  /** Why no transcript was accepted (spec §6.1), null when found. */
  transcriptMissing: "invalid_id" | "not_found" | "session_id_mismatch" | null;
}

export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FOCUS_LABEL = "Claude focus (from Claude's records)";

/** Spec §6.2. */
export function computeStatus(live: LiveState | null, lastActivityAt: number | null, now: number): SessionStatus {
  if (live) return live;
  if (lastActivityAt !== null && now - lastActivityAt <= RECENT_WINDOW_MS) return "recent";
  return "inactive";
}

/** Highest lastFocusedAt among non-archived; ties → latest lastActivityAt; then sessionId for determinism. */
export function focusedSessionId(sessions: readonly SessionSummary[]): string | null {
  let best: SessionSummary | null = null;
  for (const s of sessions) {
    if (s.isArchived || s.lastFocusedAt === null) continue;
    if (
      best === null ||
      s.lastFocusedAt > (best.lastFocusedAt ?? -Infinity) ||
      (s.lastFocusedAt === best.lastFocusedAt &&
        ((s.lastActivityAt ?? -Infinity) > (best.lastActivityAt ?? -Infinity) ||
          ((s.lastActivityAt ?? -Infinity) === (best.lastActivityAt ?? -Infinity) && s.sessionId < best.sessionId)))
    ) {
      best = s;
    }
  }
  return best?.sessionId ?? null;
}

export interface Pin {
  sessionId: string;
  /** Focused session when the pin was set; a different focus later shows the chip. */
  focusAtPin: string | null;
}

export interface Selection {
  sessionId: string | null;
  via: "pin" | "focus" | "none";
  focusedSessionId: string | null;
  focusLabel: typeof FOCUS_LABEL;
  /** While pinned: the session Claude's focus moved to ("Claude focus moved to X — switch?"). */
  focusMovedTo: string | null;
  /** The pinned session is no longer listed. Kept pinned, never swapped silently. */
  pinnedMissing: boolean;
}

export function select(sessions: readonly SessionSummary[], pin: Pin | null): Selection {
  const focused = focusedSessionId(sessions);
  if (pin) {
    const moved = focused !== null && focused !== pin.focusAtPin && focused !== pin.sessionId ? focused : null;
    return {
      sessionId: pin.sessionId,
      via: "pin",
      focusedSessionId: focused,
      focusLabel: FOCUS_LABEL,
      focusMovedTo: moved,
      pinnedMissing: !sessions.some((s) => s.sessionId === pin.sessionId),
    };
  }
  return { sessionId: focused, via: focused ? "focus" : "none", focusedSessionId: focused, focusLabel: FOCUS_LABEL, focusMovedTo: null, pinnedMissing: false };
}

export interface PickerGroups {
  busy: SessionSummary[];
  idle: SessionSummary[];
  recent: SessionSummary[];
  /** Inactive sessions, shown when searching. */
  older: SessionSummary[];
}

export interface PickerOptions {
  includeArchived?: boolean;
  /** Case-insensitive match on title, resolved root, cwd or branch. */
  query?: string;
}

/** Spec §6.2 manual picker: Busy / Idle / Recent, archived hidden by default, searchable. */
export function pickerGroups(sessions: readonly SessionSummary[], opts: PickerOptions = {}): PickerGroups {
  const q = opts.query?.trim().toLowerCase() ?? "";
  const groups: PickerGroups = { busy: [], idle: [], recent: [], older: [] };
  const byActivity = [...sessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  for (const s of byActivity) {
    if (s.isArchived && !opts.includeArchived) continue;
    if (q && ![s.title, s.resolvedRoot ?? "", s.recordCwd ?? "", s.recordBranch ?? ""].some((v) => v.toLowerCase().includes(q))) continue;
    if (s.status === "busy") groups.busy.push(s);
    else if (s.status === "idle") groups.idle.push(s);
    else if (s.status === "recent") groups.recent.push(s);
    else if (q) groups.older.push(s);
  }
  return groups;
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `cd companiond && node --test test/bridge/selection.test.ts && npm run typecheck`
Expected: 9 pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/bridge/selection.ts companiond/test/bridge/selection.test.ts
git commit -m "feat(companiond): session status, focus, pin and picker groups" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: Watch hints and the transcript-only listing

`nodeWatchFactory` wraps `fs.watch` (recursive, non-persistent). A folder that cannot be watched (for example missing, `ENOENT`) is reported through `onError`, never thrown; the bridge then keeps polling and re-arms later with backoff (Task 15). `listTranscripts` is what the picker shows when desktop records are unreadable (spec §6.2): accepted transcripts (the `sessionId` check), newest first, at most 200.

**Files:**
- Create: `companiond/src/bridge/watcher.ts`
- Create: `companiond/src/bridge/transcriptOnly.ts`
- Test: `companiond/test/bridge/watcher.test.ts`

**Interfaces:**
- Consumes: `ReadFs`, `isSafeId` (Task 4); `transcriptHasSessionId` (Task 7).
- Produces: `interface WatchHandle { close(): void }`; `type WatchFactory = (dir: string, onChange: () => void, onError: (err: Error) => void) => WatchHandle`; `nodeWatchFactory: WatchFactory`; `interface TranscriptOnlyEntry { cliSessionId: string; path: string; mtimeMs: number }`; `listTranscripts(fs, projectsDir, max?): Promise<TranscriptOnlyEntry[]>`; `TRANSCRIPT_ONLY_MAX = 200`.

- [ ] **Step 1: Write the failing test** — `companiond/test/bridge/watcher.test.ts`:

```ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nodeWatchFactory } from "../../src/bridge/watcher.ts";
import { listTranscripts } from "../../src/bridge/transcriptOnly.ts";
import { nodeReadFs } from "../../src/claude/readFs.ts";
import { claudeTree, MARK, removeTempDirs, tempDir, transcriptPath, userLine, writeTranscript } from "../helpers/fixtures.ts";

after(removeTempDirs);

test("watching a missing directory reports ENOENT instead of throwing", async () => {
  const err = await new Promise<Error>((resolve) => {
    const h = nodeWatchFactory(path.join(tempDir(), "missing"), () => {}, resolve);
    h.close();
  });
  assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
});

test("watching an existing directory returns a closable handle", () => {
  const h = nodeWatchFactory(tempDir(), () => {}, () => assert.fail("unexpected watcher error"));
  h.close();
});

test("listTranscripts lists accepted transcripts newest first and skips others", async () => {
  const p = claudeTree();
  const older = transcriptPath(p, "/syn/a", "cli-old");
  const newer = transcriptPath(p, "/syn/b", "cli-new");
  writeTranscript(older, "cli-old", [userLine("cli-old", "/syn/a", "x")]);
  writeTranscript(newer, "cli-new", [userLine("cli-new", "/syn/b", "y")]);
  fs.utimesSync(older, new Date(2026, 0, 1), new Date(2026, 0, 1));
  writeTranscript(transcriptPath(p, "/syn/c", "cli-wrong"), "cli-someone-else", []);
  fs.writeFileSync(path.join(p.projectsDir, "stray.txt"), MARK);
  const list = await listTranscripts(nodeReadFs, p.projectsDir);
  assert.deepEqual(list.map((e) => e.cliSessionId), ["cli-new", "cli-old"]);
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/bridge/watcher.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/bridge/watcher.ts`.

- [ ] **Step 3: Implement** — `companiond/src/bridge/watcher.ts`:

```ts
import { watch } from "node:fs";

export interface WatchHandle {
  close(): void;
}

/**
 * A change hint for a directory. Hints only speed things up: correctness comes from polling,
 * because fs.watch may coalesce or drop events and may omit the file name.
 */
export type WatchFactory = (dir: string, onChange: () => void, onError: (err: Error) => void) => WatchHandle;

export const nodeWatchFactory: WatchFactory = (dir, onChange, onError) => {
  try {
    const w = watch(dir, { persistent: false, recursive: true }, () => onChange());
    w.on("error", (err: Error) => onError(err));
    return { close: () => w.close() };
  } catch (err) {
    queueMicrotask(() => onError(err as Error));
    return { close() {} };
  }
};
```

`companiond/src/bridge/transcriptOnly.ts`:

```ts
import path from "node:path";
import type { ReadFs } from "../claude/readFs.ts";
import { isSafeId } from "../claude/paths.ts";
import { transcriptHasSessionId } from "../claude/transcriptLocator.ts";

export interface TranscriptOnlyEntry {
  cliSessionId: string;
  path: string;
  mtimeMs: number;
}

export const TRANSCRIPT_ONLY_MAX = 200;

/** Used when desktop records are unreadable (spec §6.2): the picker still lists transcripts. Newest first. */
export async function listTranscripts(fs: ReadFs, projectsDir: string, max = TRANSCRIPT_ONLY_MAX): Promise<TranscriptOnlyEntry[]> {
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(projectsDir);
  } catch {
    return [];
  }
  const found: TranscriptOnlyEntry[] = [];
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(projectsDir, d));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const id = n.slice(0, -6);
      if (!isSafeId(id)) continue;
      const file = path.join(projectsDir, d, n);
      try {
        const st = await fs.stat(file);
        if (st.isFile()) found.push({ cliSessionId: id, path: file, mtimeMs: st.mtimeMs });
      } catch {
        // vanished
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: TranscriptOnlyEntry[] = [];
  for (const e of found) {
    if (out.length >= max) break;
    if (await transcriptHasSessionId(fs, e.path, e.cliSessionId)) out.push(e);
  }
  return out;
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `cd companiond && node --test test/bridge/watcher.test.ts test/claude/readFs.test.ts && npm run typecheck`
Expected: 3 pass in `watcher.test.ts`; `readFs.test.ts` still passes (`watcher.ts` imports only `watch` from `node:fs`); `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/bridge/watcher.ts companiond/src/bridge/transcriptOnly.ts companiond/test/bridge/watcher.test.ts
git commit -m "feat(companiond): watch hints and the transcript-only session list" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: `SessionBridge` and the §12.2 suite

The bridge runs one operation at a time on a promise queue, with **at most one tick waiting** (extra `tick()` calls return the queued one). `tick()` re-reads records and running files (start times cached per live pid), recomputes status and selection, and polls the tails of the **selected session and every busy session**; other sessions are listed but not tailed. Readers of sessions that stop being tailed are parked (LRU, 8), so switching back continues where it stopped. `refresh()` does the same after forgetting cached transcript locations (refresh button, ⌘R, wake, watcher error). The record is re-read on every pass, so a `cliSessionId` change is followed to the new file under the same desktop `sessionId` (spec §6.1); the last cliSessionId per session is remembered outside the tracked readers, so the change is reported as `reset` with cause `session_id_changed` even when the new file appears later. Worktree resolution runs once per candidate (and on `refresh`/`resolveNow`); SafeGit's config gate runs on each resolution. Watching: desktop records and running files → a debounced `tick()`; transcripts → a tail poll only. A watcher error closes only that watcher, emits `sync_error` (a label and an error code, never a path), runs `refresh()` unless the code is `ENOENT`, and re-creates that watcher after `rewatchDelayMs`, doubling up to 60 s. `stop()` clears every timer. Every fire-and-forget call (`start`, the timer, hints, pin, watcher errors) goes through `#background`, so a failed pass is a `sync_error` and never an unhandled rejection. A pinned session that leaves the list stays pinned (`pinnedMissing`) but is not tailed; sessions that leave the list drop their parked reader, subagent tails, remembered cliSessionId and cached location. Every reader the bridge gets is wrapped in `guardReadFs` with the `onRefusedPath` hook.

**Files:**
- Create: `companiond/src/bridge/sessionBridge.ts`
- Test: `companiond/test/bridge/sessionBridge.test.ts`

**Interfaces:**
- Consumes: `ClaudePaths`, `ReadFs`, `guardReadFs`, `nodeReadFs` (Task 4); `readDesktopRecords`, `DesktopRecord`, `DESKTOP_NOT_FOUND` (Task 5); `ProcessProbe`, `readRunningFiles`, `liveStates`, `cacheStartTimes`, `nodeProcessProbe` (Task 6); `locateTranscript`, `TranscriptLocation` (Task 7); `TranscriptEvent` (Task 9); `TranscriptReader`, `TranscriptBatch`, `SyncStats`, `SubagentTails`, `SubagentUpdate` (Task 11); `resolveWorktree`, `describeChange`, `WorktreeResolution`, `RepoChange`, `IsApproved` (Task 12); `computeStatus`, `focusedSessionId`, `select`, `Pin`, `Selection`, `SessionSummary` (Task 13); `WatchFactory`, `WatchHandle`, `nodeWatchFactory`, `listTranscripts` (Task 14); M2 `SafeGit.open`, `SafeGit#branch`; fixtures `testGitPath` and the Claude builders.
- Produces: `SessionBridge`, `SessionBridgeOptions`, `SessionsSnapshot`, `BridgeEvent`, `BridgeListener`, `SyncStatus` (see "Interfaces produced for M4/M5").

- [ ] **Step 1: Write the failing test** — `companiond/test/bridge/sessionBridge.test.ts`:

```ts
// §12.2 session sync suite — synthetic fixtures in temp dirs only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { BridgeEvent, SessionBridgeOptions } from "../../src/bridge/sessionBridge.ts";
import { SessionBridge } from "../../src/bridge/sessionBridge.ts";
import type { WatchFactory } from "../../src/bridge/watcher.ts";
import type { ProcessProbe } from "../../src/claude/runningFiles.ts";
import type { ReadFs } from "../../src/claude/readFs.ts";
import { nodeReadFs } from "../../src/claude/readFs.ts";
import { DESKTOP_NOT_FOUND } from "../../src/claude/desktopRecords.ts";
import {
  appendLines,
  assistantLine,
  claudeTree,
  MARK,
  removeTempDirs,
  repoWithWorktree,
  testGitPath,
  transcriptPath,
  userLine,
  writeRecord,
  writeRunning,
  writeTranscript,
} from "../helpers/fixtures.ts";

after(removeTempDirs);

const T0 = Date.UTC(2026, 10, 4, 12);
const START = T0 - 3_600_000;

function fakeProbe(procs: Record<number, number>): ProcessProbe {
  return { isAlive: (pid) => pid in procs, startTimeMs: async (pid) => procs[pid] ?? null };
}

function harness(over: Partial<SessionBridgeOptions> = {}) {
  const p = claudeTree();
  const events: BridgeEvent[] = [];
  const make = (extra: Partial<SessionBridgeOptions> = {}) => {
    const b = new SessionBridge({
      paths: p,
      isApproved: () => true,
      gitPath: testGitPath(),
      probe: fakeProbe({}),
      now: () => T0,
      watch: null,
      ...over,
      ...extra,
    });
    b.on((e) => events.push(e));
    return b;
  };
  const take = () => events.splice(0);
  return { p, make, take };
}

const ofType = <T extends BridgeEvent["type"]>(events: BridgeEvent[], type: T) =>
  events.filter((e): e is Extract<BridgeEvent, { type: T }> => e.type === type);

function fakeWatch() {
  const created: Array<{ label: number; dir: string; onChange: () => void; onError: (e: Error) => void; closed: boolean }> = [];
  const watch: WatchFactory = (dir, onChange, onError) => {
    const w = { label: created.length, dir, onChange, onError, closed: false };
    created.push(w);
    return { close: () => void (w.closed = true) };
  };
  return { created, watch };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("§12.2 multiple open sessions and focus moving", async () => {
  const { p, make, take } = harness();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 - 10, lastActivityAt: T0 - 10 });
  writeRecord(p, { sessionId: "local_syn-b", cliSessionId: "cli-b", cwd: "/syn/b", lastFocusedAt: T0 - 20, lastActivityAt: T0 - 20 });
  writeTranscript(transcriptPath(p, "/syn/a", "cli-a"), "cli-a", [userLine("cli-a", "/syn/a", "a1")]);
  writeTranscript(transcriptPath(p, "/syn/b", "cli-b"), "cli-b", [userLine("cli-b", "/syn/b", "b1")]);
  const b = make();
  await b.refresh();
  assert.equal(b.snapshot().selection.sessionId, "local_syn-a");
  assert.deepEqual(ofType(take(), "transcript").map((e) => e.sessionId), ["local_syn-a"]);
  writeRecord(p, { sessionId: "local_syn-b", cliSessionId: "cli-b", cwd: "/syn/b", lastFocusedAt: T0, lastActivityAt: T0 });
  await b.tick();
  const ev = take();
  assert.equal(b.snapshot().selection.sessionId, "local_syn-b");
  assert.equal(ofType(ev, "sessions").at(-1)?.snapshot.selection.via, "focus");
  assert.deepEqual(ofType(ev, "transcript").map((e) => [e.sessionId, e.batch.kind]), [["local_syn-b", "reset"]]);
  assert.equal(b.events("local_syn-b").length, 1);
});

test("switching back to a session reuses its parked reader (no re-read from 0)", async () => {
  const { p, make, take } = harness();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 });
  writeRecord(p, { sessionId: "local_syn-b", cliSessionId: "cli-b", cwd: "/syn/b", lastFocusedAt: T0 - 1 });
  writeTranscript(transcriptPath(p, "/syn/a", "cli-a"), "cli-a", [userLine("cli-a", "/syn/a", "a1")]);
  writeTranscript(transcriptPath(p, "/syn/b", "cli-b"), "cli-b", [userLine("cli-b", "/syn/b", "b1")]);
  const b = make();
  await b.refresh();
  b.pin("local_syn-b");
  await b.idle();
  take();
  b.pin("local_syn-a");
  await b.idle();
  assert.deepEqual(ofType(take(), "transcript"), []);
  assert.equal(b.events("local_syn-a").length, 1);
});

test("§12.2 two busy sessions appending at once each update only their own state", async () => {
  const { p, make, take } = harness({ probe: fakeProbe({ 101: START, 102: START }) });
  for (const id of ["a", "b"]) {
    writeRecord(p, { sessionId: `local_syn-${id}`, cliSessionId: `cli-${id}`, cwd: `/syn/${id}`, lastFocusedAt: T0, lastActivityAt: T0 });
    writeTranscript(transcriptPath(p, `/syn/${id}`, `cli-${id}`), `cli-${id}`, []);
  }
  writeRunning(p, 101, { sessionId: "cli-a", status: "busy", entrypoint: "claude-desktop", procStart: START });
  writeRunning(p, 102, { sessionId: "cli-b", status: "busy", entrypoint: "claude-desktop", procStart: START });
  const b = make();
  await b.refresh();
  assert.deepEqual(b.snapshot().sessions.map((s) => s.status), ["busy", "busy"]);
  take();
  appendLines(transcriptPath(p, "/syn/a", "cli-a"), [userLine("cli-a", "/syn/a", "from a")]);
  appendLines(transcriptPath(p, "/syn/b", "cli-b"), [userLine("cli-b", "/syn/b", "from b"), userLine("cli-b", "/syn/b", "again b")]);
  await b.tick();
  const tr = ofType(take(), "transcript");
  const counts = Object.fromEntries(tr.map((e) => [e.sessionId, e.batch.kind === "append" ? e.batch.events.length : -1]));
  assert.deepEqual(counts, { "local_syn-a": 1, "local_syn-b": 2 });
});

test("§12.2 stale running files never make a session busy", async () => {
  const { p, make } = harness({ probe: fakeProbe({ 201: START + 60_000, 203: START }) });
  writeRecord(p, { sessionId: "local_syn-dead", cliSessionId: "cli-dead", cwd: "/syn/d", lastActivityAt: T0 });
  writeRecord(p, { sessionId: "local_syn-reused", cliSessionId: "cli-reused", cwd: "/syn/r", lastActivityAt: T0 });
  writeRecord(p, { sessionId: "local_syn-cli", cliSessionId: "cli-cli", cwd: "/syn/c", lastActivityAt: T0 });
  writeRunning(p, 200, { sessionId: "cli-dead", status: "busy", entrypoint: "claude-desktop", procStart: START });
  writeRunning(p, 201, { sessionId: "cli-reused", status: "busy", entrypoint: "claude-desktop", procStart: START });
  writeRunning(p, 203, { sessionId: "cli-cli", status: "busy", entrypoint: "cli", procStart: START });
  const b = make();
  await b.refresh();
  assert.deepEqual(b.snapshot().sessions.map((s) => s.status), ["recent", "recent", "recent"]);
});

test("§12.2 pinned session ignores focus and shows the focus-moved chip", async () => {
  const { p, make } = harness();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 - 5 });
  writeRecord(p, { sessionId: "local_syn-b", cliSessionId: "cli-b", cwd: "/syn/b", lastFocusedAt: T0 - 9 });
  const b = make();
  await b.refresh();
  b.pin("local_syn-b");
  writeRecord(p, { sessionId: "local_syn-c", cliSessionId: "cli-c", cwd: "/syn/c", lastFocusedAt: T0 });
  await b.tick();
  const sel = b.snapshot().selection;
  assert.equal(sel.sessionId, "local_syn-b");
  assert.equal(sel.via, "pin");
  assert.equal(sel.focusMovedTo, "local_syn-c");
  b.pin(null);
  await b.idle();
  assert.equal(b.snapshot().selection.sessionId, "local_syn-c");
});

test("a restored pin shows no chip until focus moves after start", async () => {
  const { p, make } = harness({ initialPin: "local_syn-b" });
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 - 5 });
  writeRecord(p, { sessionId: "local_syn-b", cliSessionId: "cli-b", cwd: "/syn/b", lastFocusedAt: T0 - 9 });
  const b = make();
  await b.refresh();
  assert.equal(b.snapshot().selection.focusMovedTo, null);
  writeRecord(p, { sessionId: "local_syn-c", cliSessionId: "cli-c", cwd: "/syn/c", lastFocusedAt: T0 });
  await b.tick();
  assert.equal(b.snapshot().selection.focusMovedTo, "local_syn-c");
});

test("snapshot() returns a copy", async () => {
  const { p, make } = harness();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 });
  const b = make();
  const snap = await b.refresh();
  snap.sessions[0].title = "changed";
  assert.notEqual(b.snapshot().sessions[0].title, "changed");
});

test("§12.2 record whose transcript is missing: flagged, and resolution uses the record cwd", async () => {
  const { p, make, take } = harness();
  const { main } = repoWithWorktree();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: main, lastFocusedAt: T0 });
  const b = make();
  await b.refresh();
  const s = b.snapshot().sessions[0];
  assert.equal(s.transcriptMissing, "not_found");
  assert.equal(s.resolvedRoot, main);
  const wt = ofType(take(), "worktree")[0];
  assert.ok(wt.resolution.kind === "resolved" && wt.resolution.candidateSource === "desktop_record" && wt.resolution.root === main);
});

test("§12.2 cliSessionId change mid-session: same desktop session, new file, reset 'session_id_changed'", async () => {
  const { p, make, take } = harness();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-1", cwd: "/syn/a", lastFocusedAt: T0 });
  writeTranscript(transcriptPath(p, "/syn/a", "cli-1"), "cli-1", [userLine("cli-1", "/syn/a", "old")]);
  writeTranscript(transcriptPath(p, "/syn/a", "cli-2"), "cli-2", [userLine("cli-2", "/syn/a", "new 1"), userLine("cli-2", "/syn/a", "new 2")]);
  const b = make();
  await b.refresh();
  take();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-2", cwd: "/syn/a", lastFocusedAt: T0 });
  await b.tick();
  const [e] = ofType(take(), "transcript");
  assert.equal(e.sessionId, "local_syn-a");
  assert.equal(e.cliSessionId, "cli-2");
  assert.ok(e.batch.kind === "reset" && e.batch.cause === "session_id_changed" && e.batch.events.length === 2);
});

test("a new cliSessionId whose file appears later is still 'session_id_changed'", async () => {
  const { p, make, take } = harness();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-1", cwd: "/syn/a", lastFocusedAt: T0 });
  writeTranscript(transcriptPath(p, "/syn/a", "cli-1"), "cli-1", [userLine("cli-1", "/syn/a", "old")]);
  const b = make();
  await b.refresh();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-2", cwd: "/syn/a", lastFocusedAt: T0 });
  await b.tick();
  take();
  writeTranscript(transcriptPath(p, "/syn/a", "cli-2"), "cli-2", [userLine("cli-2", "/syn/a", "late")]);
  await b.tick();
  const [e] = ofType(take(), "transcript");
  assert.ok(e.batch.kind === "reset" && e.batch.cause === "session_id_changed");
});

test("§12.2 worktree switch mid-session and move into an unapproved repo are never silent", async () => {
  const a = repoWithWorktree();
  const other = repoWithWorktree();
  const { p, make, take } = harness({ isApproved: (root) => root !== other.main });
  const f = transcriptPath(p, a.main, "cli-a");
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: a.main, lastFocusedAt: T0 });
  writeTranscript(f, "cli-a", [userLine("cli-a", a.main, "start")]);
  const b = make();
  await b.refresh();
  assert.equal(ofType(take(), "worktree")[0].change, null);
  appendLines(f, [userLine("cli-a", a.worktree, "switched")]);
  await b.tick();
  const w1 = ofType(take(), "worktree");
  assert.equal(w1.length, 1);
  assert.equal(w1[0].change?.banner, `Claude is now in ${a.worktree} (feature-a)`);
  assert.equal(await b.liveBranch("local_syn-a"), "feature-a");
  appendLines(f, [userLine("cli-a", other.main, "moved")]);
  await b.tick();
  const [w2] = ofType(take(), "worktree");
  assert.ok(w2.resolution.kind === "unavailable" && w2.resolution.reason === "not_approved");
  assert.equal(w2.change?.contextNote, `Repository changed from ${a.worktree} to ${other.main}`);
  assert.equal(b.worktree("local_syn-a")?.kind, "unavailable");
  assert.equal(await b.liveBranch("local_syn-a"), null);
});

test("§12.2 desktop/transcript cwd disagreement: the transcript's cwd is the candidate", async () => {
  const a = repoWithWorktree();
  const { p, make } = harness();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: a.main, lastFocusedAt: T0 });
  writeTranscript(transcriptPath(p, a.main, "cli-a"), "cli-a", [userLine("cli-a", a.worktree, "here")]);
  const b = make();
  await b.refresh();
  const r = b.worktree("local_syn-a");
  assert.ok(r?.kind === "resolved" && r.root === a.worktree && r.candidateSource === "transcript");
});

test("approval later: resolveNow re-runs resolution", async () => {
  const a = repoWithWorktree();
  let approved = false;
  const { p, make } = harness({ isApproved: () => approved });
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: a.main, lastFocusedAt: T0 });
  const b = make();
  await b.refresh();
  assert.equal(b.worktree("local_syn-a")?.kind, "unavailable");
  approved = true;
  assert.equal((await b.resolveNow("local_syn-a"))?.kind, "resolved");
  assert.equal(b.snapshot().sessions[0].resolvedRoot, a.main);
});

test("§12.2 refresh after watcher failure re-scans and re-creates only that watcher", async () => {
  const { created, watch } = fakeWatch();
  const { p, make, take } = harness({ watch, pollIntervalMs: 60_000, rewatchDelayMs: 0 });
  const b = make();
  b.start();
  await b.idle();
  assert.equal(created.length, 3);
  writeRecord(p, { sessionId: "local_syn-new", cliSessionId: "cli-new", cwd: "/syn/n", lastFocusedAt: T0 });
  created[0].onError(new Error("synthetic watcher failure"));
  created[0].onError(new Error("a second error from the closed watcher is ignored"));
  await b.idle();
  await sleep(10);
  const errors = ofType(take(), "sync_error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message.includes(p.root), false);
  assert.deepEqual(b.snapshot().sessions.map((s) => s.sessionId), ["local_syn-new"]);
  assert.ok(created[0].closed && !created[1].closed);
  assert.equal(created.length, 4);
  assert.equal(created[3].dir, created[0].dir);
  b.stop();
});

test("a missing watched folder (ENOENT) re-arms with backoff and does not rescan", async () => {
  const { created, watch } = fakeWatch();
  const { p, make, take } = harness({ watch, pollIntervalMs: 60_000, rewatchDelayMs: 5 });
  const b = make();
  b.start();
  await b.idle();
  writeRecord(p, { sessionId: "local_syn-new", cliSessionId: "cli-new", cwd: "/syn/n", lastFocusedAt: T0 });
  const enoent = Object.assign(new Error("synthetic"), { code: "ENOENT" });
  created[1].onError(enoent);
  await b.idle();
  assert.deepEqual(b.snapshot().sessions, []);
  await sleep(20);
  assert.equal(created.length, 4);
  created[3].onError(enoent);
  await sleep(6);
  assert.equal(created.length, 4, "second re-arm waits for the doubled delay");
  await sleep(20);
  assert.equal(created.length, 5);
  assert.ok(ofType(take(), "sync_error").every((e) => e.message === "watcher failed (running files): ENOENT"));
  b.stop();
});

test("ticks coalesce: many hints queue at most one extra pass", async () => {
  const { p, make } = harness();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 });
  let reads = 0;
  const counting: ReadFs = { ...nodeReadFs, readdir: (d) => (d === p.desktopSessionsDir && reads++, nodeReadFs.readdir(d)) };
  const b = make({ fs: counting });
  await Promise.all([b.tick(), b.tick(), b.tick(), b.tick()]);
  assert.equal(reads, 1);
});

test("a transcript deleted between stat and read is reported missing, not a crash", async () => {
  const { p, make, take } = harness();
  const f = transcriptPath(p, "/syn/a", "cli-a");
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 });
  writeTranscript(f, "cli-a", [userLine("cli-a", "/syn/a", "one")]);
  let gone = false;
  const racy: ReadFs = {
    ...nodeReadFs,
    readRange: async (x, pos, len) => {
      if (gone && x === f) throw Object.assign(new Error("synthetic"), { code: "ENOENT" });
      return nodeReadFs.readRange(x, pos, len);
    },
  };
  const b = make({ fs: racy });
  await b.refresh();
  take();
  appendLines(f, [userLine("cli-a", "/syn/a", "two")]);
  gone = true;
  await b.tick();
  const ev = take();
  assert.deepEqual(ofType(ev, "transcript").map((e) => e.batch.kind), ["missing"]);
  assert.deepEqual(ofType(ev, "sync_error"), []);
  assert.equal(b.syncStatus("local_syn-a").state, "missing");
});

test("a failing pass started in the background becomes sync_error, never an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (r: unknown) => unhandled.push(r);
  process.on("unhandledRejection", onUnhandled);
  try {
    const throwing: ProcessProbe = {
      isAlive: () => {
        throw new Error("synthetic probe failure in /syn/secret/path");
      },
      startTimeMs: async () => null,
    };
    const { p, make, take } = harness({ probe: throwing, watch: null });
    writeRunning(p, 401, { sessionId: "cli-a", status: "busy", entrypoint: "claude-desktop", procStart: START });
    const b = make();
    b.start();
    await b.idle();
    await sleep(10);
    b.stop();
    const errors = ofType(take(), "sync_error");
    assert.deepEqual(errors.map((e) => e.message), ["bridge pass failed: Error"]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a pinned session that vanishes stays pinned but is no longer tailed", async () => {
  const { p, make } = harness();
  const rec = writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 });
  writeTranscript(transcriptPath(p, "/syn/a", "cli-a"), "cli-a", [userLine("cli-a", "/syn/a", "one")]);
  const b = make();
  await b.refresh();
  b.pin("local_syn-a");
  await b.idle();
  assert.equal(b.syncStatus("local_syn-a").state, "live");
  fs.rmSync(rec);
  await b.tick();
  assert.equal(b.snapshot().selection.pinnedMissing, true);
  assert.equal(b.syncStatus("local_syn-a").state, "not_tracked");
  assert.deepEqual(b.events("local_syn-a"), []);
});

test("desktop records unreadable: error shown and transcripts still listed", async () => {
  const { p, make } = harness();
  fs.rmSync(p.desktopSessionsDir, { recursive: true });
  writeTranscript(transcriptPath(p, "/syn/a", "cli-only"), "cli-only", [userLine("cli-only", "/syn/a", "x")]);
  const b = make();
  const snap = await b.refresh();
  assert.equal(snap.desktopRecordsError, DESKTOP_NOT_FOUND);
  assert.deepEqual(snap.sessions.map((s) => [s.sessionId, s.source]), [["transcript:cli-only", "transcript_only"]]);
});

test("§12.2 malformed lines and subagent files flow through the bridge", async () => {
  const { p, make, take } = harness();
  const f = transcriptPath(p, "/syn/a", "cli-a");
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 });
  const okLine = userLine("cli-a", "/syn/a", "ok");
  writeTranscript(f, "cli-a", ["{broken", okLine]);
  const sub = path.join(path.dirname(f), "cli-a", "subagents", "agent-syn.jsonl");
  writeTranscript(sub, "cli-a", [assistantLine("cli-a", "/syn/a", [{ type: "text", text: `${MARK} sub done` }])]);
  const b = make();
  await b.refresh();
  const ev = take();
  assert.equal(ofType(ev, "transcript")[0].stats.malformedLines, 1);
  assert.equal(b.syncStatus("local_syn-a").stats?.malformedLines, 1);
  assert.deepEqual(ofType(ev, "subagent").map((e) => e.update.summary), [`${MARK} sub done`]);
  assert.equal(b.hasUuid("local_syn-a", JSON.parse(okLine).uuid), true);
  assert.equal(b.hasUuid("local_syn-a", "u-unknown"), false);
});

test("the bridge never opens a .key file and touches only the Claude dirs and the repo", async () => {
  const a = repoWithWorktree();
  const touched: string[] = [];
  const refused: string[] = [];
  const spy: ReadFs = {
    readdir: (d) => (touched.push(d), nodeReadFs.readdir(d)),
    stat: (x) => (touched.push(x), nodeReadFs.stat(x)),
    readRange: (x, pos, len) => (touched.push(x), nodeReadFs.readRange(x, pos, len)),
    realpath: (x) => (touched.push(x), nodeReadFs.realpath(x)),
  };
  const { p, make } = harness({ fs: spy, probe: fakeProbe({ 301: START }), onRefusedPath: (b) => refused.push(b) });
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: a.main, lastFocusedAt: T0 });
  writeTranscript(transcriptPath(p, a.main, "cli-a"), "cli-a", [userLine("cli-a", a.main, "x")]);
  writeRunning(p, 301, { sessionId: "cli-a", status: "busy", entrypoint: "claude-desktop", procStart: START, messagingSocketPath: path.join(p.runningDir, "sock") });
  fs.writeFileSync(path.join(p.runningDir, "301.key"), MARK);
  const b = make();
  await b.refresh();
  await b.tick();
  assert.deepEqual(refused, []);
  assert.ok(touched.length > 0);
  for (const t of touched) {
    assert.ok(!t.endsWith(".key") && !t.endsWith("sock"), t);
    assert.ok(t.startsWith(p.root) || t.startsWith(a.main), t);
  }
});
```

- [ ] **Step 2: Run it**

Run: `cd companiond && node --test test/bridge/sessionBridge.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/bridge/sessionBridge.ts`.

- [ ] **Step 3: Implement** — `companiond/src/bridge/sessionBridge.ts`:

```ts
import type { ClaudePaths } from "../claude/paths.ts";
import type { ReadFs } from "../claude/readFs.ts";
import { guardReadFs, nodeReadFs } from "../claude/readFs.ts";
import type { DesktopRecord } from "../claude/desktopRecords.ts";
import { readDesktopRecords } from "../claude/desktopRecords.ts";
import type { ProcessProbe } from "../claude/runningFiles.ts";
import { cacheStartTimes, liveStates, readRunningFiles } from "../claude/runningFiles.ts";
import { nodeProcessProbe } from "../claude/processProbe.ts";
import type { TranscriptLocation } from "../claude/transcriptLocator.ts";
import { locateTranscript } from "../claude/transcriptLocator.ts";
import type { TranscriptEvent } from "../transcript/parser.ts";
import type { SyncStats, TranscriptBatch } from "../transcript/reader.ts";
import { TranscriptReader } from "../transcript/reader.ts";
import type { SubagentUpdate } from "../transcript/subagents.ts";
import { SubagentTails } from "../transcript/subagents.ts";
import type { IsApproved, RepoChange, WorktreeResolution } from "../worktree/resolver.ts";
import { describeChange, resolveWorktree } from "../worktree/resolver.ts";
import { SafeGit } from "../git/safeGit.ts";
import type { Pin, Selection, SessionSummary } from "./selection.ts";
import { computeStatus, focusedSessionId, select } from "./selection.ts";
import { listTranscripts } from "./transcriptOnly.ts";
import type { WatchFactory, WatchHandle } from "./watcher.ts";
import { nodeWatchFactory } from "./watcher.ts";

export interface SessionsSnapshot {
  sessions: SessionSummary[];
  selection: Selection;
  /** "Claude Desktop sessions not found" when records are unreadable; sessions then come from transcripts. */
  desktopRecordsError: string | null;
  refreshedAt: number;
}

export type BridgeEvent =
  | { type: "sessions"; snapshot: SessionsSnapshot }
  | { type: "transcript"; sessionId: string; cliSessionId: string; batch: TranscriptBatch; stats: SyncStats }
  | { type: "subagent"; sessionId: string; update: SubagentUpdate }
  | { type: "worktree"; sessionId: string; resolution: WorktreeResolution; change: RepoChange | null }
  /** Never contains a path: a label and an error code only. */
  | { type: "sync_error"; message: string };

export type BridgeListener = (e: BridgeEvent) => void;

export interface SyncStatus {
  state: "live" | "missing" | "not_tracked";
  stats: SyncStats | null;
  lastPollAt: number | null;
}

export interface SessionBridgeOptions {
  paths: ClaudePaths;
  isApproved: IsApproved;
  /** Absolute git for SafeGit. M4 passes discoverToolchain().gitPath (M2); tests pass testGitPath(). */
  gitPath: string;
  fs?: ReadFs;
  probe?: ProcessProbe;
  now?: () => number;
  /** Stat fallback interval (spec §3: 2 s). */
  pollIntervalMs?: number;
  /** null disables watching (tests drive tick() directly). */
  watch?: WatchFactory | null;
  /** First delay before a failed watcher is re-created; doubles up to 60 s. Default: pollIntervalMs. */
  rewatchDelayMs?: number;
  /** Pin restored by M4's Store. */
  initialPin?: string | null;
  /** Called with the basename whenever the guard refuses a `.key` path. Should never fire. */
  onRefusedPath?: (basename: string) => void;
  /** Readers kept for sessions that stopped being tailed, so switching back does not re-read from 0. */
  parkedReaders?: number;
}

interface Tracked {
  cliSessionId: string;
  reader: TranscriptReader;
  subagents: SubagentTails;
  missing: boolean;
  lastPollAt: number | null;
}

interface WorktreeState {
  resolution: WorktreeResolution;
  candidate: string | null;
}

interface WatchSlot {
  label: string;
  dir: string;
  onChange: () => void;
  handle: WatchHandle | null;
  gen: number;
  delay: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const errCode = (err: unknown): string =>
  typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : ((err as Error)?.name ?? "Error");

/**
 * Owns discovery, status, focus/pin, the tails of the selected and busy sessions, and their worktree
 * resolution. Read-only on all Claude data; the only place that wraps ReadFs in guardReadFs. Operations run
 * one at a time on a queue; at most one tick waits in it.
 */
export class SessionBridge {
  readonly #paths: ClaudePaths;
  readonly #fs: ReadFs;
  readonly #probe: ProcessProbe;
  readonly #gitPath: string;
  readonly #isApproved: IsApproved;
  readonly #now: () => number;
  readonly #interval: number;
  readonly #watch: WatchFactory | null;
  readonly #rewatchDelay: number;
  readonly #parkedMax: number;
  readonly #listeners = new Set<BridgeListener>();
  #queue: Promise<void> = Promise.resolve();
  #pendingTick: Promise<void> | null = null;
  #pendingTailPoll: Promise<void> | null = null;
  #sessions: SessionSummary[] = [];
  #records = new Map<string, DesktopRecord>();
  #locations = new Map<string, { cli: string; loc: TranscriptLocation }>();
  #tracked = new Map<string, Tracked>();
  #parked = new Map<string, Tracked>();
  /** Last cliSessionId a reader was made for, per session; survives untracking. */
  #lastCli = new Map<string, string>();
  #worktrees = new Map<string, WorktreeState>();
  #pin: Pin | null = null;
  #pinRestored = false;
  #desktopError: string | null = null;
  #lastSnapshot = "";
  #refreshedAt = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #hintTimer: ReturnType<typeof setTimeout> | null = null;
  #watchSlots: WatchSlot[] = [];

  constructor(opts: SessionBridgeOptions) {
    this.#paths = opts.paths;
    this.#fs = guardReadFs(opts.fs ?? nodeReadFs, opts.onRefusedPath);
    this.#probe = cacheStartTimes(opts.probe ?? nodeProcessProbe);
    this.#gitPath = opts.gitPath;
    this.#isApproved = opts.isApproved;
    this.#now = opts.now ?? Date.now;
    this.#interval = opts.pollIntervalMs ?? 2000;
    this.#watch = opts.watch === undefined ? nodeWatchFactory : opts.watch;
    this.#rewatchDelay = opts.rewatchDelayMs ?? this.#interval;
    this.#parkedMax = opts.parkedReaders ?? 8;
    if (opts.initialPin) {
      this.#pin = { sessionId: opts.initialPin, focusAtPin: null };
      this.#pinRestored = true;
    }
  }

  on(listener: BridgeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Full rescan (refresh button, ⌘R, wake, watcher error): forgets cached transcript locations. */
  refresh(): Promise<SessionsSnapshot> {
    return this.#enqueue(async () => {
      this.#locations.clear();
      await this.#scan(true);
    }).then(() => this.snapshot());
  }

  /** Incremental pass: re-read records and running files, poll the active tails. Coalesced. */
  tick(): Promise<void> {
    if (this.#pendingTick) return this.#pendingTick;
    const p = this.#enqueue(async () => {
      this.#pendingTick = null;
      await this.#scan(false);
    });
    this.#pendingTick = p;
    return p;
  }

  /** Resolves when every queued operation has finished. */
  idle(): Promise<void> {
    return this.#enqueue(async () => {});
  }

  /** Pin a session (also what the manual picker does); null unpins and focus takes over again. */
  pin(sessionId: string | null): Selection {
    this.#pin = sessionId === null ? null : { sessionId, focusAtPin: focusedSessionId(this.#sessions) };
    this.#pinRestored = false;
    this.#emitSnapshot();
    this.#background(this.tick());
    return this.snapshot().selection;
  }

  /** A copy; callers may keep or change it. */
  snapshot(): SessionsSnapshot {
    return structuredClone({
      sessions: this.#sessions,
      selection: select(this.#sessions, this.#pin),
      desktopRecordsError: this.#desktopError,
      refreshedAt: this.#refreshedAt,
    });
  }

  /** The current event window of a tailed session (newest TranscriptReader window), or [] if not tailed. */
  events(sessionId: string): readonly TranscriptEvent[] {
    return this.#tracked.get(sessionId)?.reader.events ?? [];
  }

  /** True if the session's transcript (since its last reset) contains a record with this uuid. */
  hasUuid(sessionId: string, uuid: string): boolean {
    return this.#tracked.get(sessionId)?.reader.hasUuid(uuid) ?? false;
  }

  worktree(sessionId: string): WorktreeResolution | null {
    return this.#worktrees.get(sessionId)?.resolution ?? null;
  }

  /** Live branch of the session's resolved root, read now through SafeGit (spec §6.3: read at each turn). */
  async liveBranch(sessionId: string): Promise<string | null> {
    const r = this.worktree(sessionId);
    if (r?.kind !== "resolved") return null;
    try {
      return await (await SafeGit.open({ root: r.root, gitPath: this.#gitPath })).branch();
    } catch {
      return null;
    }
  }

  /** Re-run resolution now, e.g. after the user approves a root (M4). */
  resolveNow(sessionId: string): Promise<WorktreeResolution | null> {
    return this.#enqueue(async () => {
      await this.#resolve(sessionId, true);
      this.#emitSnapshot();
    }).then(() => this.worktree(sessionId));
  }

  syncStatus(sessionId: string): SyncStatus {
    const t = this.#tracked.get(sessionId);
    if (!t) return { state: "not_tracked", stats: null, lastPollAt: null };
    return { state: t.missing ? "missing" : "live", stats: t.reader.stats, lastPollAt: t.lastPollAt };
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#background(this.tick()), this.#interval);
    this.#timer.unref?.();
    this.#startWatchers();
    this.#background(this.refresh());
  }

  /**
   * Fire-and-forget calls go through here. A failed pass was already reported as sync_error by #enqueue;
   * this only stops the rejection from becoming an unhandled rejection that would end the daemon.
   */
  #background(p: Promise<unknown>): void {
    p.catch(() => {});
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#hintTimer) clearTimeout(this.#hintTimer);
    this.#hintTimer = null;
    for (const s of this.#watchSlots) {
      s.gen++;
      if (s.timer) clearTimeout(s.timer);
      s.handle?.close();
    }
    this.#watchSlots = [];
  }

  // ---- watching: hints only ----

  #startWatchers(): void {
    if (!this.#watch) return;
    const tickSoon = () => {
      if (this.#hintTimer) return;
      this.#hintTimer = setTimeout(() => {
        this.#hintTimer = null;
        this.#background(this.tick());
      }, 100);
      this.#hintTimer.unref?.();
    };
    const tailsSoon = () => this.#background(this.#pollTails());
    this.#watchSlots = [
      { label: "desktop records", dir: this.#paths.desktopSessionsDir, onChange: tickSoon },
      { label: "running files", dir: this.#paths.runningDir, onChange: tickSoon },
      { label: "transcripts", dir: this.#paths.projectsDir, onChange: tailsSoon },
    ].map((s) => ({ ...s, handle: null, gen: 0, delay: this.#rewatchDelay, timer: null }));
    for (const s of this.#watchSlots) this.#arm(s);
  }

  #arm(slot: WatchSlot): void {
    if (!this.#watch || !this.#timer) return;
    const gen = ++slot.gen;
    slot.handle = this.#watch(
      slot.dir,
      () => {
        if (gen !== slot.gen) return;
        slot.delay = this.#rewatchDelay;
        slot.onChange();
      },
      (err) => {
        if (gen === slot.gen) this.#onWatchError(slot, err);
      },
    );
  }

  #onWatchError(slot: WatchSlot, err: Error): void {
    slot.gen++;
    slot.handle?.close();
    slot.handle = null;
    const code = errCode(err);
    this.#emit({ type: "sync_error", message: `watcher failed (${slot.label}): ${code}` });
    // A missing folder is normal (Claude not installed yet): keep polling, no full rescan.
    if (code !== "ENOENT") this.#background(this.refresh());
    if (slot.timer || !this.#timer) return;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      this.#arm(slot);
    }, slot.delay);
    slot.timer.unref?.();
    slot.delay = Math.min(slot.delay * 2, 60_000);
  }

  // ---- queue ----

  #enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(op);
    this.#queue = run.catch((err: unknown) => this.#emit({ type: "sync_error", message: `bridge pass failed: ${errCode(err)}` }));
    return run;
  }

  #pollTails(): Promise<void> {
    if (this.#pendingTailPoll) return this.#pendingTailPoll;
    const p = this.#enqueue(async () => {
      this.#pendingTailPoll = null;
      for (const s of this.#sessions) if (this.#tracked.has(s.sessionId)) await this.#pollSession(s, false);
      this.#emitSnapshot();
    });
    this.#pendingTailPoll = p;
    return p;
  }

  #emit(e: BridgeEvent): void {
    for (const l of this.#listeners) l(e);
  }

  #emitSnapshot(): void {
    const snap = this.snapshot();
    const key = JSON.stringify({ s: snap.sessions, sel: snap.selection, e: snap.desktopRecordsError });
    if (key === this.#lastSnapshot) return;
    this.#lastSnapshot = key;
    this.#emit({ type: "sessions", snapshot: snap });
  }

  // ---- scan ----

  async #scan(full: boolean): Promise<void> {
    const now = this.#now();
    const live = await liveStates(await readRunningFiles(this.#fs, this.#paths.runningDir), this.#probe);
    const res = await readDesktopRecords(this.#fs, this.#paths.desktopSessionsDir);
    this.#desktopError = res.error;
    const sessions: SessionSummary[] = [];
    this.#records.clear();
    if (res.error === null) {
      for (const r of res.records) {
        this.#records.set(r.sessionId, r);
        const loc = await this.#location(r, full);
        sessions.push({
          sessionId: r.sessionId,
          cliSessionId: r.cliSessionId,
          title: r.title,
          status: computeStatus(r.cliSessionId ? (live.get(r.cliSessionId) ?? null) : null, r.lastActivityAt, now),
          isArchived: r.isArchived,
          lastFocusedAt: r.lastFocusedAt,
          lastActivityAt: r.lastActivityAt,
          recordCwd: r.cwd,
          recordBranch: r.branch,
          resolvedRoot: null,
          source: "desktop",
          transcriptPath: loc.kind === "found" ? loc.path : null,
          transcriptMissing: loc.kind === "missing" ? loc.reason : null,
        });
      }
    } else {
      for (const t of await listTranscripts(this.#fs, this.#paths.projectsDir)) {
        sessions.push({
          sessionId: `transcript:${t.cliSessionId}`,
          cliSessionId: t.cliSessionId,
          title: `Transcript ${t.cliSessionId.slice(0, 8)}`,
          status: computeStatus(live.get(t.cliSessionId) ?? null, t.mtimeMs, now),
          isArchived: false,
          lastFocusedAt: null,
          lastActivityAt: t.mtimeMs,
          recordCwd: null,
          recordBranch: null,
          resolvedRoot: null,
          source: "transcript_only",
          transcriptPath: t.path,
          transcriptMissing: null,
        });
      }
    }
    sessions.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
    this.#sessions = sessions;
    this.#refreshedAt = now;
    if (this.#pin && this.#pinRestored) {
      // A restored pin starts from the current focus, so the chip shows only a later move.
      this.#pin = { sessionId: this.#pin.sessionId, focusAtPin: focusedSessionId(sessions) };
      this.#pinRestored = false;
    }

    const selected = select(sessions, this.#pin).sessionId;
    const active = new Set(sessions.filter((s) => s.status === "busy").map((s) => s.sessionId));
    const listed = new Set(sessions.map((s) => s.sessionId));
    // A pinned session that vanished stays pinned (pinnedMissing) but is not tailed.
    if (selected && listed.has(selected)) active.add(selected);
    for (const [id, t] of [...this.#tracked]) {
      if (active.has(id)) continue;
      this.#tracked.delete(id);
      if (listed.has(id)) this.#park(id, t);
    }
    // Sessions that left the list take their parked reader (and its subagent tails), cliSessionId memory,
    // cached location and worktree state with them.
    for (const id of [...this.#parked.keys()]) if (!listed.has(id)) this.#parked.delete(id);
    for (const id of [...this.#lastCli.keys()]) if (!listed.has(id)) this.#lastCli.delete(id);
    for (const id of [...this.#locations.keys()]) if (!listed.has(id)) this.#locations.delete(id);
    for (const id of [...this.#worktrees.keys()]) if (!active.has(id)) this.#worktrees.delete(id);
    for (const s of sessions) if (active.has(s.sessionId)) await this.#pollSession(s, full);
    this.#emitSnapshot();
  }

  #park(id: string, t: Tracked): void {
    this.#parked.delete(id);
    this.#parked.set(id, t);
    while (this.#parked.size > this.#parkedMax) {
      const oldest = this.#parked.keys().next().value;
      if (oldest === undefined) break;
      this.#parked.delete(oldest);
    }
  }

  async #location(r: DesktopRecord, force: boolean): Promise<TranscriptLocation> {
    const cached = this.#locations.get(r.sessionId);
    if (!force && cached && cached.cli === (r.cliSessionId ?? "")) return cached.loc;
    const loc = await locateTranscript(this.#fs, this.#paths.projectsDir, r.cwd, r.cliSessionId);
    this.#locations.set(r.sessionId, { cli: r.cliSessionId ?? "", loc });
    return loc;
  }

  async #pollSession(s: SessionSummary, full: boolean): Promise<void> {
    const rec = this.#records.get(s.sessionId);
    if (rec && s.transcriptPath === null && !full) {
      // Active session without a transcript yet: look again every pass (inactive ones wait for refresh).
      const loc = await this.#location(rec, true);
      if (loc.kind === "found") {
        s.transcriptPath = loc.path;
        s.transcriptMissing = null;
      }
    }
    let t = this.#tracked.get(s.sessionId);
    if (s.cliSessionId && s.transcriptPath) {
      if (!t || t.cliSessionId !== s.cliSessionId || t.reader.path !== s.transcriptPath) {
        const parked = this.#parked.get(s.sessionId);
        this.#parked.delete(s.sessionId);
        if (parked && parked.cliSessionId === s.cliSessionId && parked.reader.path === s.transcriptPath) {
          t = parked;
        } else {
          t = {
            cliSessionId: s.cliSessionId,
            reader: new TranscriptReader(s.transcriptPath, this.#fs),
            subagents: new SubagentTails(s.transcriptPath, this.#fs),
            missing: false,
            lastPollAt: null,
          };
        }
        this.#tracked.set(s.sessionId, t);
      }
      const prevCli = this.#lastCli.get(s.sessionId);
      this.#lastCli.set(s.sessionId, t.cliSessionId);
      let batch = await t.reader.poll();
      t.lastPollAt = this.#now();
      if (batch?.kind === "reset" && batch.cause === "initial" && prevCli !== undefined && prevCli !== t.cliSessionId) {
        batch = { ...batch, cause: "session_id_changed" };
      }
      if (batch) {
        t.missing = batch.kind === "missing";
        this.#emit({ type: "transcript", sessionId: s.sessionId, cliSessionId: t.cliSessionId, batch, stats: t.reader.stats });
      }
      for (const update of await t.subagents.poll()) this.#emit({ type: "subagent", sessionId: s.sessionId, update });
    } else if (t) {
      this.#tracked.delete(s.sessionId);
    }
    await this.#resolve(s.sessionId, full);
    const r = this.#worktrees.get(s.sessionId)?.resolution;
    s.resolvedRoot = r?.kind === "resolved" ? r.root : null;
  }

  async #resolve(sessionId: string, force: boolean): Promise<void> {
    const t = this.#tracked.get(sessionId);
    const recordCwd = this.#records.get(sessionId)?.cwd ?? null;
    const transcriptCwd = t?.reader.latestCwd ?? null;
    const candidate = transcriptCwd ?? recordCwd;
    const prev = this.#worktrees.get(sessionId) ?? null;
    if (!force && prev && prev.candidate === candidate) return;
    const resolution = await resolveWorktree({ transcriptCwd, recordCwd }, { fs: this.#fs, gitPath: this.#gitPath, isApproved: this.#isApproved });
    this.#worktrees.set(sessionId, { resolution, candidate });
    const s = this.#sessions.find((x) => x.sessionId === sessionId);
    if (s) s.resolvedRoot = resolution.kind === "resolved" ? resolution.root : null;
    if (prev && JSON.stringify(prev.resolution) === JSON.stringify(resolution)) return;
    this.#emit({ type: "worktree", sessionId, resolution, change: describeChange(prev?.resolution ?? null, resolution) });
  }
}
```

- [ ] **Step 4: Run the M3 suites three times, the full suite once, and type-check**

Run:

```bash
cd companiond
for i in 1 2 3; do node --test "test/claude/*.test.ts" "test/transcript/*.test.ts" "test/worktree/*.test.ts" "test/bridge/*.test.ts" test/lineBuffer.test.ts test/jail/stdioFraming.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)"; done
npm test && npm run typecheck
```

Expected: each M3 run shows `fail 0` and a `pass` count equal to its `tests` count; the full `npm test` passes (M2's suites included); `tsc` prints nothing. Three runs catch order or timing flakes.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/bridge/sessionBridge.ts companiond/test/bridge/sessionBridge.test.ts
git commit -m "feat(companiond): session bridge with polling, focus, pin and worktree events" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: Roadmap, final checks, PR

**Files:**
- Modify: `docs/superpowers/plans/README.md` (M3 row)

**Interfaces:**
- Consumes: Tasks 1–15.
- Produces: the M3 PR.

This plan file itself is already on `main` (committed by the plans PR); do not add or change it here.

- [ ] **Step 1: Update the roadmap row** — if the M3 row in `docs/superpowers/plans/README.md` does not already link this plan, replace it with the row below; if it already does, skip this step and the README commit in Step 3.

```markdown
| M3 | [Session bridge, tail, parser, worktree resolver](2026-11-04-m3-session-bridge.md) | written |
```

- [ ] **Step 2: Full checks**

Run: `cd companiond && npm test && npm run typecheck && cd .. && bash scripts/check-repo.sh && git status --porcelain && git ls-files | grep -E '\.jsonl$'`
Expected: the full `npm test` passes; `check-repo: OK`; `git status --porcelain` shows at most ` M docs/superpowers/plans/README.md` (nothing if Step 1 was skipped; never the plan file); the last command prints nothing (no `.jsonl` tracked).

- [ ] **Step 3: Commit, push, open the PR**

```bash
git add docs/superpowers/plans/README.md
git commit -m "docs(plans): link the M3 plan from the roadmap" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/m3-session-bridge
gh pr create --base main --title "M3: session bridge, transcript tail, parser, worktree resolver" --body-file - <<'EOF'
Implements spec §14 M3 (plan: docs/superpowers/plans/2026-11-04-m3-session-bridge.md). Builds on M2.

- Read-only discovery of desktop records, running files and transcripts (§6.1), busy/idle with pid + start-time + entrypoint checks, focus / pin / picker (§6.2).
- Transcript tail with partial lines, truncation, replacement and missing files, malformed-line counts (§6.4); typed events incl. Bash failures (§10); rolling event window; subagent summaries.
- Exact worktree resolution with no fallback, through M2's SafeGit (`locate`, `open`, `branch`); the §7.3 config gate runs on every resolution; every move or state change gives a banner and a context note (§6.3).
- Jail framing: M2's stdio server now replies to lines the stricter LineBuffer drops.
- §12.2 session sync suite on synthetic fixtures built in temp dirs; no `.jsonl` committed.
- M3 shape check recorded in the findings doc (owner-run, counts only).

Decisions for review:
- A cwd that is a subfolder of a work tree is Unavailable (`not_worktree_root`), never widened to the top folder.
- Picking a session in the picker pins it.
- Only the selected and busy sessions are tailed; up to 8 parked readers are kept.
- Known limit: an in-place rewrite of a transcript to the same or a larger size is not detected (§6.4 detects shrink and inode change only).
- M3 consumes M2's `SafeGit.locate`, `SafeGit#branch` and `LocateError`; M3 never spawns git.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 4: Verify CI** — `gh pr checks` on the M3 PR.
Expected: the Linux `companiond` job, `companiond-macos` (from M2), `app` and `secrets` pass. If a test fails only on Linux, fix the cause (do not skip the test) and push a `fix(companiond): …` commit.

---

## Self-review

**Spec coverage (§12.2 list → test):**

| §12.2 item | Test |
|---|---|
| Multiple open sessions; focus moving | `sessionBridge.test.ts` "multiple open sessions and focus moving"; `selection.test.ts` |
| Two busy sessions appending at once | `sessionBridge.test.ts` "two busy sessions appending at once…" |
| Pinned session ignoring focus | `sessionBridge.test.ts` and `selection.test.ts` "pinned session…"; "a restored pin…" |
| Lagging `lastFocusedAt` | `selection.test.ts` "lagging lastFocusedAt…" (focus from records only, labelled) |
| Stale running file (dead pid, reused pid, CLI entrypoint) | `runningFiles.test.ts` three tests + cache test; `sessionBridge.test.ts` "stale running files…" |
| Record whose transcript is missing | `transcriptLocator.test.ts`; `sessionBridge.test.ts` "record whose transcript is missing…" |
| Folder-name collision rejected | `transcriptLocator.test.ts` two collision tests |
| `cliSessionId` change mid-session | `sessionBridge.test.ts` "cliSessionId change mid-session…" and "…whose file appears later…" |
| Archived records | `selection.test.ts` "archived records…" |
| Partial line split across writes | `lineBuffer.test.ts`; `tail.test.ts` "partial line…" |
| Truncation and replacement | `tail.test.ts` (truncated, replaced, missing-and-back, swapped at read); `reader.test.ts` "truncation rebuilds…", "missing is sent once…" |
| Malformed lines | `reader.test.ts`; `lineBuffer.test.ts` invalid UTF-8; `sessionBridge.test.ts` "malformed lines and subagent files…" |
| Subagent files | `reader.test.ts` "subagent files…"; `sessionBridge.test.ts` |
| Worktree switch mid-session; move into another repo | `resolver.test.ts`; `sessionBridge.test.ts` "worktree switch… unapproved repo…" |
| Desktop/transcript `cwd` disagreement | `resolver.test.ts`; `sessionBridge.test.ts` |
| Unapproved root → Unavailable, no fallback | `resolver.test.ts` "unapproved root…", "repo_refused…", "subfolder…", "removed .git link…" |
| Refresh after watcher failure | `sessionBridge.test.ts` "refresh after watcher failure…", "missing watched folder (ENOENT)…" |

Other spec points: §6.1 never `*.key` / socket → `readFs.test.ts` (guard + static scan), `runningFiles.test.ts`, `sessionBridge.test.ts` last test (`onRefusedPath` never fires); §6.2 "Claude Desktop sessions not found" + transcripts listed → `desktopRecords.test.ts`, `watcher.test.ts`, `sessionBridge.test.ts`; §6.3 live branch per turn → `bridge.liveBranch`; §7.3 config gate on every resolution → `resolver.test.ts` "repo_refused"; §7.7 no write APIs → `readFs.test.ts` static scan; §10 terminal → Tasks 8–9. Left to M4: cursor storage and the "cursor reset" preview line (M3 gives `reset` batches, `events()` and `hasUuid`), approved-roots storage (M3 takes `IsApproved`), production wiring with `defaultClaudePaths` and `discoverToolchain().gitPath`. Left to M5: wake-from-sleep calls `refresh()`; picker UI; banner UI.

**Placeholder scan:** the only `<…>` are the findings-section blanks in Task 1, filled from the owner's probe output.

**Type consistency:** checked across tasks — `ReadFs.readRange` returns `RangeRead` everywhere (`readJsonFile`, `transcriptHasSessionId`, `TranscriptTail`); `TranscriptBatch.kind` is `append | reset | missing`, and `reset` carries `dropped`; `ResetCause` includes `session_id_changed`, set only by the bridge; `WorktreeResolution.kind` is `resolved | unavailable` with `repo_refused` in the reasons; `Selection.via` is `pin | focus | none`; `SessionSummary.resolvedRoot` is set by the bridge only.

## Interfaces produced for M4/M5

All in `companiond/src/`. M4 wires production with `defaultClaudePaths(os.homedir())`, `discoverToolchain().gitPath` (M2) and its own `IsApproved`; M5 talks to the bridge through M4's stdio codec.

```ts
// bridge/sessionBridge.ts — session list, selection, events
class SessionBridge {
  constructor(opts: SessionBridgeOptions);
  on(listener: (e: BridgeEvent) => void): () => void;   // returns unsubscribe
  start(): void;                                         // watchers + 2 s poll + first refresh
  stop(): void;                                          // clears every timer and watcher
  refresh(): Promise<SessionsSnapshot>;                  // full rescan: refresh button, ⌘R, wake
  tick(): Promise<void>;                                 // one incremental pass; coalesced
  idle(): Promise<void>;                                 // resolves when queued work is done
  pin(sessionId: string | null): Selection;              // picker choice pins; null = follow focus
  snapshot(): SessionsSnapshot;                          // a copy
  events(sessionId: string): readonly TranscriptEvent[]; // current window of a tailed session, else []
  hasUuid(sessionId: string, uuid: string): boolean;     // cursor lookup, covers events that left the window
  worktree(sessionId: string): WorktreeResolution | null;
  liveBranch(sessionId: string): Promise<string | null>; // read now via SafeGit; null unless resolved
  resolveNow(sessionId: string): Promise<WorktreeResolution | null>; // after an approval change
  syncStatus(sessionId: string): SyncStatus;
}
interface SessionBridgeOptions {
  paths: ClaudePaths;            // { desktopSessionsDir, projectsDir, runningDir }
  isApproved: IsApproved;        // (root, gitCommonDir) => boolean — M4 privacy model
  gitPath: string;               // required: discoverToolchain().gitPath (M2)
  fs?: ReadFs; probe?: ProcessProbe; now?: () => number;
  pollIntervalMs?: number;       // default 2000
  watch?: WatchFactory | null;   // default nodeWatchFactory; null = no watching
  rewatchDelayMs?: number;       // default pollIntervalMs; doubles to 60 s per failing watcher
  initialPin?: string | null;    // M4 Store restores the pin
  onRefusedPath?: (basename: string) => void; // .key guard hook; should never fire
  parkedReaders?: number;        // default 8
}
interface SessionsSnapshot {
  sessions: SessionSummary[];
  selection: Selection;
  desktopRecordsError: string | null;   // "Claude Desktop sessions not found"
  refreshedAt: number;
}
type BridgeEvent =
  | { type: "sessions"; snapshot: SessionsSnapshot }                  // only when it changed
  | { type: "transcript"; sessionId: string; cliSessionId: string; batch: TranscriptBatch; stats: SyncStats }
  | { type: "subagent"; sessionId: string; update: SubagentUpdate }
  | { type: "worktree"; sessionId: string; resolution: WorktreeResolution; change: RepoChange | null }
  | { type: "sync_error"; message: string };                          // label + error code, never a path
interface SyncStatus { state: "live" | "missing" | "not_tracked"; stats: SyncStats | null; lastPollAt: number | null }

// bridge/selection.ts
type SessionStatus = "busy" | "idle" | "recent" | "inactive";
interface SessionSummary {
  sessionId: string;                 // desktop sessionId, or "transcript:<cliSessionId>" when records are unreadable
  cliSessionId: string | null;
  title: string;
  status: SessionStatus;
  isArchived: boolean;
  lastFocusedAt: number | null;      // epoch ms
  lastActivityAt: number | null;     // epoch ms
  recordCwd: string | null;
  recordBranch: string | null;       // as Claude's record saw it; live branch via liveBranch()
  resolvedRoot: string | null;       // exact root once resolved (tailed sessions); picker shows it
  source: "desktop" | "transcript_only";
  transcriptPath: string | null;
  transcriptMissing: "invalid_id" | "not_found" | "session_id_mismatch" | null;
}
interface Selection {
  sessionId: string | null;
  via: "pin" | "focus" | "none";
  focusedSessionId: string | null;
  focusLabel: "Claude focus (from Claude's records)";
  focusMovedTo: string | null;       // while pinned: "Claude focus moved to X — switch?"
  pinnedMissing: boolean;
}
function pickerGroups(sessions: readonly SessionSummary[], opts?: { includeArchived?: boolean; query?: string }):
  { busy: SessionSummary[]; idle: SessionSummary[]; recent: SessionSummary[]; older: SessionSummary[] };

// transcript/reader.ts — transcript events for the selected (and busy) sessions
type TranscriptBatch =
  | { kind: "append"; events: TranscriptEvent[] }
  | { kind: "reset"; cause: "initial" | "truncated" | "replaced" | "session_id_changed"; events: TranscriptEvent[]; dropped: number }
  | { kind: "missing" };
// M4 gets a rolling window: the newest 2,000 events or ~8 MiB of text. `reset` carries the whole window;
// `dropped` events came before it and are never resent. Restore the cursor with hasUuid(); an unknown
// uuid → cursor "reset" (spec §6.4). session_id_changed = same desktop sessionId (keep the Codex thread),
// new cliSessionId/file. "replaced" also covers a transcript that came back after being missing.
interface SyncStats { records: number; malformedLines: number; invalidUtf8Lines: number; oversizedLines: number; unknownRecords: number; droppedEvents: number }

// transcript/parser.ts
interface EventBase { uuid: string | null; timestamp: string | null; isSidechain: boolean }
type TranscriptEvent =
  | (EventBase & { kind: "user_text"; text: string })
  | (EventBase & { kind: "assistant_text"; text: string })
  | (EventBase & { kind: "tool_call"; toolUseId: string; name: string; inputPreview: string; command: string | null })
  | (EventBase & { kind: "tool_result"; toolUseId: string; toolName: string | null; command: string | null;
      isError: boolean; stdout: string; stderr: string; exitCode: number | null; interrupted: boolean;
      text: string; failure: TerminalFailure | null })
  | (EventBase & { kind: "file_edit"; toolUseId: string; tool: string; filePath: string })
  | (EventBase & { kind: "subagent_summary"; toolUseId: string; text: string })
  | (EventBase & { kind: "cwd_change"; from: string; to: string });   // main-chain records only
// Texts trimmed to 20,000 chars, tool output to 4,000 (¼ head + ¾ tail). Caps for sending are M4's.

// transcript/terminal.ts
interface TerminalFailure { kind: "test_failure" | "build_failure" | "command_failed"; summary: string }

// transcript/subagents.ts
interface SubagentUpdate { agentId: string; summary: string; records: number }   // summary ≤ 2,000 chars

// worktree/resolver.ts — over M2's SafeGit (locate → equality → approval → open + branch)
type WorktreeResolution =
  | { kind: "resolved"; root: string; gitDir: string; gitCommonDir: string; isLinkedWorktree: boolean;
      branch: string | null; candidate: string; candidateSource: "transcript" | "desktop_record" }
  | { kind: "unavailable";
      reason: "no_cwd" | "path_missing" | "not_directory" | "not_git" | "git_failed" | "repo_refused"
            | "not_worktree_root" | "not_approved";
      detail: string; candidate: string | null; candidateSource: "transcript" | "desktop_record" | null;
      root: string | null; gitCommonDir: string | null };   // root/gitCommonDir set for not_worktree_root, not_approved
type IsApproved = (root: string, gitCommonDir: string) => boolean;
function resolveWorktree(input: { transcriptCwd: string | null; recordCwd: string | null },
                         deps: { fs: ReadFs; gitPath: string; isApproved: IsApproved }): Promise<WorktreeResolution>;
interface RepoChange { from: string | null; to: string | null; banner: string; contextNote: string }
// banner: "Claude is now in <root> (<branch>)" or "… — unavailable: <detail>";
// contextNote: "Repository changed from A to B", or "Repository A is now available|unavailable" (same root, new state)

// claude/paths.ts, claude/readFs.ts
interface ClaudePaths { desktopSessionsDir: string; projectsDir: string; runningDir: string }
function defaultClaudePaths(home: string): ClaudePaths;
interface FileStat { dev: number; ino: number; size: number; mtimeMs: number; isFile(): boolean; isDirectory(): boolean }
interface RangeRead { buf: Buffer; dev: number; ino: number }
interface ReadFs {                                           // no write method
  readdir(dir: string): Promise<string[]>;
  stat(p: string): Promise<FileStat>;
  readRange(file: string, position: number, length: number): Promise<RangeRead>;
  realpath(p: string): Promise<string>;
}
```
