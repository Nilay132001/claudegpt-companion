import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("kill() after a failed spawn never signals the process group (pid 0)", async () => {
  // Detached = its own process group, so a kill(0) regression kills only the child, never the test runner.
  const child = spawn(process.execPath, [fileURLToPath(new URL("./pidlessSpawn.ts", import.meta.url))], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), 15_000);
  });
  const res = await Promise.race([exit, timeout]);
  clearTimeout(timer);
  if (res === "timeout") process.kill(-(child.pid as number), "SIGKILL");
  assert.deepEqual(res, { code: 0, signal: null });
  assert.equal(out.trim(), "RESULT pid=none exits=spawn failed");
});
