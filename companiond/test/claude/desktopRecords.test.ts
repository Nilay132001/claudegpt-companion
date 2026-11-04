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
