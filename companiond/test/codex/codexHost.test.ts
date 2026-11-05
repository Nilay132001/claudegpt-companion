import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appPaths, ensureAppDirs, type AppPaths } from "../../src/app/appPaths.ts";
import { prepareCodeMode, snapshotProtectedFiles, type PreparedCodeMode } from "../../src/codex/codeMode.ts";
import { CodexHost, HostBusyError, HostNotReadyError, SecurityCheckError, TurnBusyError, type HostEvent, type HostState } from "../../src/codex/codexHost.ts";
import type { CodexInstall } from "../../src/codex/codexInstall.ts";
import { CATALOG_FILE, codexStageDir, writeCodexHomeFile } from "../../src/codex/config.ts";
import { COMPANION_ALLOWLIST } from "../../src/codex/serverRequests.ts";
import { SANDBOX_EXEC, type LaunchSpec } from "../../src/launch/seatbelt.ts";
import { DEFAULT_TOKEN_TTL_MS } from "../../src/relay/broker.ts";
import { FAKE_MODEL, FakeBroker, fakeSpawn, goodHandlers, type FakeAppServer, type Handler } from "./fakeAppServer.ts";import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const RELAY = "/s/bin/cgc-relay";
const SRV = "mcp_servers.companion-readonly";
const jail = (root: string): LaunchSpec => ({ command: "/usr/bin/sandbox-exec", args: ["-p", `(subpath "${root}")`, "/n/node", "/c/main.ts"], env: { COMPANION_ROOT: root, COMPANION_GIT: "/g", PATH: "/usr/bin:/bin" }, cwd: root });
const bind = (root: string) => ({ root, launch: jail(root) });
/** Like prepareCodeMode: writes the two protected files and returns their hashes. */
const okPrepare = (paths: AppPaths) => (): PreparedCodeMode => {
  writeCodexHomeFile(paths.codexHome, "config.toml", "# SYNTHETIC FIXTURE config\n");
  writeCodexHomeFile(paths.codexHome, CATALOG_FILE, "{}");
  return { result: { failures: [], warnings: [] }, models: [FAKE_MODEL], protectedFiles: snapshotProtectedFiles(paths.codexHome) };
};
const FAKE_INSTALL: CodexInstall = { version: "0.166.0", vendorDir: "/v", binary: "/v/bin/codex", codeModeHost: "/v/bin/codex-code-mode-host", pathDir: null, resourcesDir: null };
const detail = (s: HostState) => (s.state === "failed" ? s.detail : "");
const LOGIN_PROFILE = "(version 1) ; sign-in";

function host(o: { handlers?: () => Record<string, Handler>; jiraTools?: readonly string[]; paths?: AppPaths; maxProcesses?: number; maxBindings?: number; exitTimeoutMs?: number; unsandboxed?: boolean; measurementOnly?: boolean; prepare?: (paths: AppPaths) => () => PreparedCodeMode } = {}) {
  const paths = o.paths ?? ensureAppDirs(appPaths(tempDir()));
  const f = fakeSpawn(o.handlers ?? (() => goodHandlers({ jiraTools: o.jiraTools })));
  const broker = new FakeBroker();
  const events: HostEvent[] = [];
  const env = { CODEX_HOME: paths.codexHome };
  const h = new CodexHost({
    paths, codexVersion: "0.166.0", pinnedVersion: "0.166.0", allowlist: COMPANION_ALLOWLIST, spawn: f.spawn, broker, relayBinary: RELAY,
    prepare: (o.prepare ?? okPrepare)(paths), maxProcesses: o.maxProcesses, maxBindings: o.maxBindings, exitTimeoutMs: o.exitTimeoutMs, measurementOnly: o.measurementOnly,
    makeLaunch: () => (o.unsandboxed
      ? { command: "/fake/codex", args: ["app-server"], env, cwd: paths.emptyCwd }
      : { command: SANDBOX_EXEC, args: ["-p", "(version 1)", "/fake/codex", "app-server"], env, cwd: paths.emptyCwd }),
    makeLoginLaunch: () => ({ command: SANDBOX_EXEC, args: ["-p", LOGIN_PROFILE, "/fake/codex", "app-server"], env, cwd: paths.emptyCwd }),
  });
  h.on((e) => events.push(e));
  return { h, f, broker, events, paths };
}
const srv = (f: { servers: FakeAppServer[] }, i: number) => f.servers[i] as FakeAppServer;
const withHandler = (name: string, fn: Handler) => () => ({ ...goodHandlers(), [name]: fn });

test("start: prepares code mode, runs the self-check, ready with the unified_exec warning", async () => {
  let prepared = 0;
  const { h, f, paths } = host({ prepare: (p) => () => { prepared++; return okPrepare(p)(); } });
  const s = await h.start();
  assert.equal(s.state, "ready");
  assert.equal(prepared, 1);
  assert.equal(s.state === "ready" && s.warnings.length, 1);
  assert.equal(f.servers.length, 1);
  assert.deepEqual(srv(f, 0).methods(), ["initialize", "initialized", "config/read", "experimentalFeature/list", "mcpServerStatus/list"]);
  assert.deepEqual(srv(f, 0).last("config/read"), { includeLayers: true, cwd: paths.emptyCwd });
});

test("an unsandboxed launch is refused before spawn; measurementOnly allows it and labels it", async () => {
  const a = host({ unsandboxed: true });
  assert.match(detail(await a.h.start()), /Security check failed: .*Seatbelt/);
  assert.equal(a.f.servers.length, 0);
  const b = host({ unsandboxed: true, measurementOnly: true });
  const r = await b.h.start();
  assert.ok(r.state === "ready" && r.warnings.some((w) => w.startsWith("measurement only")));
});

test("a failing code-mode preparation stops the start before any spawn", async () => {
  const { h, f } = host({ prepare: () => () => ({ result: { failures: ["tool surface (m): collaboration.spawn_agent is exposed"], warnings: [] }, models: [], protectedFiles: {} }) });
  assert.match(detail(await h.start()), /Security check failed: .*collaboration\.spawn_agent/);
  assert.equal(f.servers.length, 0);
});

