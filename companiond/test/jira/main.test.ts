import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeSecret } from "../../src/jira/credentials.ts";
import { CREDS } from "./fixtures.ts";

const MAIN = fileURLToPath(new URL("../../src/jira/main.ts", import.meta.url));

function run(secret: string | null, args: string[], stdin: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [MAIN, ...args], { stdio: ["pipe", "pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    let out = "";
    let err = "";
    p.stdout!.on("data", (c) => (out += c));
    p.stderr!.on("data", (c) => (err += c));
    const fd3 = p.stdio[3] as NodeJS.WritableStream;
    if (secret !== null) fd3.write(secret);
    fd3.end();
    p.stdin!.end(stdin);
    p.on("exit", (code) => {
      assert.ok(!err.includes(CREDS.token) && !out.includes(CREDS.token), "the token is never printed");
      resolve({ out, code });
    });
  });
}

test("with a good secret it serves tools/list over stdio and exits on EOF", async () => {
  const { out, code } = await run(encodeSecret(CREDS), [], `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.trim()).result.tools.map((t: any) => t.name), ["jira_get_issue", "jira_search", "jira_get_comments"]);
});

test("a bad or missing secret leaves the server refusing every call", async () => {
  for (const secret of [null, "garbage\n"]) {
    const { out } = await run(secret, [], `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jira_get_issue", arguments: { key: "SYN-1" } } })}\n`);
    const r = JSON.parse(out.trim());
    assert.equal(r.result.isError, true);
    assert.equal(r.result.content[0].text, "Jira is not set up in the companion.");
  }
});

test("--check without a usable secret answers one line and exits 0", async () => {
  const { out, code } = await run("garbage\n", ["--check"], "");
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.trim()), { ok: false, kind: "setup" });
});
