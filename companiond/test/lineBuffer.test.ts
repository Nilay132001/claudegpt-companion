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