test("a planted link fails the start closed before any spawn; the link target is untouched (final review I-1)", async () => {
  const victimDir = tempDir();
  fs.chmodSync(victimDir, 0o755);
  const victim = path.join(victimDir, "victim.txt");
  fs.writeFileSync(victim, "SYNTHETIC FIXTURE victim\n", { mode: 0o644 });
  // A symlink at the staging name of config.toml.
  const a = host();
  fs.mkdirSync(codexStageDir(a.paths.codexHome), { mode: 0o700 });
  fs.symlinkSync(victim, path.join(codexStageDir(a.paths.codexHome), `config.toml.tmp-${process.pid}`));
  assert.equal((await a.h.start()).state, "failed");
  assert.equal(a.f.servers.length, 0);
  assert.equal(fs.readFileSync(victim, "utf8"), "SYNTHETIC FIXTURE victim\n");
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
  // CODEX_HOME/tmp replaced by a symlink: the real preparation refuses it before writing or running anything.
  const notReached = () => { throw new Error("SYNTHETIC: never reached"); };
  const b = host({ prepare: (p) => () => prepareCodeMode({ install: FAKE_INSTALL, paths: p, run: notReached }) });
  fs.rmdirSync(path.join(b.paths.codexHome, "tmp"));
  fs.symlinkSync(victimDir, path.join(b.paths.codexHome, "tmp"));
  assert.match(detail(await b.h.start()), /Security check failed: .*not a real folder/);
  assert.equal(b.f.servers.length, 0);
  assert.equal(fs.statSync(victimDir).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(victimDir), ["victim.txt"]);
});

test("a config/read without the code-mode settings fails the self-check and stops the process", async () => {
  const { h, f } = host({
    handlers: withHandler("config/read", (p, fake) => {
      const r = goodHandlers()["config/read"]?.(p, fake) as any;
      r.config.features.code_mode_host = false;
      return r;
    }),
  });
  assert.match(detail(await h.start()), /code_mode_host/);
  assert.equal(srv(f, 0).killed, true);
});

test("an AGENTS.md above the companion folder fails before code mode is prepared or Codex starts", async () => {
  const home = tempDir();
  fs.writeFileSync(path.join(home, "AGENTS.md"), "SYNTHETIC FIXTURE\n");
  let prepared = 0;
  const { h, f } = host({ paths: ensureAppDirs(appPaths(home)), prepare: (p) => () => { prepared++; return okPrepare(p)(); } });
  assert.equal((await h.start()).state, "failed");
  assert.equal(prepared, 0);
  assert.equal(f.servers.length, 0);
});

test("a bound thread runs in its root's own process, with the relay command and a fresh one-time token", async () => {
  const { h, f, broker, paths } = host();
  await h.start();
  const t1 = await h.openThread(null, bind("/r1"));
  assert.equal(f.servers.length, 2); // base + /r1
  const p = srv(f, 1).last("thread/start");
  assert.equal(p.cwd, paths.emptyCwd);
  assert.equal(p.sandbox, "read-only");
  assert.equal(p.approvalPolicy, "untrusted");
  assert.match(p.developerInstructions, /untrusted_data/);
  assert.equal(p.config[`${SRV}.command`], RELAY);
  assert.deepEqual(p.config[`${SRV}.args`], []);
  assert.equal(p.config[`${SRV}.cwd`], paths.emptyCwd);
  assert.deepEqual(p.config[`${SRV}.env`], { CGC_RELAY_TOKEN: broker.grants[0]?.token });
  assert.deepEqual(broker.grants[0]?.launch, jail("/r1"));
  assert.equal(broker.grants[0]?.ttl, DEFAULT_TOKEN_TTL_MS);
  const t2 = await h.openThread(null, bind("/r1"));
  assert.equal(f.servers.length, 2, "same root, same process");
  assert.notEqual(t2, t1);
  assert.notEqual(broker.grants[1]?.token, broker.grants[0]?.token);
  assert.equal(await h.openThread(t1, bind("/r1")), t1); // already bound: no-op
  assert.equal(broker.grants.length, 2);
  await h.openThread(null, null);
  assert.equal(srv(f, 0).last("thread/start").config[`${SRV}.command`], "/usr/bin/false");
  assert.equal(broker.grants.length, 2, "no token for a thread without a root");
});

test("moving a thread to another root: unsubscribe, revoke, close the old process, resume in that root's process with a new token", async () => {
  const { h, f, broker } = host();
  await h.start();
  const t = await h.openThread(null, bind("/r1"));
  await h.openThread(t, bind("/r2"));
  assert.equal(broker.grants[0]?.revoked, true);
  assert.deepEqual(srv(f, 1).last("thread/unsubscribe"), { threadId: t });
  assert.equal(srv(f, 1).killed, true, "the old root's process is closed (0.166.0 keeps the writer lock after unsubscribe)");
  const r = srv(f, 2).last("thread/resume");
  assert.equal(r.threadId, t);
  assert.equal(r.config[`${SRV}.env`].CGC_RELAY_TOKEN, broker.grants[1]?.token);
  assert.deepEqual(broker.grants[1]?.launch, jail("/r2"));
  assert.equal(h.state().state, "ready");
});

