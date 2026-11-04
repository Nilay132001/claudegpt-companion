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
  makeRepo,
  makeWorktree,
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
  assert.equal(w2.change?.contextNote, `Repository changed from ${a.worktree} to ${other.main} — unavailable: This repository is not approved yet`);
  assert.equal(b.worktree("local_syn-a")?.kind, "unavailable");
  assert.equal(await b.liveBranch("local_syn-a"), null);
});

test("§6.3 a session that moved repo while untailed reports the change when selected again", async () => {
  const a = repoWithWorktree();
  const other = repoWithWorktree();
  const { p, make, take } = harness();
  const f = transcriptPath(p, a.main, "cli-a");
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: a.main, lastFocusedAt: T0 });
  writeRecord(p, { sessionId: "local_syn-b", cliSessionId: "cli-b", cwd: "/syn/b", lastFocusedAt: T0 - 1 });
  writeTranscript(f, "cli-a", [userLine("cli-a", a.main, "start")]);
  const b = make();
  await b.refresh();
  assert.equal(b.worktree("local_syn-a")?.kind, "resolved");
  b.pin("local_syn-b");
  await b.idle();
  assert.equal(b.syncStatus("local_syn-a").state, "not_tracked");
  // §6.3: no last-good root is exposed for a session that is not being tailed.
  assert.equal(b.worktree("local_syn-a"), null);
  assert.equal(await b.liveBranch("local_syn-a"), null);
  assert.equal(await b.resolveNow("local_syn-a"), null);
  appendLines(f, [userLine("cli-a", other.main, "moved while untailed")]);
  take();
  b.pin("local_syn-a");
  await b.idle();
  const wt = ofType(take(), "worktree").filter((e) => e.sessionId === "local_syn-a");
  assert.equal(wt.length, 1);
  assert.ok(wt[0].resolution.kind === "resolved" && wt[0].resolution.root === other.main);
  assert.notEqual(wt[0].change, null);
  assert.equal(wt[0].change?.contextNote, `Repository changed from ${a.main} to ${other.main}`);
});

test("§6.3 a resolved root whose approval is revoked becomes unavailable on the next tick", async () => {
  const a = repoWithWorktree();
  let approved = true;
  const { p, make, take } = harness({ isApproved: () => approved });
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: a.main, lastFocusedAt: T0 });
  const b = make();
  await b.refresh();
  assert.equal(b.worktree("local_syn-a")?.kind, "resolved");
  take();
  approved = false;
  await b.tick();
  const wt = ofType(take(), "worktree");
  assert.equal(wt.length, 1);
  assert.ok(wt[0].resolution.kind === "unavailable" && wt[0].resolution.reason === "not_approved");
  assert.notEqual(wt[0].change, null);
  assert.equal(b.worktree("local_syn-a")?.kind, "unavailable");
  assert.equal(b.snapshot().sessions[0].resolvedRoot, null);
});

test("§6.3 a resolved root whose folder is deleted becomes path_missing on the next tick", async () => {
  const a = repoWithWorktree();
  const { p, make, take } = harness();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: a.worktree, lastFocusedAt: T0 });
  const b = make();
  await b.refresh();
  assert.equal(b.worktree("local_syn-a")?.kind, "resolved");
  take();
  fs.rmSync(a.worktree, { recursive: true, force: true });
  await b.tick();
  const wt = ofType(take(), "worktree");
  assert.equal(wt.length, 1);
  assert.ok(wt[0].resolution.kind === "unavailable" && wt[0].resolution.reason === "path_missing");
  assert.notEqual(wt[0].change, null);
  // Unchanged after that: no event per tick.
  await b.tick();
  assert.deepEqual(ofType(take(), "worktree"), []);
});

test("a new cliSessionId whose file has no cwd record yet keeps the transcript cwd (no flip to the record cwd)", async () => {
  const a = repoWithWorktree();
  const { p, make, take } = harness();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-1", cwd: a.main, lastFocusedAt: T0 });
  writeTranscript(transcriptPath(p, a.main, "cli-1"), "cli-1", [userLine("cli-1", a.worktree, "in the worktree")]);
  writeTranscript(transcriptPath(p, a.main, "cli-2"), "cli-2", []);
  const b = make();
  await b.refresh();
  assert.ok(b.worktree("local_syn-a")?.kind === "resolved");
  take();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-2", cwd: a.main, lastFocusedAt: T0 });
  await b.tick();
  const ev = take();
  assert.ok(ofType(ev, "transcript").some((e) => e.cliSessionId === "cli-2" && e.batch.kind === "reset"));
  assert.deepEqual(ofType(ev, "worktree"), []);
  const r = b.worktree("local_syn-a");
  assert.ok(r?.kind === "resolved" && r.root === a.worktree);
});

