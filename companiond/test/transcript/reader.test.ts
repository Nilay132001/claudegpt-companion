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
