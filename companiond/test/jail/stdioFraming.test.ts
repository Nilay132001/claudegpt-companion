import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serveStdio } from "../../src/jail/mcpServer.ts";

async function run(chunks: Buffer[]): Promise<Array<{ id: unknown; error?: { code: number; message: string } }>> {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (c: Buffer) => {
    text += c.toString("utf8");
  });
  const done = serveStdio({ kind: "refused", reason: "SYNTHETIC FIXTURE" }, input, output);
  for (const c of chunks) input.write(c);
  input.end();
  await done;
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("an invalid UTF-8 line still gets a -32700 Parse error reply", async () => {
  const replies = await run([Buffer.from([0x7b, 0xff, 0x7d, 0x0a])]);
  assert.deepEqual(replies, [{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }]);
});

test("a line over 1 MiB gets one 'Message too large' reply and the next request is still served", async () => {
  const big = Buffer.alloc(1024 * 1024 + 10, 0x61);
  const next = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) + "\n");
  const replies = await run([big, Buffer.from("\n"), next]);
  const tooLarge = replies.filter((r) => r.error?.message === "Message too large");
  assert.equal(tooLarge.length, 1);
  assert.equal(tooLarge[0].error?.code, -32700);
  assert.equal(replies.filter((r) => r.id === 7).length, 1);
});