test("root move: no thread/resume before the old process has exited; its other threads are unloaded and their grants revoked", async () => {
  const { h, f, broker } = host();
  await h.start();
  const moving = await h.openThread(null, bind("/r1"));
  const sibling = await h.openThread(null, bind("/r1"));
  const old = srv(f, 1);
  old.exitOnKill = false; // a process that is slow to die
  let done = false;
  const move = h.openThread(moving, bind("/r2")).then(() => {
    done = true;
  });
  await tick(20);
  assert.equal(old.killed, true);
  assert.deepEqual(old.methods().filter((m) => m === "thread/unsubscribe").length, 2);
  assert.deepEqual(old.received.filter((m) => m.method === "thread/unsubscribe").map((m) => m.params.threadId).sort(), [moving, sibling].sort());
  assert.equal(broker.grants[0]?.revoked, true);
  assert.equal(broker.grants[1]?.revoked, true, "the sibling's grant is revoked too");
  assert.equal(f.servers.slice(2).some((s) => s.methods().includes("thread/resume")), false, "no resume before the old process exits");
  assert.equal(done, false);
  old.exit("killed");
  await move;
  const r2 = f.servers.find((s) => s.methods().includes("thread/resume"));
  assert.equal(r2?.last("thread/resume").threadId, moving);
  await assert.rejects(h.startTurn(sibling, "x"), /not open/);
  // The old root's process is spawned again on demand.
  const n = f.servers.length;
  await h.openThread(sibling, bind("/r1"));
  assert.equal(f.servers.length, n + 1);
  assert.equal(f.servers[n]?.last("thread/resume").threadId, sibling);
  assert.equal(h.state().state, "ready");
});

test("root move: a busy sibling on the old process refuses with HostBusyError and changes nothing", async () => {
  const { h, f, broker } = host();
  await h.start();
  const moving = await h.openThread(null, bind("/r1"));
  const sibling = await h.openThread(null, bind("/r1"));
  await h.startTurn(sibling, "busy");
  const servers = f.servers.length;
  await assert.rejects(h.openThread(moving, bind("/r2")), HostBusyError);
  assert.equal(srv(f, 1).killed, false);
  assert.equal(srv(f, 1).methods().includes("thread/unsubscribe"), false);
  assert.equal(broker.grants.length, 2, "no grant for the target root");
  assert.equal(broker.grants.some((g) => g.revoked), false);
  assert.equal(f.servers.length, servers, "no process for the target root");
  assert.notEqual(h.activeTurn(sibling), null);
  await h.startTurn(moving, "still open"); // the moving thread is still loaded where it was
  assert.equal(h.state().state, "ready");
});

test("root move: an old process that does not exit in time fails the host; nothing is resumed", async () => {
  const { h, f } = host({ exitTimeoutMs: 50 });
  await h.start();
  const t = await h.openThread(null, bind("/r1"));
  srv(f, 1).exitOnKill = false;
  await assert.rejects(h.openThread(t, bind("/r2")), /Codex did not stop/);
  assert.equal(h.state().state, "failed");
  assert.equal(f.servers.some((s) => s.methods().includes("thread/resume")), false);
});

test("root move: a security stop during the exit wait ends the move: no new spawn, no grant, no thread/resume (review I1)", async () => {
  const { h, f, broker } = host();
  await h.start();
  const t = await h.openThread(null, bind("/r1"));
  srv(f, 1).exitOnKill = false;
  const move = h.openThread(t, bind("/r2")).catch((e: unknown) => e);
  await tick(20);
  broker.emit({ type: "refused", reason: "SYNTHETIC" });
  assert.match(detail(h.state()), /Security check failed: an unknown program/);
  const servers = f.servers.length;
  const grants = broker.grants.length;
  srv(f, 1).exit("killed");
  const r = await move;
  assert.equal(r instanceof HostNotReadyError, true, String(r));
  assert.equal(f.servers.length, servers, "nothing spawned after the stop");
  assert.equal(broker.grants.length, grants, "no grant after the stop");
  assert.equal(f.servers.some((s) => s.methods().includes("thread/resume")), false);
  assert.match(detail(h.state()), /Security check failed: an unknown program/, "the latched detail stays");
});

test("a process whose spawn races a stop is never used, and nothing is spawned once the host has stopped (review I1)", async () => {
  const { h, f } = host();
  await h.start();
  await h.stop();
  await assert.rejects(h.openThread(null, bind("/r1")), HostNotReadyError);
  assert.equal(f.servers.length, 1, "only the base from start()");
});

test("all opens are serialised: a move to the base never closes a root process under a bound open in flight (review I2)", async () => {
  const { h, f } = host();
  await h.start();
  const x = await h.openThread(null, bind("/r1"));
  const w = h.openThread(null, bind("/r1")).catch((e: unknown) => e);
  const m = h.openThread(x, null).catch((e: unknown) => e);
  const [wr, mr] = await Promise.all([w, m]);
  assert.equal(typeof wr, "string", `bound open: ${String(wr)}`);
  // The move waited for W, so W's thread is a sibling on /r1 when the move closes that process: it is unloaded with it.
  assert.equal(mr, x);
  assert.equal(h.state().state, "ready");
  assert.equal(srv(f, 1).killed, true);
  assert.equal(srv(f, 0).last("thread/resume").threadId, x);
});

test("all opens are serialised: a move off the base never closes it under an unbound open in flight (review I2)", async () => {
  const { h, f } = host();
  await h.start();
  const x = await h.openThread(null, null); // in the base
  const w = h.openThread(null, null).catch((e: unknown) => e);
  const m = h.openThread(x, bind("/r1")).catch((e: unknown) => e);
  const [wr, mr] = await Promise.all([w, m]);
  assert.equal(typeof wr, "string", `unbound open: ${String(wr)}`);
  assert.equal(mr, x);
  assert.equal(h.state().state, "ready");
  assert.equal(srv(f, 0).killed, true);
});

test("root move from the base process closes it; auth() spawns a new base on demand", async () => {
  const { h, f } = host();
  await h.start();
  const t = await h.openThread(null, null); // in the base process
  await h.openThread(t, bind("/r1"));
  assert.equal(srv(f, 0).killed, true);
  assert.equal(srv(f, 1).last("thread/resume").threadId, t);
  assert.deepEqual(await h.auth(), { state: "signed_in", planType: "plus" });
  assert.equal(f.servers.length, 3, "a new base process");
  assert.ok(srv(f, 2).methods().includes("account/read"));
  assert.equal(h.state().state, "ready");
});

