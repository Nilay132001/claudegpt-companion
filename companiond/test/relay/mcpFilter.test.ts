import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { EXIT, MAX_IN_FLIGHT, McpFilter, sendLine } from "../../src/relay/mcpFilter.ts";

const TOOLS = ["list_dir", "read_file", "search", "git_status", "git_diff"];
const L = (o: unknown) => JSON.stringify(o);
const closes = (v: ReturnType<McpFilter["fromClient"]>, code: number = EXIT.violation) => v.kind === "close" && v.code === code;

test("initialize, notifications and allowlisted tools/call are re-serialised and forwarded", () => {
  const f = new McpFilter(TOOLS);
  const v = f.fromClient(L({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_dir", arguments: {} }, extra: "smuggled" }));
  assert.deepEqual(v, { kind: "forward", line: `${L({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_dir", arguments: {} } })}\n` });
  assert.equal(f.inFlight, 1);
  assert.deepEqual(f.fromClient(L({ jsonrpc: "2.0", method: "notifications/initialized" })), { kind: "forward", line: `${L({ jsonrpc: "2.0", method: "notifications/initialized" })}\n` });
  assert.equal(f.fromClient(L({ jsonrpc: "2.0", id: "a", method: "initialize", params: {} })).kind, "forward");
  // Duplicate keys resolve to the last one (spike review): the refused name wins, never the allowed one.
  assert.ok(closes(f.fromClient('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_dir","name":"exec"}}')));
});

test("ids: strings up to 256 bytes and safe integers only (M1)", () => {
  const f = new McpFilter(TOOLS);
  for (const id of [1.5, 9007199254740993, "x".repeat(257), null, {}, true]) {
    assert.ok(closes(f.fromClient(L({ jsonrpc: "2.0", id, method: "ping" }))), String(id));
  }
  assert.ok(closes(f.fromClient('{"jsonrpc":"2.0","id":1e400,"method":"ping"}')));
  assert.equal(f.fromClient(L({ jsonrpc: "2.0", id: "x".repeat(256), method: "ping" })).kind, "forward");
});

test("resources/*, prompts/list are answered locally and never close (ruling)", () => {
  const f = new McpFilter(TOOLS);
  assert.deepEqual(f.fromClient(L({ jsonrpc: "2.0", id: 2, method: "resources/list" })), { kind: "local", line: `${L({ jsonrpc: "2.0", id: 2, result: { resources: [] } })}\n` });
  assert.deepEqual(f.fromClient(L({ jsonrpc: "2.0", id: 3, method: "resources/templates/list" })), { kind: "local", line: `${L({ jsonrpc: "2.0", id: 3, result: { resourceTemplates: [] } })}\n` });
  assert.deepEqual(f.fromClient(L({ jsonrpc: "2.0", id: 4, method: "prompts/list" })), { kind: "local", line: `${L({ jsonrpc: "2.0", id: 4, result: { prompts: [] } })}\n` });
  assert.deepEqual(f.fromClient(L({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "file:///etc/hosts" } })), { kind: "local", line: `${L({ jsonrpc: "2.0", id: 5, error: { code: -32002, message: "Resource not found" } })}\n` });
  assert.equal(f.inFlight, 0);
});

test("notifications/cancelled is validated and dropped (M6)", () => {
  const f = new McpFilter(TOOLS);
  assert.deepEqual(f.fromClient(L({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "interrupted" } })), { kind: "drop" });
  assert.deepEqual(f.fromClient(L({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "x" } })), { kind: "drop" });
  assert.ok(closes(f.fromClient(L({ jsonrpc: "2.0", id: 1, method: "notifications/cancelled", params: { requestId: 7 } }))));
  assert.ok(closes(f.fromClient(L({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }))));
  assert.ok(closes(f.fromClient(L({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: 3 } }))));
});

