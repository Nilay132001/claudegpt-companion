import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RepoRefusedError } from "../../src/git/safeGit.ts";
import { NOT_AVAILABLE } from "../../src/jail/containedPath.ts";
import { SERVER_NAME, TOOL_NAMES } from "../../src/jail/mcpServer.ts";
import { buildReadonlyLaunch, SANDBOX_EXEC } from "../../src/launch/seatbelt.ts";
import { discoverToolchain } from "../../src/launch/toolchain.ts";
import { fixtureGit, makeRepo, makeWorktree, put, removeTempDirs, tempDir } from "../helpers/fixtures.ts";
import { callTool, startClient } from "../helpers/mcpClient.ts";

after(removeTempDirs);

// Skipped only off macOS. On macOS a missing sandbox-exec fails these tests; there is no opt-out.
const skip = process.platform !== "darwin" ? "Seatbelt is macOS-only" : false;

test("the launch spec is sandbox-exec + profile + node + entry, with a fixed env", { skip }, async () => {
  const repo = makeRepo();
  const tc = discoverToolchain();
  const spec = await buildReadonlyLaunch({ root: repo });
  assert.equal(spec.command, SANDBOX_EXEC);
  assert.equal(spec.args.length, 4);
  assert.equal(spec.args[0], "-p");
  assert.ok(spec.args[1]?.includes(`(subpath "${repo}")`));
  assert.deepEqual(spec.args.slice(2), [tc.nodePath, tc.serverEntry]);
  assert.equal(spec.cwd, repo);
  assert.deepEqual(Object.keys(spec.env).sort(), ["COMPANION_GIT", "COMPANION_ROOT", "PATH", ...Object.keys(spec.env).filter((k) => k === "OPENSSL_CONF")].sort());
  assert.equal(spec.env.COMPANION_ROOT, repo);
  assert.equal(spec.env.COMPANION_GIT, tc.gitPath);
});

test("a repo whose config can run programs, a sub-folder and home are refused at launch", { skip }, async () => {
  const repo = makeRepo({ "sub/x.txt": "x" });
  await assert.rejects(buildReadonlyLaunch({ root: path.join(repo, "sub") }), RepoRefusedError);
  fixtureGit(repo, ["config", "--local", "core.pager", "cat"]);
  await assert.rejects(buildReadonlyLaunch({ root: repo }), RepoRefusedError);
  await assert.rejects(buildReadonlyLaunch({ root: os.homedir() }));
});

test("the jailed server works on a worktree and refuses everything outside it", { skip }, async () => {
  const main = makeRepo({ "src/app.ts": "export const answer = 42;\n", "config/credentials.json": "CRED_ORIGINAL_MARKER\n" });
  const wt = makeWorktree(main);
  put(wt, "src/app.ts", "export const answer = 43;\n");
  put(wt, "config/credentials.json", "CRED_CHANGED_MARKER\n"); // tracked, denied, modified
  put(wt, "notes/new.txt", "UNTRACKED_MARKER\n");
  put(wt, ".env", "ENV_ONLY_MARKER\n");
  const outside = put(tempDir("cgc-out-"), "outside.txt", "OUTSIDE_MARKER\n");
  const spec = await buildReadonlyLaunch({ root: wt });
  const c = startClient(spec.command, spec.args, spec.env, spec.cwd);
  try {
    const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result?.serverInfo?.name, SERVER_NAME, c.stderr());
    const list = await c.request("tools/list");
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), [...TOOL_NAMES]);
    assert.match((await callTool(c, "read_file", { path: "src/app.ts" })).text, /answer = 43/);
    const refused = { text: NOT_AVAILABLE, isError: true };
    assert.deepEqual(await callTool(c, "read_file", { path: path.relative(wt, outside) }), refused);
    assert.deepEqual(await callTool(c, "read_file", { path: path.relative(wt, path.join(main, "README.md")) }), refused);
    assert.deepEqual(await callTool(c, "read_file", { path: ".env" }), refused);
    assert.deepEqual(await callTool(c, "read_file", { path: ".git" }), refused);
    const status = await callTool(c, "git_status");
    assert.equal(status.isError, false, status.text);
    assert.match(status.text, / M src\/app\.ts/);
    assert.match(status.text, /\?\? notes\/new\.txt/);
    assert.doesNotMatch(status.text, /\.env|credentials/);
    const diff = await callTool(c, "git_diff");
    assert.equal(diff.isError, false, diff.text);
    assert.match(diff.text, /\+export const answer = 43;/);
    assert.doesNotMatch(diff.text, /credentials|CRED_/);
    assert.match((await callTool(c, "search", { query: "UNTRACKED_MARKER" })).text, /^notes\/new\.txt:2:/m);
    assert.equal((await callTool(c, "search", { query: "ENV_ONLY_MARKER" })).text, "(no matches)");
    assert.equal((await callTool(c, "search", { query: "CRED_CHANGED_MARKER" })).text, "(no matches)");
    const ls = (await callTool(c, "list_dir")).text.split("\n");
    assert.ok(ls.includes("src/") && !ls.includes(".git") && !ls.includes(".env"), ls.join(","));
  } finally {
    await c.close();
  }
  assert.equal(fs.existsSync(path.join(wt, "PWNED.txt")), false);
});