test("a thread response that fails a check fails the host: instruction files, an unchecked model, extra tools", async () => {
  const resp = (p: any, extra: Record<string, unknown>) => ({ thread: { id: "t" }, model: FAKE_MODEL, cwd: p.cwd, instructionSources: [], approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: { type: "readOnly" }, ...extra });
  const instr = host({ handlers: withHandler("thread/start", (p) => resp(p, { instructionSources: ["/r/AGENTS.md"] })) });
  await instr.h.start();
  await assert.rejects(instr.h.openThread(null, null), SecurityCheckError);
  assert.equal(instr.h.state().state, "failed");
  const model = host({ handlers: withHandler("thread/start", (p) => resp(p, { model: "gpt-unchecked" })) });
  await model.h.start();
  await assert.rejects(model.h.openThread(null, null), /model/);
  const tools = host({ handlers: withHandler("mcpServerStatus/list", (p) => ({ data: [{ name: "companion-readonly", tools: p?.threadId ? { read_file: {}, write_file: {} } : {} }], nextCursor: null })) });
  await tools.h.start();
  await assert.rejects(tools.h.openThread(null, bind("/r")), /write_file/);
  assert.equal(tools.broker.grants[0]?.revoked, true);
});

test("a refused relay connection or a replaced socket stops everything and revokes every token", async () => {
  for (const ev of [{ type: "refused", reason: "bad proof" }, { type: "socketReplaced" }] as const) {
    const { h, f, broker, events } = host();
    await h.start();
    await h.openThread(null, bind("/r1"));
    broker.emit(ev);
    assert.match(detail(h.state()), /Security check failed/);
    assert.equal(broker.grants[0]?.revoked, true);
    assert.ok(f.servers.every((s) => s.killed));
    assert.ok(events.some((e) => e.type === "alert" && e.kind === "process"));
  }
});

test("a validator violation stops everything; a binding that ended is rebound before the next turn", async () => {
  const v = host();
  await v.h.start();
  await v.h.openThread(null, bind("/r1"));
  v.broker.emit({ type: "closed", grantId: v.broker.grants[0]?.id ?? "", end: "violation" });
  assert.match(detail(v.h.state()), /Security check failed/);

  const { h, f, broker } = host();
  await h.start();
  const t = await h.openThread(null, bind("/r1"));
  broker.emit({ type: "closed", grantId: broker.grants[0]?.id ?? "", end: "jail" });
  assert.equal(h.state().state, "ready");
  await h.startTurn(t, "again");
  assert.deepEqual(srv(f, 1).methods().slice(-5), ["thread/unsubscribe", "config/read", "thread/resume", "mcpServerStatus/list", "turn/start"]);
  assert.equal(broker.grants.length, 2);
  assert.equal(srv(f, 1).last("thread/resume").config[`${SRV}.env`].CGC_RELAY_TOKEN, broker.grants[1]?.token);
});

test("turns: input shape, deltas, completion, busy", async () => {
  const { h, f, events } = host();
  await h.start();
  const t = await h.openThread(null, null);
  const { turnId } = await h.startTurn(t, "hello");
  assert.deepEqual(srv(f, 0).last("turn/start"), { threadId: t, input: [{ type: "text", text: "hello", text_elements: [] }] });
  await assert.rejects(h.startTurn(t, "again"), TurnBusyError);
  srv(f, 0).notify("item/agentMessage/delta", { threadId: t, turnId, itemId: "i1", delta: "Hi" });
  srv(f, 0).notify("turn/completed", { threadId: t, turn: { id: turnId, status: "completed", items: [], error: null } });
  await tick();
  assert.deepEqual(events.filter((e) => e.type === "delta"), [{ type: "delta", threadId: t, turnId, itemId: "i1", text: "Hi" }]);
  assert.deepEqual(events.find((e) => e.type === "turnCompleted"), { type: "turnCompleted", threadId: t, turnId, status: "completed", error: null });
  assert.equal(h.activeTurn(t), null);
});

test("the guard and the server-request replies are wired in each root's process", async () => {
  const { h, f, events } = host();
  await h.start();
  const t = await h.openThread(null, bind("/r"));
  const root = srv(f, 1);
  const { turnId } = await h.startTurn(t, "x");
  root.notify("item/started", { threadId: t, turnId, item: { type: "collabAgentToolCall", id: "c1" }, startedAtMs: 1 });
  await tick();
  assert.deepEqual(root.last("turn/interrupt"), { threadId: t, turnId });
  assert.ok(events.some((e) => e.type === "alert" && e.kind === "guard"));
  const decline = await root.request("item/fileChange/requestApproval", { threadId: t, turnId, itemId: "f1" });
  assert.deepEqual(decline.result, { decision: "decline" });
  root.notify("item/started", { threadId: t, turnId, item: { type: "mcpToolCall", id: "m1", server: "companion-readonly", tool: "read_file" }, startedAtMs: 1 });
  await tick();
  const accept = await root.request("mcpServer/elicitation/request", { threadId: t, turnId, serverName: "companion-readonly", mode: "form", message: "?", requestedSchema: {}, _meta: { codex_approval_kind: "mcp_tool_call", call_id: "m1" } });
  assert.deepEqual(accept.result, { action: "accept", content: null, _meta: null });
});

test("an app-server exit fails the host and revokes its tokens; start() retries", async () => {
  const { h, f, broker } = host();
  await h.start();
  await h.openThread(null, bind("/r1"));
  srv(f, 1).exit("exit 1");
  await tick();
  assert.equal(h.state().state, "failed");
  assert.equal(broker.grants[0]?.revoked, true);
  assert.equal((await h.start()).state, "ready");
  assert.equal(f.servers.length, 3);
});

