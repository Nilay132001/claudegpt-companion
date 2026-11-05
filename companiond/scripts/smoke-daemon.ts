// Live smoke (spec §14 M4 "live smoke passes"). Runs the real daemon against the real HOME: the companion's own
// CODEX_HOME, which the owner has already signed in. Never signs in, never acknowledges a security stop, never reads
// or prints a credential, and prints short status lines only: no reply text, no transcript text, no session title,
// no paths.
// Usage: cd companiond && node --disable-warning=ExperimentalWarning scripts/smoke-daemon.ts [--approve <repo root>] [--include-context]
//   --approve          approves that root for this run (revoked at the end if this run added it)
//   --include-context  keeps the owner's sharing mode, so Claude context (title, items, notes) is sent. Without it the
//                      run sets sharing to Off, so only the repository line and the fixed question leave the Mac.
//                      In Ask mode the send is confirmed (chat.send confirmed: true): passing this flag is the owner's
//                      confirmation for this run.
// Whatever happens (try/finally), the run restores the sharing mode, revokes an approval it added, stops the daemon
// and restores the selected session's stored thread id and cursor in companion.db, so the owner's next real
// question sees the same thread and preview as before.
// Exit 0 = turn completed, no security alert, repo unchanged. 2 = not signed in. 1 = anything else.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { appPaths } from "../src/app/appPaths.ts";
import { LineBuffer } from "../src/lineBuffer.ts";
import { SCHEMA_VERSION } from "../src/store/store.ts";

const QUESTION = "Using the repository tools, name one file in this repository and cite it as path:line. Answer in one sentence.";
const args = process.argv.slice(2);
const approveAt = args.indexOf("--approve");
const approveRoot = approveAt >= 0 ? args[approveAt + 1] : undefined;
const includeContext = args.includes("--include-context");
const say = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SmokeError extends Error {}

const main = fileURLToPath(new URL("../src/daemon/main.ts", import.meta.url));
// stderr is dropped: the daemon writes short codes there, but the smoke output stays status-only.
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main], { stdio: ["pipe", "pipe", "ignore"] });
const lb = new LineBuffer();
const waiters = new Map<number, (m: any) => void>();
const events: any[] = [];
let dead = false;
const exited = new Promise<void>((res) => child.on("exit", () => {
  dead = true;
  for (const w of waiters.values()) w({ error: { code: "exited" } });
  res();
}));
child.stdout.on("data", (c: Buffer) => {
  for (const l of lb.push(c)) {
    const m = JSON.parse(l);
    if (m.id !== undefined) waiters.get(m.id)?.(m);
    else events.push(m);
  }
});
let n = 0;
async function call(method: string, params: unknown = {}): Promise<any> {
  if (dead) throw new SmokeError(`${method}: daemon exited`);
  const id = ++n;
  const m: any = await new Promise((res) => {
    waiters.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  waiters.delete(id);
  if (m.error) throw new SmokeError(`${method}: error ${m.error.code}`);
  return m.result;
}

/** Read-only git state of the approved repo. The repo's own fsmonitor and hooks are switched off. */
const gitState = (root: string) => {
  const env = { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
  const git = (a: string[]) => execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...a], { encoding: "utf8", env });
  const status = git(["status", "--porcelain=v1", "-uall"]);
  const index = git(["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  return `${status}\n${fs.statSync(index).mtimeMs}`;
};

// The session's rows in companion.db (schema v1, Task 2), saved before the turn and put back after the daemon exits.
type Row = Record<string, unknown>;
interface Saved { sessionId: string; thread: Row | undefined; cursor: Row | undefined }
const dbPath = appPaths(os.homedir()).dbPath;
function saveRows(sessionId: string): Saved {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (Number((db.prepare("PRAGMA user_version").get() as Row | undefined)?.user_version) !== SCHEMA_VERSION) throw new SmokeError("companion.db schema changed; update the smoke");
    return {
      sessionId,
      thread: db.prepare("SELECT codex_thread_id, updated_at FROM threads WHERE session_id = ?").get(sessionId) as Row | undefined,
      cursor: db.prepare("SELECT uuid, updated_at FROM cursors WHERE session_id = ?").get(sessionId) as Row | undefined,
    };
  } finally {
    db.close();
  }
}
function restoreRows(s: Saved): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN");
    db.prepare("DELETE FROM threads WHERE session_id = ?").run(s.sessionId);
    db.prepare("DELETE FROM cursors WHERE session_id = ?").run(s.sessionId);
    if (s.thread) db.prepare("INSERT INTO threads (session_id, codex_thread_id, updated_at) VALUES (?, ?, ?)").run(s.sessionId, String(s.thread.codex_thread_id), Number(s.thread.updated_at));
    if (s.cursor) db.prepare("INSERT INTO cursors (session_id, uuid, updated_at) VALUES (?, ?, ?)").run(s.sessionId, String(s.cursor.uuid), Number(s.cursor.updated_at));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }
}

