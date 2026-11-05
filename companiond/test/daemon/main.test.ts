import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LineBuffer } from "../../src/lineBuffer.ts";
import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);
const src = fileURLToPath(new URL("../../src/", import.meta.url));

test("the daemon answers over stdio with a fresh home and chat off, then shuts down", async () => {
  const home = tempDir();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(src, "daemon", "main.ts")], {
    env: { PATH: "/usr/bin:/bin", HOME: home, COMPANIOND_CODEX: "off" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
  const lb = new LineBuffer();
  const waiters = new Map<number, (m: any) => void>();
  const notifications: any[] = [];
  child.stdout.on("data", (c: Buffer) => {
    for (const l of lb.push(c)) {
      const m = JSON.parse(l); // stdout carries protocol only: every line is JSON
      if (m.id !== undefined) waiters.get(m.id)?.(m);
      else notifications.push(m);
    }
  });
  let id = 0;
  const call = (method: string, params: unknown = {}) => new Promise<any>((res) => {
    const n = ++id;
    waiters.set(n, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  assert.equal((await call("daemon.hello", { protocolVersion: 1 })).result.protocolVersion, 1);
  assert.deepEqual((await call("host.status")).result, { state: "failed", detail: "Chat is off (COMPANIOND_CODEX=off)." });
  assert.equal((await call("host.acknowledgeSecurityStop")).error.code, -32600);
  assert.equal((await call("sessions.refresh")).result.desktopRecordsError, "Claude Desktop sessions not found");
  assert.equal((await call("privacy.get")).result.sharingMode, "ask");
  const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
  await call("daemon.shutdown");
  assert.equal(await exited, 0);
  const support = path.join(home, "Library", "Application Support", "ClaudeGPTCompanion");
  assert.equal(fs.statSync(support).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(support, "companion.db")).mode & 0o777, 0o600);
  assert.doesNotMatch(stderr, /ExperimentalWarning/);
  assert.ok(!stderr.includes(home), "stderr holds no paths");
  for (const line of stderr.trim().split("\n")) assert.match(line, /^companiond: [a-z]/);
});

test("a closed stdout (the app quit) logs a short code and shuts down, with no stack trace", async () => {
  const home = tempDir();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(src, "daemon", "main.ts")], {
    env: { PATH: "/usr/bin:/bin", HOME: home, COMPANIOND_CODEX: "off" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
  const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
  while (!stderr.includes("companiond: started")) await new Promise((r) => setTimeout(r, 20));
  child.stdout.destroy();
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.hello", params: { protocolVersion: 1 } }) + "\n");
  assert.equal(await exited, 1);
  assert.match(stderr, /^companiond: stdout error \(Error\)$/m);
  assert.match(stderr, /^companiond: stopped$/m);
  assert.doesNotMatch(stderr, /\n\s+at /, "no stack trace");
  assert.ok(!stderr.includes(home), "stderr holds no paths");
});

test("production wiring: createCompanionCodex only, refused while not measured, no stdout prints", () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(src, ...p), "utf8");
  const main = read("daemon", "main.ts");
  assert.match(main, /createCompanionCodex\(/);
  assert.match(main, /CODEX_SEATBELT_MEASURED !== "ok"/);
  assert.match(main, /process\.on\("uncaughtException", fatal\("fatal"\)\)/);
  assert.match(main, /process\.on\("unhandledRejection", fatal\("fatal"\)\)/);
  assert.match(main, /process\.stdout\.on\("error", fatal\("stdout error"\)\)/);
  assert.doesNotMatch(main, /new CodexHost\(|buildCodexLaunch\(|sandboxed: false|measurementOnly/);
  const wiring = read("codex", "companionCodex.ts");
  assert.match(wiring, /sandboxed: true/);
  assert.doesNotMatch(wiring, /sandboxed: false|measurementOnly/);
  for (const dir of ["daemon", "chat", "context", "codex", "privacy", "store"]) {
    for (const f of fs.readdirSync(path.join(src, dir)).filter((x) => x.endsWith(".ts"))) {
      assert.doesNotMatch(read(dir, f), /console\.(log|info|debug)\(/, `${dir}/${f}`);
    }
  }
  for (const dir of ["daemon", "chat"]) {
    for (const f of fs.readdirSync(path.join(src, dir)).filter((x) => x.endsWith(".ts"))) {
      const text = read(dir, f);
      // M4b never lists MCP status (without serverName it spends the relay token; M4a M-10).
      assert.doesNotMatch(text, /mcpServerStatus/, `${dir}/${f}`);
      // Only the owner's acknowledgement clears a security stop.
      if (f !== "handlers.ts" && f !== "disabledHost.ts") assert.doesNotMatch(text, /clearSecurityStop\(\)/, `${dir}/${f}`);
    }
  }
  assert.equal(read("daemon", "handlers.ts").match(/\.clearSecurityStop\(\)/g)?.length, 1);
});