test("auth: signed in, unsupported mode, signed out, https login link only", async () => {
  const { h } = host();
  await h.start();
  assert.deepEqual(await h.auth(), { state: "signed_in", planType: "plus" });
  assert.deepEqual(await h.login(), { authUrl: "https://auth.example/start" });
  const k = host({ handlers: withHandler("account/read", () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: true })) });
  await k.h.start();
  assert.deepEqual(await k.h.auth(), { state: "unsupported", mode: "apiKey" });
  const n = host({ handlers: withHandler("account/read", () => ({ account: null, requiresOpenaiAuth: true })) });
  await n.h.start();
  assert.deepEqual(await n.h.auth(), { state: "signed_out" });
  const bad = host({ handlers: withHandler("account/login/start", () => ({ type: "chatgpt", loginId: "l", authUrl: "http://x" })) });
  await bad.h.start();
  await assert.rejects(bad.h.login());
});

test("at most maxProcesses root processes: the least recently used idle one closes and its tokens are revoked", async () => {
  const { h, f, broker } = host({ maxProcesses: 2 });
  await h.start();
  const t1 = await h.openThread(null, bind("/r1"));
  await h.openThread(null, bind("/r2"));
  await h.openThread(null, bind("/r3"));
  assert.equal(srv(f, 1).killed, true);
  assert.deepEqual(srv(f, 1).last("thread/unsubscribe"), { threadId: t1 });
  assert.equal(broker.grants[0]?.revoked, true);
  assert.equal(f.servers.length, 4);
  await assert.rejects(h.startTurn(t1, "x"), /not open/);
});

test("a security stop is sticky: start() stays failed until clearSecurityStop, then restarts an unhealthy broker (I-1)", async () => {
  for (const ev of [{ type: "refused", reason: "bad proof" }, { type: "socketReplaced" }, { type: "closed", grantId: "g1", end: "violation" }] as const) {
    const { h, f, broker } = host();
    await h.start();
    await h.openThread(null, bind("/r1"));
    if (ev.type === "socketReplaced") broker.isHealthy = false;
    broker.emit(ev);
    const before = f.servers.length;
    assert.match(detail(await h.start()), /Security check failed/);
    assert.equal(f.servers.length, before, "no new process while the stop is latched");
    h.clearSecurityStop();
    if (ev.type === "socketReplaced") {
      broker.restartFails = true;
      assert.equal((await h.start()).state, "failed", "the broker could not restart");
      assert.equal(f.servers.some((s) => s.methods().includes("thread/start") && s !== f.servers[1]), false);
      broker.restartFails = false;
    }
    assert.equal((await h.start()).state, "ready");
    assert.equal(broker.restarts, ev.type === "socketReplaced" ? 2 : 0);
  }
});

test("a security event while start() is waiting is not overwritten by ready (I-1)", async () => {
  const { h, f, broker } = host();
  broker.isHealthy = false;
  const restart = broker.restart.bind(broker);
  broker.restart = async () => {
    await restart();
    broker.emit({ type: "refused", reason: "bad proof" }); // arrives while start() awaits the restart
  };
  assert.match(detail(await h.start()), /Security check failed/);
  assert.equal(f.servers.length, 0, "no process after the stop");
  assert.match(detail(await h.start()), /Security check failed/, "still latched");
});

test("a security event during the base process's self-check leaves the latched detail (review fix 2)", async () => {
  const hold: { broker?: FakeBroker } = {};
  let fired = false;
  const { h, broker, events } = host({
    handlers: withHandler("experimentalFeature/list", (p, fake) => {
      if (!fired) {
        fired = true;
        hold.broker?.emit({ type: "refused", reason: "bad proof" });
      }
      return goodHandlers()["experimentalFeature/list"]?.(p, fake);
    }),
  });
  hold.broker = broker;
  assert.match(detail(await h.start()), /^Security check failed: an unknown program/);
  assert.equal(events.some((e) => e.type === "host" && e.state.state === "ready"), false);
});

test("a failure that is not a security check shows a fixed text and the error's name, never its message (review fix 5)", async () => {
  const { h, broker } = host();
  broker.isHealthy = false;
  broker.restartFails = true; // its message says SYNTHETIC
  assert.equal(detail(await h.start()), "Codex stopped (Error)");
  const x = host();
  await x.h.start();
  srv(x.f, 0).exit("exit 1");
  await tick();
  assert.equal(detail(x.h.state()), "Codex stopped (Error)");
});

test("an unbound open racing a bound open of the same id never orphans the live grant (review fix 1)", async () => {
  const hold: { h?: CodexHost; p?: Promise<string> } = {};
  const { h, broker } = host({
    handlers: withHandler("thread/resume", (p, fake) => {
      // Arrives while the bound open of ext-1 waits for its thread/resume reply.
      if (p.threadId === "ext-1" && !hold.p && p.config[`${SRV}.env`]?.CGC_RELAY_TOKEN) hold.p = hold.h?.openThread("ext-1", null);
      return goodHandlers()["thread/resume"]?.(p, fake);
    }),
  });
  hold.h = h;
  await h.start();
  assert.equal(await h.openThread("ext-1", bind("/r2")), "ext-1");
  assert.equal(await hold.p, "ext-1");
  assert.equal(broker.live(), 0, "the bound state was ended before the unbound one replaced it");
  await h.closeThread("ext-1");
  assert.equal(broker.live(), 0);
  assert.equal(h.state().state, "ready");
});

test("a close during an in-flight bound open of the same id leaves no live grant or binding (final review I-2)", async () => {
  const hold: { h?: CodexHost; c?: Promise<void> } = {};
  const { h, f, broker } = host({
    handlers: withHandler("thread/resume", (p, fake) => {
      // Arrives while the bound open of ext-1 waits for its thread/resume reply.
      if (p.threadId === "ext-1" && !hold.c) hold.c = hold.h?.closeThread("ext-1");
      return goodHandlers()["thread/resume"]?.(p, fake);
    }),
  });
  hold.h = h;
  await h.start();
  assert.equal(await h.openThread("ext-1", bind("/r2")), "ext-1");
  await hold.c;
  assert.equal(broker.grants.length, 1);
  assert.equal(broker.live(), 0, "the grant of the open is revoked by the close that waited for it");
  assert.equal(srv(f, 1).last("thread/unsubscribe")?.threadId, "ext-1");
  await assert.rejects(h.startTurn("ext-1", "hi"), /not open/);
  assert.equal(h.state().state, "ready");
});

