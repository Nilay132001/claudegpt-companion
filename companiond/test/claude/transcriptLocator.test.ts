import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  HEAD_BYTES,
  locateTranscript,
  transcriptHasSessionId,
} from "../../src/claude/transcriptLocator.ts";
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

test("a file of exactly HEAD_BYTES with no newline is read to its end, not treated as cut short", async () => {
  const dir = tempDir();
  const exact = path.join(dir, "exact.jsonl");
  const line = JSON.stringify({ type: "user", sessionId: "cli-a" });
  fs.writeFileSync(exact, line + " ".repeat(HEAD_BYTES - line.length));
  assert.equal(fs.statSync(exact).size, HEAD_BYTES);
  assert.equal(await transcriptHasSessionId(nodeReadFs, exact, "cli-a"), true);
});
