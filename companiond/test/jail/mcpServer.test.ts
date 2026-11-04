import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { SafeGit } from "../../src/git/safeGit.ts";
import { handleMessage, SERVER_NAME, serveStdio, TOOL_NAMES, type ServerState } from "../../src/jail/mcpServer.ts";
import { callTool, startClient } from "../helpers/mcpClient.ts";
import { makeRepo, put, removeTempDirs, testGitPath } from "../helpers/fixtures.ts";

after(removeTempDirs);

async function ready(): Promise<ServerState> {
  const git = await SafeGit.open({ root: makeRepo({ "a.txt": "hello\n" }), gitPath: testGitPath() });
  return { kind: "ready", ctx: { root: git.root, git, redact: (s) => s } };
}

test("initialize echoes a supported protocol version", async () => {
  const r = await handleMessage(await ready(), { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.deepEqual(r, {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: "0.2.0" } },
  });
  const r2 = (await handleMessage(await ready(), { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as any;
  assert.equal(r2.result.protocolVersion, "2025-06-18");
});

test("tools/list lists exactly the five read-only tools", async () => {
  const r = (await handleMessage(await ready(), { jsonrpc: "2.0", id: 1, method: "tools/list" })) as any;
  assert.deepEqual(r.result.tools.map((t: any) => t.name), [...TOOL_NAMES]);
  for (const t of r.result.tools) assert.equal(t.annotations.readOnlyHint, true);
});

test("notifications get no reply; unknown methods and bad input get JSON-RPC errors", async () => {
  const s = await ready();
  assert.equal(await handleMessage(s, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual(await handleMessage(s, { jsonrpc: "2.0", id: 3, method: "resources/list" }), {
    jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Method not found" },
  });
  assert.deepEqual(await handleMessage(s, [1, 2]), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  const bad = (await handleMessage(s, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_file", arguments: "x" } })) as any;
  assert.equal(bad.result.isError, true);
});

test("a refused repo answers every tool with the reason", async () => {
  const s: ServerState = { kind: "refused", reason: "Repository refused: its git config can run programs (core.pager)" };
  const r = (await handleMessage(s, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "a.txt" } } })) as any;
  assert.deepEqual(r.result, { content: [{ type: "text", text: s.reason }], isError: true });
});

test("main.ts serves over stdio (unsandboxed)", async () => {
  const repo = makeRepo();
  put(repo, "a.txt", "hello\n");
  const entry = fileURLToPath(new URL("../../src/jail/main.ts", import.meta.url));
  const c = startClient(process.execPath, [entry], { COMPANION_ROOT: repo, COMPANION_GIT: testGitPath(), PATH: "/usr/bin:/bin" });
  try {
    const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.serverInfo.name, SERVER_NAME);
    assert.match((await callTool(c, "read_file", { path: "a.txt" })).text, /hello/);
    assert.deepEqual(await callTool(c, "read_file", { path: "../a.txt" }), { text: "Not available.", isError: true });
  } finally {
    await c.close();
  }
});

// Feeds `chunks` to serveStdio exactly as given (chunk boundaries kept), then returns every reply line.
async function serve(state: ServerState, chunks: Array<string | Buffer>, handle?: typeof handleMessage): Promise<any[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (c: Buffer) => {
    out += c.toString("utf8");
  });
  const done = handle ? serveStdio(state, input, output, handle) : serveStdio(state, input, output);
  for (const c of chunks) input.write(c);
  input.end();
  await done;
  return out.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
}

const ping = (id: number) => `${JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })}\n`;

test("stdio: an oversize line gets one error and its tail is never run as a request", async () => {
  const replies = await serve(await ready(), [Buffer.alloc(1024 * 1024 + 10, 0x78), ping(99), ping(100)]);
  assert.deepEqual(replies, [
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Message too large" } },
    { jsonrpc: "2.0", id: 100, result: {} },
  ]);
});

test("stdio: bad JSON, an unknown tool and a notification", async () => {
  const replies = await serve(await ready(), [
    "{not json\n",
    `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope", arguments: {} } })}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    ping(8),
  ]);
  assert.deepEqual(replies, [
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
    { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "Unknown tool: nope" }], isError: true } },
    { jsonrpc: "2.0", id: 8, result: {} },
  ]);
});

test("stdio: an internal error answers with the request's id", async () => {
  const boom = async (): Promise<null> => {
    throw new Error("boom");
  };
  const replies = await serve(await ready(), [ping(41)], boom);
  assert.deepEqual(replies, [{ jsonrpc: "2.0", id: 41, error: { code: -32603, message: "Internal error" } }]);
});

test("main.ts exits quietly when its stdout closes (EPIPE)", async () => {
  const repo = makeRepo();
  const entry = fileURLToPath(new URL("../../src/jail/main.ts", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { COMPANION_ROOT: repo, COMPANION_GIT: testGitPath(), PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (c: Buffer) => {
    err += c.toString("utf8");
  });
  child.stdout.destroy(); // the reader goes away before the server writes anything
  const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  for (let i = 1; i <= 50; i++) child.stdin.write(ping(i));
  child.stdin.end();
  const code = await closed;
  assert.equal(err, "", "no stack trace on stderr");
  assert.equal(code, 0);
});

test("main.ts refuses relative env paths", async () => {
  const entry = fileURLToPath(new URL("../../src/jail/main.ts", import.meta.url));
  const c = startClient(process.execPath, [entry], { COMPANION_ROOT: "repo", COMPANION_GIT: "git", PATH: "/usr/bin:/bin" });
  try {
    assert.match((await callTool(c, "list_dir")).text, /must be absolute paths/);
  } finally {
    await c.close();
  }
});