test("a thread/resume that answers for another thread id fails the host and revokes the grant (final review m5)", async () => {
  const { h, broker } = host({
    handlers: withHandler("thread/resume", (p, fake) => goodHandlers()["thread/resume"]?.({ ...p, threadId: "ext-other" }, fake)),
  });
  await h.start();
  await assert.rejects(h.openThread("ext-1", bind("/r1")), SecurityCheckError);
  assert.equal(broker.live(), 0);
  assert.match(detail(h.state()), /Security check failed: app-server resumed a different thread/);
  await assert.rejects(h.startTurn("ext-other", "hi"), HostNotReadyError);
});

test("stop() during a held initialize: the process is closed and never used (final review m7)", async () => {
  const hold: { h?: CodexHost } = {};
  const { h, f } = host({
    handlers: withHandler("initialize", (p, fake) => {
      fake.exitOnKill = false; // a process slow to die: only the host's own checks keep it unused
      void hold.h?.stop();
      return goodHandlers().initialize?.(p, fake);
    }),
  });
  hold.h = h;
  const s = await h.start();
  assert.notEqual(s.state, "ready");
  assert.equal(srv(f, 0).killed, true);
  assert.deepEqual(srv(f, 0).methods(), ["initialize"], "no initialized, no config/read: never used after the stop");
  await assert.rejects(h.openThread(null, null), HostNotReadyError);
  assert.equal(f.servers.length, 1, "nothing spawned after the stop");
});

