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
