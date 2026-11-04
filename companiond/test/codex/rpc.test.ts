import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { LineBuffer } from "../../src/lineBuffer.ts";
import { CLIENT_METHODS } from "../../src/codex/methods.ts";
import {
  HANDLER_FAILED, RpcClient, RpcClosedError, RpcError, RpcMethodNotAllowedError, RpcTimeoutError, type ServerRequestHandler,
} from "../../src/codex/rpc.ts";

const tick = () => new Promise((r) => setImmediate(r));

function pair(onServerRequest: ServerRequestHandler = async () => ({ result: null }), timeoutMs?: number) {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const stderr = new PassThrough();
  const sent: any[] = [];
  const lb = new LineBuffer();
  fromClient.on("data", (c: Buffer) => { for (const l of lb.push(c)) sent.push(JSON.parse(l)); });
  const client = new RpcClient(
    { input: toClient, output: fromClient, stderr },
    { allowedMethods: ["a", "b", "initialized"], onServerRequest, timeoutMs },
  );
  const say = (o: unknown) => toClient.write(JSON.stringify(o) + "\n");
  return { client, sent, say, toClient, stderr };
}

test("request and response round trip, ids increase", async () => {
  const { client, sent, say } = pair();
  const p1 = client.request("a", { x: 1 });
  const p2 = client.request("b");
  await tick();
  assert.deepEqual(sent, [{ id: 1, method: "a", params: { x: 1 } }, { id: 2, method: "b" }]);
  say({ id: 2, result: "two" });
  say({ id: 1, error: { code: -5, message: "nope" } });
  assert.equal(await p2, "two");
  await assert.rejects(p1, (e: unknown) => e instanceof RpcError && e.code === -5);
});

test("unknown response ids and bad lines are counted, not thrown", async () => {
  const { client, say, toClient } = pair();
  say({ id: 99, result: 1 });
  toClient.write("not json\n[1,2]\n{}\n");
  await tick();
  assert.equal(client.stats.unknownResponseIds, 1);
  assert.equal(client.stats.malformedLines, 3);
});

test("a timeout rejects, and the late reply is counted as unknown", async () => {
  const { client, say } = pair(undefined, 20);
  await assert.rejects(client.request("a"), RpcTimeoutError);
  say({ id: 1, result: "late" });
  await tick();
  assert.equal(client.stats.unknownResponseIds, 1);
});

test("stdout ending rejects pending requests and later ones", async () => {
  const { client, toClient } = pair();
  const p = client.request("a");
  let closed = 0;
  client.onClose(() => closed++);
  toClient.end();
  await assert.rejects(p, RpcClosedError);
  await assert.rejects(client.request("b"), RpcClosedError);
  assert.equal(client.isClosed, true);
  assert.equal(closed, 1);
});

test("server requests are answered after an async handler, errors become -32603", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { sent, say } = pair(async (method) => {
    if (method === "boom") throw new Error("handler bug");
    await gate;
    return { result: { decision: "decline" } };
  });
  say({ id: "s1", method: "item/fileChange/requestApproval", params: {} });
  say({ id: 7, method: "boom", params: {} });
  await tick();
  assert.deepEqual(sent, [{ id: 7, error: HANDLER_FAILED }]);
  release();
  await tick(); await tick();
  assert.deepEqual(sent[1], { id: "s1", result: { decision: "decline" } });
});

test("notifications reach listeners; a throwing listener does not break others", async () => {
  const { client, say } = pair();
  const got: string[] = [];
  client.onNotification(() => { throw new Error("listener bug"); });
  const off = client.onNotification((m) => got.push(m));
  say({ method: "turn/started", params: {} });
  await tick();
  off();
  say({ method: "turn/completed", params: {} });
  await tick();
  assert.deepEqual(got, ["turn/started"]);
});

test("methods outside the allowlist are never sent", async () => {
  const { client, sent } = pair();
  await assert.rejects(client.request("fs/writeFile", {}), RpcMethodNotAllowedError);
  assert.throws(() => client.notify("thread/shellCommand"), RpcMethodNotAllowedError);
  await tick();
  assert.deepEqual(sent, []);
});

test("stderr is counted and never kept", async () => {
  const { client, stderr } = pair();
  const secretish = "/private/var/somewhere/SYNTHETIC-path-in-stderr";
  stderr.write(secretish);
  await tick();
  assert.equal(client.stats.stderrBytes, secretish.length);
  assert.doesNotMatch(JSON.stringify(client.stats), /SYNTHETIC-path/);
});

test("a real child that exits rejects pending requests", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume(); setTimeout(() => process.exit(3), 50)"], { stdio: ["pipe", "pipe", "pipe"] });
  const client = new RpcClient(
    { input: child.stdout, output: child.stdin, stderr: child.stderr },
    { allowedMethods: ["a"], onServerRequest: async () => ({ result: null }) },
  );
  await assert.rejects(client.request("a"), RpcClosedError);
});

test("CLIENT_METHODS has no write, exec, fs or plugin method", () => {
  for (const m of CLIENT_METHODS) {
    assert.doesNotMatch(m, /^(fs\/|command\/|process\/|plugin\/|marketplace\/|skills\/|app\/|review\/|windowsSandbox\/)|shellCommand|tool\/call|enablement|inject_items|config\/(value|batch)|mcpServer\/oauth/, m);
  }
});