test("two turns after a binding ended: one rebinds and starts, the other is busy (review fix 4)", async () => {
  const { h, f, broker } = host();
  await h.start();
  const t = await h.openThread(null, bind("/r1"));
  broker.emit({ type: "closed", grantId: broker.grants[0]?.id ?? "", end: "jail" });
  const r = await Promise.allSettled([h.startTurn(t, "a"), h.startTurn(t, "b")]);
  assert.deepEqual(r.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.ok(r.some((x) => x.status === "rejected" && x.reason instanceof TurnBusyError));
  assert.equal(srv(f, 1).methods().filter((m) => m === "turn/start").length, 1);
  assert.equal(broker.grants.length, 2, "one rebind");
});

test("an RPC error reply to thread/resume itself revokes the grant and rethrows; the host stays ready (I-4 partial)", async () => {
  const { h, broker } = host({ handlers: withHandler("thread/resume", () => { throw { code: -32600, message: "SYNTHETIC no such thread" }; }) });
  await h.start();
  await assert.rejects(h.openThread("missing", bind("/r1")), /SYNTHETIC/);
  assert.equal(h.state().state, "ready");
  assert.equal(broker.grants[0]?.revoked, true);
});

test("an open during the sign-in replacement waits for the new base's self-check (review fix 3)", async () => {
  const hold: { h?: CodexHost; loggedIn: boolean; p?: Promise<unknown> } = { loggedIn: false };
  const { h, f, events } = host({
    handlers: withHandler("experimentalFeature/list", (p, fake) => {
      if (hold.loggedIn && !hold.p) hold.p = hold.h?.openThread(null, null).catch((e: unknown) => e);
      return goodHandlers()["experimentalFeature/list"]?.(p, fake);
    }),
  });
  hold.h = h;
  await h.start();
  await h.login();
  const login = f.servers.find((s) => s.launch.args[1] === LOGIN_PROFILE) as FakeAppServer;
  hold.loggedIn = true;
  login.notify("account/login/completed", { loginId: "l1", success: true, error: null });
  for (let i = 0; i < 50 && !events.some((e) => e.type === "auth"); i++) await tick();
  assert.equal(typeof (await hold.p), "string");
  const m = (f.servers.at(-1) as FakeAppServer).methods().filter((x) => x !== "account/read"); // the auth event's read
  assert.deepEqual(m.slice(m.indexOf("experimentalFeature/list") + 1), ["mcpServerStatus/list", "config/read", "thread/start", "mcpServerStatus/list"]);
  assert.equal(h.state().state, "ready");
});

test("validator ends: error stops everything; jail ends rebind at most 3 times in 10 minutes (I-2)", async () => {
  const e = host();
  await e.h.start();
  await e.h.openThread(null, bind("/r1"));
  e.broker.emit({ type: "closed", grantId: e.broker.grants[0]?.id ?? "", end: "error" });
  assert.match(detail(e.h.state()), /Security check failed/);

  const { h, broker } = host();
  await h.start();
  const t = await h.openThread(null, bind("/r1"));
  for (let i = 0; i < 3; i++) {
    broker.emit({ type: "closed", grantId: broker.grants.at(-1)?.id ?? "", end: "jail" });
    assert.equal(h.state().state, "ready", `rebind ${i + 1}`);
    await h.openThread(t, bind("/r1"));
  }
  broker.emit({ type: "closed", grantId: broker.grants.at(-1)?.id ?? "", end: "jail" });
  assert.match(detail(h.state()), /Security check failed/);

  // A relay that vanished mid-handshake ("dropped", N-5) is rebound, not a stop.
  const d = host();
  await d.h.start();
  const td = await d.h.openThread(null, bind("/r1"));
  d.broker.emit({ type: "closed", grantId: d.broker.grants[0]?.id ?? "", end: "dropped" });
  assert.equal(d.h.state().state, "ready");
  await d.h.openThread(td, bind("/r1"));
  assert.equal(d.broker.grants.length, 2);
});

test("capacity limits reject the call with HostBusyError and keep the host ready (N-1)", async () => {
  const { h } = host({ maxProcesses: 1 });
  await h.start();
  const t = await h.openThread(null, bind("/r1"));
  await h.startTurn(t, "busy"); // the only root process now has a running turn
  await assert.rejects(h.openThread(null, bind("/r2")), HostBusyError);
  assert.equal(h.state().state, "ready");
  const b = host({ maxBindings: 1 });
  await b.h.start();
  const tb = await b.h.openThread(null, bind("/r1"));
  await b.h.startTurn(tb, "busy");
  await assert.rejects(b.h.openThread(null, bind("/r1")), HostBusyError);
  assert.equal(b.h.state().state, "ready");
});

test("a config layer that appears after the process started fails the next thread (N-4)", async () => {
  let calls = 0;
  const { h, paths } = host({
    handlers: withHandler("config/read", (p, fake) => {
      const r = goodHandlers()["config/read"]?.(p, fake) as any;
      if (++calls > 1) r.layers.push({ name: { type: "user", file: path.join(paths.codexHome, "extra.toml"), profile: null }, version: "1", config: {}, disabledReason: null });
      return r;
    }),
  });
  assert.equal((await h.start()).state, "ready");
  await assert.rejects(h.openThread(null, null), /unexpected user config layer/);
  assert.match(detail(h.state()), /Security check failed/);
});

test("a successful sign-in replaces every running process before the auth event (N-2)", async () => {
  const { h, f, events, broker } = host();
  await h.start();
  const t = await h.openThread(null, bind("/r1"));
  await h.login();
  const login = f.servers.find((s) => s.launch.args[1] === LOGIN_PROFILE) as FakeAppServer;
  const before = f.servers.filter((s) => s !== login);
  login.notify("account/login/completed", { loginId: "l1", success: true, error: null });
  for (let i = 0; i < 50 && !events.some((e) => e.type === "auth"); i++) await tick();
  assert.ok(before.every((s) => s.killed), "base and root processes were replaced");
  assert.equal(broker.grants[0]?.revoked, true);
  const fresh = f.servers.at(-1) as FakeAppServer;
  assert.ok(!before.includes(fresh) && fresh !== login && fresh.methods().includes("config/read"), "a new, self-checked base process");
  assert.ok(events.some((e) => e.type === "auth"));
  assert.equal(h.state().state, "ready");
  await assert.rejects(h.startTurn(t, "x"), /not open/);
});

test("17 bound threads in a row never trip the acceptor's cap: the oldest idle binding is closed first (I-3)", async () => {
  const { h, broker, events } = host({ maxProcesses: 3 });
  await h.start();
  const ids: string[] = [];
  for (let i = 0; i < 17; i++) ids.push(await h.openThread(null, bind(`/r${i % 3}`)));
  assert.equal(h.state().state, "ready");
  assert.equal(events.some((e) => e.type === "alert" && /Security check failed/.test(e.detail)), false);
  assert.ok(broker.live() <= 12, `live bindings: ${broker.live()}`);
  await h.closeThread(ids[16] ?? "");
  assert.equal(broker.grants.at(-1)?.revoked, true);
  await assert.rejects(h.startTurn(ids[16] ?? "", "x"), /not open/);
});

test("a check that throws fails the host and revokes the token (I-4)", async () => {
  const { h, broker } = host({ handlers: withHandler("mcpServerStatus/list", (p) => { if (p?.threadId) throw { code: -32000, message: "SYNTHETIC" }; return { data: [], nextCursor: null }; }) });
  await h.start();
  await assert.rejects(h.openThread(null, bind("/r1")));
  assert.match(detail(h.state()), /Security check failed/);
  assert.equal(broker.grants[0]?.revoked, true);
});

test("a protected file changed after the start fails the next spawn or thread (I-5)", async () => {
  const { h, paths } = host();
  await h.start();
  await h.openThread(null, null);
  fs.appendFileSync(path.join(paths.codexHome, "config.toml"), "web_search = \"live\"\n");
  await assert.rejects(h.openThread(null, bind("/r1")), /config\.toml/);
  assert.match(detail(h.state()), /config\.toml/);
});

test("a turn on a model whose surface was not checked stops everything (M-11)", async () => {
  const { h, f } = host();
  await h.start();
  const t = await h.openThread(null, null);
  const { turnId } = await h.startTurn(t, "x");
  srv(f, 0).notify("turn/started", { threadId: t, turn: { id: turnId, model: "gpt-unchecked", status: "inProgress", items: [] } });
  await tick();
  assert.match(detail(h.state()), /model/);
});

test("sign-in runs in its own process under the sign-in launch and ends on account/login/completed (I-9)", async () => {
  const { h, f, events } = host();
  await h.start();
  assert.deepEqual(await h.login(), { authUrl: "https://auth.example/start" });
  const login = f.servers.find((s) => s.launch.args[1] === LOGIN_PROFILE) as FakeAppServer;
  assert.ok(login, "a separate sign-in process");
  assert.equal(srv(f, 0).methods().includes("account/login/start"), false, "never on the base process");
  login.notify("account/login/completed", { loginId: "l1", success: true, error: null });
  await tick(10);
  assert.equal(login.killed, true);
  assert.ok(events.some((e) => e.type === "auth"));
});

// M6 Task 6: companion-jira is bound per thread through a second relay grant. SYNTHETIC FIXTURE values only.
const JIRA = "mcp_servers.companion-jira";
const jiraBinding = (secret = "SYNTHETIC-SECRET\n") => ({
  launch: { command: "/usr/bin/sandbox-exec", args: ["-p", "(version 1)", "/node", "/c/src/jira/main.ts"], env: { PATH: "/usr/bin:/bin" }, cwd: "/" },
  validator: { command: "/usr/bin/sandbox-exec", args: ["-p", "(version 1)", "/node", "/c/src/relay/validator.ts", "jira_get_issue,jira_search,jira_get_comments"], env: {}, cwd: "/" },
  secret,
});

test("M6: without Jira every thread gets an inert companion-jira override", async () => {
  const { h, f } = host();
  await h.start();
  await h.openThread(null, null);
  const p = f.servers[0]!.lastThreadParams();
  assert.equal(p.config[`${JIRA}.command`], "/usr/bin/false");
});

test("M6: with Jira a thread gets a second grant with the Jira validator and the secret; the secret is never in Codex's params", async () => {
  const { h, f, broker } = host();
  await h.start();
  h.setJira(jiraBinding());
  await h.openThread(null, null);
  const g = broker.grants.find((x) => x.secret !== null)!;
  assert.equal(g.secret, "SYNTHETIC-SECRET\n");
  assert.deepEqual(g.validator?.args.at(-1), "jira_get_issue,jira_search,jira_get_comments");
  const p = f.servers[0]!.lastThreadParams();
  assert.deepEqual(p.config[`${JIRA}.env`], { CGC_RELAY_TOKEN: g.token });
  assert.ok(!JSON.stringify(f.servers.map((s) => s.requests)).includes("SYNTHETIC-SECRET"), "the secret never reaches Codex");
});

test("M6: a root-bound thread with Jira holds two grants; closing it revokes both", async () => {
  const { h, broker } = host();
  await h.start();
  h.setJira(jiraBinding());
  const id = await h.openThread(null, { root: "/r1", launch: jail("/r1") });
  assert.equal(broker.live(), 2);
  await h.closeThread(id);
  assert.equal(broker.live(), 0);
});

test("M6: setJira(null) revokes every Jira grant at once and the next turn reopens without the server", async () => {
  const { h, f, broker } = host();
  await h.start();
  h.setJira(jiraBinding());
  const id = await h.openThread(null, null);
  h.setJira(null);
  assert.equal(broker.grants.filter((g) => g.secret !== null).every((g) => g.revoked), true);
  await h.startTurn(id, "SYNTHETIC question");
  const p = f.servers[0]!.lastThreadParams();
  assert.equal(p.config[`${JIRA}.command`], "/usr/bin/false");
});

test("M6: setting the same Jira binding twice does not churn grants", async () => {
  const { h, broker } = host();
  await h.start();
  h.setJira(jiraBinding());
  await h.openThread(null, null);
  const before = broker.grants.length;
  h.setJira(jiraBinding());
  assert.equal(broker.grants.length, before);
  assert.equal(broker.grants.some((g) => g.revoked), false);
});

test("M6: a Jira binding that ends normally is rebound with the next turn; a violation stops everything", async () => {
  const { h, broker, events } = host();
  await h.start();
  h.setJira(jiraBinding());
  const id = await h.openThread(null, null);
  const g = broker.grants.find((x) => x.secret !== null)!;
  broker.emit({ type: "closed", grantId: g.id, end: "idle" });
  await h.startTurn(id, "SYNTHETIC question");
  assert.equal(broker.grants.filter((x) => x.secret !== null).length, 2, "a fresh Jira grant");
  const g2 = broker.grants.filter((x) => x.secret !== null)[1]!;
  broker.emit({ type: "closed", grantId: g2.id, end: "violation" });
  assert.equal(h.state().state, "failed");
  assert.ok(events.some((e: any) => e.type === "alert" && /Security check failed/.test(e.detail)));
});

test("M6: a thread whose Jira server lists a write tool fails the self-check", async () => {
  const { h } = host({ jiraTools: ["jira_get_issue", "jira_search", "jira_get_comments", "createJiraIssue"] });
  await h.start();
  h.setJira(jiraBinding());
  await assert.rejects(h.openThread(null, null));
  assert.equal(h.state().state, "failed");
});

test("M6: live grants, not bound threads, count against the binding cap", async () => {
  const { h, broker } = host({ maxBindings: 4 });
  await h.start();
  h.setJira(jiraBinding());
  await h.openThread(null, { root: "/r1", launch: jail("/r1") });
  await h.openThread(null, { root: "/r2", launch: jail("/r2") });
  await h.openThread(null, { root: "/r3", launch: jail("/r3") }); // 6 would exceed 4: the oldest idle thread is closed
  assert.ok(broker.live() <= 4);
});

test("M6: a Jira binding that ends says so in its alert, never with the secret, and the readonly binding stays", async () => {
  const { h, broker, events } = host();
  await h.start();
  h.setJira(jiraBinding());
  await h.openThread(null, bind("/r1"));
  const g = broker.grants.find((x) => x.secret !== null)!;
  broker.emit({ type: "closed", grantId: g.id, end: "idle" });
  assert.equal(h.state().state, "ready");
  assert.ok(events.some((e) => e.type === "alert" && e.detail === "The Jira tools stopped. They restart with the next message."));
  assert.equal(broker.grants.find((x) => x.secret === null)?.revoked, false, "the readonly grant is untouched until the rebind");
  assert.ok(!JSON.stringify(events).includes("SYNTHETIC-SECRET"));
});

test("M6: an unbound thread with Jira asks Codex for companion-jira by name; without Jira it never does", async () => {
  const a = host();
  await a.h.start();
  await a.h.openThread(null, null);
  assert.equal(srv(a.f, 0).received.some((m) => m.method === "mcpServerStatus/list" && m.params?.serverName === "companion-jira"), false);
  const b = host();
  await b.h.start();
  b.h.setJira(jiraBinding());
  await b.h.openThread(null, null);
  assert.equal(srv(b.f, 0).received.some((m) => m.method === "mcpServerStatus/list" && m.params?.serverName === "companion-jira"), true);
});

test("M6: setJira(null) while an open is in flight revokes that open's Jira grant; the thread rebinds with the next turn", async () => {
  let hostRef: CodexHost | null = null;
  const { h, f, broker } = host({
    handlers: withHandler("thread/start", (p, fake) => {
      hostRef?.setJira(null); // the owner removes Jira after the grant, before Codex answers
      return goodHandlers()["thread/start"]!(p, fake);
    }),
  });
  hostRef = h;
  await h.start();
  h.setJira(jiraBinding());
  const id = await h.openThread(null, null);
  assert.equal(broker.live(), 0, "no Jira grant outlives setJira(null)");
  await h.startTurn(id, "SYNTHETIC question");
  assert.equal(f.servers[0]!.lastThreadParams().config[`${JIRA}.command`], "/usr/bin/false");
});
