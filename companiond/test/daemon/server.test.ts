import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { LineBuffer } from "../../src/lineBuffer.ts";
import { ErrorCodes } from "../../src/daemon/protocol.ts";
import { DaemonError, DaemonServer } from "../../src/daemon/server.ts";

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  const out: any[] = [];
  const lb = new LineBuffer();
  output.on("data", (c: Buffer) => { for (const l of lb.push(c)) out.push(JSON.parse(l)); });
  let ended = 0;
  const server = new DaemonServer(input, output, {
    "x.ok": async (p) => ({ echo: p.v ?? null }),
    "x.known": async () => { throw new DaemonError(ErrorCodes.turnBusy, "busy", { reason: "busy" }); },
    "x.bug": async () => { throw new Error("/private/secret/path leaked"); },
  }, (e) => (e instanceof DaemonError ? e : new DaemonError(ErrorCodes.internal, "companiond: internal error")), () => { ended++; });
  const send = (o: unknown) => input.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n");
  return { server, out, send, input, ended: () => ended };
}

test("results, mapped errors and internal errors without details", async () => {
  const { out, send } = setup();
  send({ jsonrpc: "2.0", id: 1, method: "x.ok", params: { v: 2 } });
  send({ jsonrpc: "2.0", id: "b", method: "x.known" });
  send({ jsonrpc: "2.0", id: 3, method: "x.bug" });
  await tick();
  assert.deepEqual(out, [
    { jsonrpc: "2.0", id: 1, result: { echo: 2 } },
    { jsonrpc: "2.0", id: "b", error: { code: ErrorCodes.turnBusy, message: "busy", data: { reason: "busy" } } },
    { jsonrpc: "2.0", id: 3, error: { code: ErrorCodes.internal, message: "companiond: internal error" } },
  ]);
});

test("parse errors, invalid requests, unknown methods, bad params; notifications ignored", async () => {
  const { out, send } = setup();
  send("{nope");
  send({ id: 1, method: "x.ok" });
  send({ jsonrpc: "2.0", id: 2, method: "toString" });
  send({ jsonrpc: "2.0", id: 3, method: "x.ok", params: [1] });
  send({ jsonrpc: "2.0", method: "x.ok" });
  await tick();
  assert.deepEqual(out.map((m) => [m.id, m.error?.code]), [
    [null, ErrorCodes.parseError], [1, ErrorCodes.invalidRequest], [2, ErrorCodes.methodNotFound], [3, ErrorCodes.invalidParams],
  ]);
});

test("notify writes a JSON-RPC notification; end of input calls onEnd", async () => {
  const { server, out, input, ended } = setup();
  server.notify("host.changed", { state: "starting" });
  input.end();
  await tick();
  assert.deepEqual(out, [{ jsonrpc: "2.0", method: "host.changed", params: { state: "starting" } }]);
  assert.equal(ended(), 1);
});
