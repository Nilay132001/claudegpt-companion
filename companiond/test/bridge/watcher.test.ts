import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nodeWatchFactory } from "../../src/bridge/watcher.ts";
import { listTranscripts, TRANSCRIPT_ONLY_MAX, TranscriptHeadCache } from "../../src/bridge/transcriptOnly.ts";
import type { ReadFs } from "../../src/claude/readFs.ts";
import { nodeReadFs } from "../../src/claude/readFs.ts";
import { appendLines, claudeTree, MARK, removeTempDirs, tempDir, transcriptPath, userLine, writeTranscript } from "../helpers/fixtures.ts";

after(removeTempDirs);

test("watching a missing directory reports ENOENT through onError and never throws", async () => {
  let timer: NodeJS.Timeout | undefined;
  const err = await new Promise<Error>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("onError was not called within 2 s")), 2000);
    const h = nodeWatchFactory(path.join(tempDir(), "missing"), () => {}, resolve);
    h.close();
  }).finally(() => clearTimeout(timer));
  assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
});

test("a watch handle closes, and closing it a second time does not throw", () => {
  const h = nodeWatchFactory(tempDir(), () => {}, () => {});
  h.close();
  assert.doesNotThrow(() => h.close());
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

function readSpy() {
  const reads: string[] = [];
  const fsSpy: ReadFs = { ...nodeReadFs, readRange: (f, pos, len) => (reads.push(f), nodeReadFs.readRange(f, pos, len)) };
  return { reads, fsSpy };
}

test("listTranscripts with a shared cache re-reads no head of an unchanged or appended file", async () => {
  const p = claudeTree();
  const a = transcriptPath(p, "/syn/a", "cli-a");
  const b = transcriptPath(p, "/syn/b", "cli-b");
  writeTranscript(a, "cli-a", [userLine("cli-a", "/syn/a", "x")]);
  writeTranscript(b, "cli-b", [userLine("cli-b", "/syn/b", "y")]);
  fs.utimesSync(a, new Date(2026, 0, 1), new Date(2026, 0, 1));
  writeTranscript(transcriptPath(p, "/syn/c", "cli-wrong"), "cli-someone-else", []);
  const { reads, fsSpy } = readSpy();
  const cache = new TranscriptHeadCache();
  const first = await listTranscripts(fsSpy, p.projectsDir, TRANSCRIPT_ONLY_MAX, cache);
  assert.deepEqual(first.map((e) => e.cliSessionId), ["cli-b", "cli-a"]);
  assert.ok(reads.length >= 3);
  reads.length = 0;
  appendLines(a, [userLine("cli-a", "/syn/a", "more")]);
  const second = await listTranscripts(fsSpy, p.projectsDir, TRANSCRIPT_ONLY_MAX, cache);
  assert.deepEqual(second.map((e) => e.cliSessionId), ["cli-a", "cli-b"]);
  assert.deepEqual(reads, []);
});

test("the head cache re-checks a replaced file and a rejected file that changed, and forgets vanished ones", async () => {
  const p = claudeTree();
  const a = transcriptPath(p, "/syn/a", "cli-a");
  const late = transcriptPath(p, "/syn/l", "cli-late");
  writeTranscript(a, "cli-a", [userLine("cli-a", "/syn/a", "x")]);
  fs.mkdirSync(path.dirname(late), { recursive: true });
  fs.writeFileSync(late, "");
  const { reads, fsSpy } = readSpy();
  const cache = new TranscriptHeadCache();
  assert.deepEqual((await listTranscripts(fsSpy, p.projectsDir, TRANSCRIPT_ONLY_MAX, cache)).map((e) => e.cliSessionId), ["cli-a"]);
  // Replaced (new inode) with another session's file: re-checked and dropped. The empty file got its head.
  const tmp = `${a}.tmp`;
  writeTranscript(tmp, "cli-someone-else", []);
  fs.renameSync(tmp, a);
  writeTranscript(late, "cli-late", []);
  reads.length = 0;
  assert.deepEqual((await listTranscripts(fsSpy, p.projectsDir, TRANSCRIPT_ONLY_MAX, cache)).map((e) => e.cliSessionId), ["cli-late"]);
  assert.deepEqual([...new Set(reads)].sort(), [a, late].sort());
  fs.rmSync(a);
  await listTranscripts(fsSpy, p.projectsDir, TRANSCRIPT_ONLY_MAX, cache);
  assert.equal(cache.size, 1);
});

test("the cap and newest-first order hold with a cache", async () => {
  const p = claudeTree();
  const cache = new TranscriptHeadCache();
  for (const [i, id] of ["cli-1", "cli-2", "cli-3"].entries()) {
    const f = transcriptPath(p, `/syn/${id}`, id);
    writeTranscript(f, id, []);
    fs.utimesSync(f, new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i));
  }
  for (let pass = 0; pass < 2; pass++) {
    assert.deepEqual((await listTranscripts(nodeReadFs, p.projectsDir, 2, cache)).map((e) => e.cliSessionId), ["cli-3", "cli-2"]);
  }
  assert.equal(cache.size, 2);
});
