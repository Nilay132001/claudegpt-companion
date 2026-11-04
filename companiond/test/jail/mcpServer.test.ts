import { after, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { SafeGit } from "../../src/git/safeGit.ts";
import { handleMessage, SERVER_NAME, TOOL_NAMES, type ServerState } from "../../src/jail/mcpServer.ts";
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

test("main.ts refuses relative env paths", async () => {
  const entry = fileURLToPath(new URL("../../src/jail/main.ts", import.meta.url));
  const c = startClient(process.execPath, [entry], { COMPANION_ROOT: "repo", COMPANION_GIT: "git", PATH: "/usr/bin:/bin" });
  try {
    assert.match((await callTool(c, "list_dir")).text, /must be absolute paths/);
  } finally {
    await c.close();
  }
});
