import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nodeWatchFactory } from "../../src/bridge/watcher.ts";
import { listTranscripts } from "../../src/bridge/transcriptOnly.ts";
import { nodeReadFs } from "../../src/claude/readFs.ts";
import { claudeTree, MARK, removeTempDirs, tempDir, transcriptPath, userLine, writeTranscript } from "../helpers/fixtures.ts";

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
