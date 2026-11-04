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

test("a read that returns no bytes while stat reports more ends the poll with more=false", async () => {
  const f = file(`{"m":"${MARK}"}\n`);
  const lying: ReadFs = {
    ...nodeReadFs,
    stat: async (p) => {
      const st = await nodeReadFs.stat(p);
      return {
        dev: st.dev,
        ino: st.ino,
        size: st.size + 100,
        mtimeMs: st.mtimeMs,
        isFile: () => true,
        isDirectory: () => false,
      };
    },
    readRange: async (p, pos, len) => {
      const r = await nodeReadFs.readRange(p, pos, len);
      return { ...r, buf: pos >= fs.statSync(p).size ? Buffer.alloc(0) : r.buf };
    },
  };
  const t = new TranscriptTail(f, lying);
  const first = await t.poll();
  assert.ok(first.kind === "data" && first.lines.length === 1);
  assert.equal(first.more, false);
  const second = await t.poll();
  assert.ok(second.kind === "data");
  assert.equal(second.more, false);
});