test("a tracked transcript that stops being known is reported missing before its reader is dropped", async () => {
  const { p, make, take } = harness();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-1", cwd: "/syn/a", lastFocusedAt: T0 });
  writeTranscript(transcriptPath(p, "/syn/a", "cli-1"), "cli-1", [userLine("cli-1", "/syn/a", "old")]);
  const b = make();
  await b.refresh();
  take();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-2", cwd: "/syn/a", lastFocusedAt: T0 });
  await b.tick();
  assert.deepEqual(
    ofType(take(), "transcript").map((e) => [e.cliSessionId, e.batch.kind]),
    [["cli-1", "missing"]],
  );
  assert.equal(b.syncStatus("local_syn-a").state, "not_tracked");
  await b.tick();
  assert.deepEqual(ofType(take(), "transcript"), []);
});

test("a throwing listener does not freeze the bridge or starve other listeners", async () => {
  const { p, make } = harness();
  const b = make();
  b.on(() => {
    throw new Error("synthetic listener failure");
  });
  const seen: BridgeEvent[] = [];
  b.on((e) => seen.push(e));
  await b.tick();
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 });
  await b.tick();
  assert.deepEqual(b.snapshot().sessions.map((s) => s.sessionId), ["local_syn-a"]);
  const last = ofType(seen, "sessions").at(-1);
  assert.deepEqual(last?.snapshot.sessions.map((s) => s.sessionId), ["local_syn-a"]);
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
  assert.equal(await b.resolveNow("local_syn-unlisted"), null);
  assert.equal(b.worktree("local_syn-unlisted"), null);
});

test("symlinks to .key files in the Claude folders are refused, never opened, and the pass carries on", async () => {
  const opened: string[] = [];
  const statted: string[] = [];
  const refused: string[] = [];
  const spy: ReadFs = {
    ...nodeReadFs,
    stat: (x) => (statted.push(x), nodeReadFs.stat(x)),
    readRange: (x, pos, len) => (opened.push(x), nodeReadFs.readRange(x, pos, len)),
  };
  const { p, make, take } = harness({ fs: spy, onRefusedPath: (n) => refused.push(n) });
  fs.writeFileSync(path.join(p.runningDir, "9.key"), MARK);
  fs.symlinkSync(path.join(p.runningDir, "9.key"), path.join(p.runningDir, "9.json"));
  const f = transcriptPath(p, "/syn/a", "cli-a");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(f), "x.key"), MARK);
  fs.symlinkSync(path.join(path.dirname(f), "x.key"), f);
  const rec = writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: "/syn/a", lastFocusedAt: T0 });
  const recLink = path.join(path.dirname(rec), "local_syn-k.json");
  fs.writeFileSync(path.join(path.dirname(rec), "k.key"), MARK);
  fs.symlinkSync(path.join(path.dirname(rec), "k.key"), recLink);
  const b = make();
  const snap = await b.refresh();
  await b.tick();
  assert.deepEqual(snap.sessions.map((s) => [s.sessionId, s.transcriptMissing]), [["local_syn-a", "not_found"]]);
  assert.deepEqual(ofType(take(), "sync_error"), []);
  for (const k of ["9.key", "x.key", "k.key"]) assert.ok(refused.includes(k), refused.join(","));
  assert.deepEqual(opened.filter((x) => x.endsWith(".key") || x === f || x === recLink || x.endsWith("9.json")), []);
  // stat (which opens nothing) only ever sees the real target, to tell a `.key` folder from a key file.
  assert.deepEqual(statted.filter((x) => x === f || x === recLink || x.endsWith("9.json")), []);
});

test("a repo folder whose name ends in .key resolves and is never reported as refused", async () => {
  const root = makeWorktree(makeRepo(), "syn.key");
  const refused: string[] = [];
  const { p, make } = harness({ onRefusedPath: (n) => refused.push(n) });
  writeRecord(p, { sessionId: "local_syn-a", cliSessionId: "cli-a", cwd: root, lastFocusedAt: T0 });
  const b = make();
  await b.refresh();
  const r = b.worktree("local_syn-a");
  assert.ok(r?.kind === "resolved" && r.root === root, JSON.stringify(r));
  assert.deepEqual(refused, []);
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
  // Re-arm delays are 25 ms, then 50 ms; each check sits at least 25 ms from the timer it waits on.
  const { p, make, take } = harness({ watch, pollIntervalMs: 60_000, rewatchDelayMs: 25 });
  const b = make();
  b.start();
  await b.idle();
  writeRecord(p, { sessionId: "local_syn-new", cliSessionId: "cli-new", cwd: "/syn/n", lastFocusedAt: T0 });
  const enoent = Object.assign(new Error("synthetic"), { code: "ENOENT" });
  created[1].onError(enoent);
  await b.idle();
  assert.deepEqual(b.snapshot().sessions, []);
  await sleep(75);
  assert.equal(created.length, 4);
  created[3].onError(enoent);
  await sleep(10);
  assert.equal(created.length, 4, "second re-arm waits for the doubled delay");
  await sleep(90);
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
