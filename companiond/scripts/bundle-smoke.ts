// Bundle smoke (M7, ruling R7): runs the BUILT app's own Node and companiond, signed out, with a throw-away HOME, and
// requires the Codex host to reach "ready" — so the pre-start self-check passed from inside the bundle (pinned version,
// config, layers, code mode, tool surface, Codex under its Seatbelt profile, the relay built from the bundled source).
// Never touches the owner's App Support, Codex home or Claude data; never signs in; sends nothing. Codex's keyring
// lookup for the throw-away CODEX_HOME finds nothing (signed_out proves it); the smoke never reads or writes the
// owner's sign-in item.
// Status lines only: no paths, no stacks, no detail text beyond the host's own fixed messages. Every failure is one
// `bundle-smoke: FAIL <short reason>` line and exit 1; the throw-away HOME is always removed.
// Usage: node companiond/scripts/bundle-smoke.ts "<path to ClaudeGPT Companion.app>"
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LineBuffer } from "../src/lineBuffer.ts";

const say = (line: string) => process.stdout.write(`bundle-smoke: ${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let home: string | undefined;
let child: ChildProcess | undefined;
let exited = false;
const cleanup = () => {
  try { if (child && !exited && child.exitCode === null) child.kill("SIGKILL"); } catch { /* already gone */ }
  try { if (home) fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
};
// Nothing may escape as a stack trace (it would carry paths) or skip the cleanup.
process.on("uncaughtException", () => {
  say("FAIL unexpected error");
  cleanup();
  process.exit(1);
});

const app = process.argv[2];
if (!app) {
  say("usage: bundle-smoke.ts <app path>");
  process.exit(2);
}

let ok = false;
try {
  const appDir = path.resolve(app);
  const res = path.join(appDir, "Contents", "Resources");
  const node = path.join(res, "node", "bin", "node");
  const daemonDir = path.join(res, "companiond");
  const main = path.join(daemonDir, "src", "daemon", "main.ts");
  if (!fs.existsSync(node) || !fs.existsSync(main)) throw new Error("the app has no bundled Node or companiond at that path");
  let plistVersion: string;
  try {
    plistVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(appDir, "Contents", "Info.plist")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error("cannot read the version from the app's Info.plist");
  }

  // Short on purpose: the relay socket under it must fit in 104 bytes (plan fact 6).
  try {
    home = fs.mkdtempSync("/tmp/cgc-smoke.");
    fs.chmodSync(home, 0o700);
    fs.mkdirSync(path.join(home, "tmp"), { mode: 0o700 });
  } catch {
    throw new Error("cannot create the throw-away HOME");
  }
  // The app's own minimal environment (spec §7.8), with the throw-away HOME and a TMPDIR inside it.
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, USER: process.env.USER ?? "smoke", LOGNAME: process.env.USER ?? "smoke", TMPDIR: path.join(home, "tmp") };
  const proc = spawn(node, ["--disable-warning=ExperimentalWarning", main], { cwd: daemonDir, env, stdio: ["pipe", "pipe", "ignore"] });
  child = proc;

  const lb = new LineBuffer();
  const waiters = new Map<number, (m: any) => void>();
  let nextId = 0;
  const failWaiters = () => { for (const w of waiters.values()) w({ error: { message: "exited" } }); waiters.clear(); };
  const exitedP = new Promise<void>((r) => {
    proc.on("exit", () => { exited = true; failWaiters(); r(); });
    proc.on("error", () => { exited = true; failWaiters(); r(); });
  });
  proc.stdin!.on("error", () => { /* the daemon is gone; the pending call is failed by exit/error */ });
  proc.stdout!.on("data", (d: Buffer) => {
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
    proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

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
  if (child && !exited) {
    child.kill("SIGTERM");
    await sleep(100);
    for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  }
  cleanup();
}
process.exit(ok ? 0 : 1);
