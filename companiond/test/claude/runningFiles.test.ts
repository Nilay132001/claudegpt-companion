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
