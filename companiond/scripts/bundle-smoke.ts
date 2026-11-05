// Bundle smoke (M7, ruling R7): runs the BUILT app's own Node and companiond, signed out, with a throw-away HOME, and
// requires the Codex host to reach "ready" — so the pre-start self-check passed from inside the bundle (pinned version,
// config, layers, code mode, tool surface, Codex under its Seatbelt profile, the relay built from the bundled source).
// Never touches the owner's App Support, Codex home, Keychain items or Claude data; never signs in; sends nothing.
// Status lines only: no paths, no detail text beyond the host's own fixed messages.
// Usage: node companiond/scripts/bundle-smoke.ts "<path to ClaudeGPT Companion.app>"
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LineBuffer } from "../src/lineBuffer.ts";

const say = (line: string) => process.stdout.write(`bundle-smoke: ${line}\n`);
const app = process.argv[2];
if (!app) {
  say("usage: bundle-smoke.ts <app path>");
  process.exit(2);
}
const res = path.join(path.resolve(app), "Contents", "Resources");
const node = path.join(res, "node", "bin", "node");
const daemonDir = path.join(res, "companiond");
const main = path.join(daemonDir, "src", "daemon", "main.ts");
const plistVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(path.resolve(app), "Contents", "Info.plist")], { encoding: "utf8" }).trim();

// Short on purpose: the relay socket under it must fit in 104 bytes (plan fact 6).
const home = fs.mkdtempSync("/tmp/cgc-smoke.");
fs.chmodSync(home, 0o700);
// The app's own minimal environment (spec §7.8), with the throw-away HOME.
const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, USER: process.env.USER ?? "smoke", LOGNAME: process.env.USER ?? "smoke", TMPDIR: process.env.TMPDIR ?? "/tmp" };
const child = spawn(node, ["--disable-warning=ExperimentalWarning", main], { cwd: daemonDir, env, stdio: ["pipe", "pipe", "ignore"] });

const lb = new LineBuffer();
const waiters = new Map<number, (m: any) => void>();
let nextId = 0;
let exited = false;
const exitedP = new Promise<void>((r) => {
  child.on("exit", () => { exited = true; for (const w of waiters.values()) w({ error: { message: "exited" } }); r(); });
  child.on("error", () => { exited = true; r(); });
});
child.stdout.on("data", (d: Buffer) => {
  for (const line of lb.push(d)) {
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (typeof m.id === "number" && waiters.has(m.id)) { waiters.get(m.id)!(m); waiters.delete(m.id); }
  }
});
const call = (method: string, params: object = {}, ms = 15_000): Promise<any> => new Promise((resolve, reject) => {
  if (exited) return reject(new Error(`${method}: the daemon exited`));
  const id = ++nextId;
  const t = setTimeout(() => { waiters.delete(id); reject(new Error(`${method}: no answer in ${ms} ms`)); }, ms);
  waiters.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(`${method}: ${m.error.message ?? "error"}`)) : resolve(m.result); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ok = false;
try {
  const hello = await call("daemon.hello", { protocolVersion: 1 });
  if (hello.daemonVersion !== plistVersion) throw new Error(`daemon ${hello.daemonVersion} != Info.plist ${plistVersion}`);
  say(`hello ok (version ${hello.daemonVersion})`);
  const t0 = Date.now();
  let s: any = { state: "starting" };
  while (Date.now() - t0 < 90_000) {
    s = await call("host.status");
    if (s.state === "ready" || s.state === "failed") break;
    await sleep(500);
  }
  if (s.state !== "ready") throw new Error(`host ${s.state}${s.detail ? `: ${s.detail}` : ""}`);
  say(`host ready in ${Date.now() - t0} ms (${s.warnings.length} warning(s))`);
  const a = await call("auth.status");
  if (a.state !== "signed_out") throw new Error(`auth ${a.state} (expected signed_out with a fresh HOME)`);
  say("auth signed_out");
  const support = path.join(home, "Library", "Application Support", "ClaudeGPTCompanion");
  if ((fs.statSync(support).mode & 0o777) !== 0o700) throw new Error("the App Support folder is not 0700");
  say("app support 0700");
  await call("daemon.shutdown").catch(() => undefined);
  const done = await Promise.race([exitedP.then(() => true), sleep(15_000).then(() => false)]);
  if (!done) throw new Error("the daemon did not exit within 15 s");
  say("daemon stopped");
  ok = true;
} catch (e) {
  say(`FAIL ${(e as Error).message}`);
} finally {
  if (!exited) child.kill("SIGTERM");
  await Promise.race([exitedP, sleep(5_000)]);
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