test("anything else closes the binding as a violation", () => {
  const bad = [
    L({ jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: {} }),
    L({ jsonrpc: "2.0", id: 1, method: "sampling/createMessage", params: {} }),
    L({ jsonrpc: "2.0", id: 1, method: "logging/setLevel", params: {} }),
    L({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "exec", arguments: {} } }),
    L({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_dir", arguments: [] } }),
    L({ jsonrpc: "2.0", id: 1, method: "ping", params: [] }),
    L({ jsonrpc: "2.0", id: 1, result: {} }),
    L({ jsonrpc: "2.0", id: 1, method: "ping", result: {} }),
    L({ jsonrpc: "2.0", method: "tools/list" }),
    L({ jsonrpc: "2.0", id: 1, method: "notifications/initialized" }),
    L([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
    L({ id: 1, method: "ping" }),
    "{not json",
  ];
  for (const line of bad) assert.ok(closes(new McpFilter(TOOLS).fromClient(line)), line);
  const f = new McpFilter(TOOLS);
  assert.equal(f.fromClient(L({ jsonrpc: "2.0", id: 1, method: "ping" })).kind, "forward");
  assert.ok(closes(f.fromClient(L({ jsonrpc: "2.0", id: 1, method: "ping" }))), "duplicate id");
});

test(`${MAX_IN_FLIGHT} requests may be in flight; one more closes with the limit code (I3)`, () => {
  const f = new McpFilter(TOOLS);
  for (let i = 0; i < MAX_IN_FLIGHT; i++) assert.equal(f.fromClient(L({ jsonrpc: "2.0", id: i, method: "ping" })).kind, "forward");
  assert.ok(closes(f.fromClient(L({ jsonrpc: "2.0", id: 99, method: "ping" })), EXIT.limit));
});

test("server lines: only responses to outstanding ids, with an object result or a well-formed error (M2)", () => {
  const f = new McpFilter(TOOLS);
  f.fromClient(L({ jsonrpc: "2.0", id: 7, method: "tools/list" }));
  assert.deepEqual(f.fromServer(L({ jsonrpc: "2.0", id: 7, result: { tools: [] }, extra: 1 })), { kind: "forward", line: `${L({ jsonrpc: "2.0", id: 7, result: { tools: [] } })}\n` });
  assert.equal(f.inFlight, 0);
  assert.ok(closes(f.fromServer(L({ jsonrpc: "2.0", id: 7, result: {} }))), "answered twice");
  const g = () => {
    const x = new McpFilter(TOOLS);
    x.fromClient(L({ jsonrpc: "2.0", id: 1, method: "ping" }));
    return x;
  };
  assert.deepEqual(g().fromServer(L({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no", data: { a: 1 } } })), { kind: "forward", line: `${L({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no", data: { a: 1 } } })}\n` });
  for (const line of [
    L({ jsonrpc: "2.0", id: 999, result: {} }),
    L({ jsonrpc: "2.0", id: 1, error: "not-an-object" }),
    L({ jsonrpc: "2.0", id: 1, error: { code: 1.5, message: "x" } }),
    L({ jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } }),
    L({ jsonrpc: "2.0", id: 1, result: [] }),
    L({ jsonrpc: "2.0", id: 1 }),
    L({ jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} }),
    L({ jsonrpc: "2.0", method: "notifications/message", params: {} }),
    "{not json",
  ]) assert.ok(closes(g().fromServer(line)), line);
});

test("sendLine pauses the source while a destination is full and resumes when all have drained (I3, M-2)", async () => {
  const src = new PassThrough();
  src.resume();
  const held: Array<() => void> = [];
  const full = () => new Writable({ highWaterMark: 4, write(_c, _e, cb) { held.push(() => cb()); } });
  const a = full();
  const b = full();
  sendLine(a, "0123456789\n", src);
  sendLine(b, "0123456789\n", src);
  assert.equal(src.isPaused(), true);
  held.shift()?.(); // a drains
  await new Promise((r) => setImmediate(r));
  assert.equal(src.isPaused(), true, "b is still full");
  held.shift()?.(); // b drains
  await new Promise((r) => setImmediate(r));
  assert.equal(src.isPaused(), false);
});