let added: string | null = null;
let restoreMode: string | null = null;
let saved: Saved | null = null;

async function run(): Promise<number> {
  await call("daemon.hello", { protocolVersion: 1 });
  let host = await call("host.status");
  for (let i = 0; i < 240 && (host.state === "starting" || host.state === "stopped"); i++) {
    await sleep(500);
    host = await call("host.status");
  }
  const security = host.state === "failed" && String(host.detail).startsWith("Security check failed");
  say(`host: ${host.state}${security ? " (security check failed; not acknowledged by this script)" : ""}`);
  if (host.state !== "ready") return 1;
  const auth = (await call("auth.status")).state;
  say(`auth: ${auth}`);
  if (auth !== "signed_in") return 2;

  const privacy = await call("privacy.get");
  if (approveRoot) {
    const root = fs.realpathSync.native(path.resolve(approveRoot));
    const known = privacy.approvals.some((a: any) => a.root === root);
    if (!known) added = (await call("privacy.approve", { root, includeWorktrees: true })).root;
    say(`approval: ${known ? "already approved" : "added for this run"}`);
  }
  if (!includeContext && privacy.sharingMode !== "off") {
    restoreMode = privacy.sharingMode;
    await call("privacy.setSharingMode", { mode: "off" });
  }
  say(`sharing: ${includeContext ? privacy.sharingMode : "off"} for this run`);
  await call("sessions.refresh");
  const snap = await call("sessions.snapshot");
  const sessionId: string | null = snap.selection.sessionId;
  if (!sessionId) {
    say("session: none selected");
    return 1;
  }
  saved = saveRows(sessionId);
  const wt = await call("sessions.worktree", { sessionId });
  const root: string | null = wt?.kind === "resolved" ? wt.root : null;
  const before = root ? gitState(root) : null;

  const p = await call("chat.prepare", { sessionId, question: QUESTION });
  say(`repo: ${p.repo.state} | mode: ${p.mode} | items: ${p.preview?.items.length ?? 0} | bytes: ${p.preview?.bytes ?? 0} | notes: ${p.preview?.notes.length ?? 0}`);
  // Ask mode (only with --include-context) needs confirmed: true; the flag is the owner's confirmation for this run.
  const { turnId } = await call("chat.send", { prepareId: p.prepareId, removeItemIds: [], confirmed: p.needsConfirm === true });
  let done: any = null;
  for (let i = 0; i < 600 && !done; i++) {
    await sleep(500);
    done = events.find((e) => e.method === "chat.turnCompleted" && e.params.turnId === turnId);
  }
  const reply = events.filter((e) => e.method === "chat.delta" && e.params.turnId === turnId).map((e) => e.params.text).join("");
  const tools = events.filter((e) => e.method === "chat.item" && e.params.turnId === turnId && e.params.phase === "completed" && e.params.item.type === "mcpToolCall").length;
  const alerts = events.filter((e) => e.method === "security.alert").map((e) => e.params.kind);
  const replaced = events.some((e) => e.method === "chat.threadReplaced");
  const unchanged = before === null || root === null || gitState(root) === before;
  say(`turn: ${done?.params.status ?? "timeout"} | reply chars: ${reply.length} | cites path:line: ${/[\w./-]+\.\w+:\d+/.test(reply)} | tool calls: ${tools} | alerts: ${JSON.stringify(alerts)} | thread replaced: ${replaced} | repo unchanged: ${unchanged}`);
  return done?.params.status === "completed" && alerts.length === 0 && unchanged ? 0 : 1;
}

let code = 1;
try {
  code = await run();
} catch (e) {
  say(`error: ${e instanceof SmokeError ? e.message : e instanceof Error ? e.name : "unknown"}`);
  code = 1;
} finally {
  if (restoreMode) await call("privacy.setSharingMode", { mode: restoreMode }).then(() => say("sharing: restored"), () => say("sharing: NOT restored"));
  if (added) await call("privacy.revoke", { root: added }).then(() => say("approval: revoked"), () => say("approval: NOT revoked"));
  await call("daemon.shutdown").catch(() => undefined);
  await Promise.race([exited, sleep(10_000)]);
  if (!dead) child.kill();
  await exited;
  if (saved) {
    try {
      restoreRows(saved);
      say("companion.db: thread and cursor restored");
    } catch (e) {
      say(`companion.db: NOT restored (${e instanceof Error ? e.name : "error"})`);
      code = 1;
    }
  }
}
process.exit(code);
