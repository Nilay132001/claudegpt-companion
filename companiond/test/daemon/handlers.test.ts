import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { BridgeEvent } from "../../src/bridge/sessionBridge.ts";
import { ChatService } from "../../src/chat/chatService.ts";
import { HostBusyError, TurnBusyError, type HostEvent, type HostState } from "../../src/codex/codexHost.ts";
import { RpcError } from "../../src/codex/rpc.ts";
import { DisabledHost } from "../../src/daemon/disabledHost.ts";
import { ABANDONED_STATUS, buildHandlers, toDaemonError, wireEvents, type DaemonBridge, type DaemonDeps, type DaemonHost } from "../../src/daemon/handlers.ts";
import { DAEMON_PROTOCOL_VERSION, ErrorCodes } from "../../src/daemon/protocol.ts";
import { Privacy } from "../../src/privacy/privacy.ts";
import { Store } from "../../src/store/store.ts";
import { resolved, session } from "../helpers/m4b.ts";
import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);

/** A CodexHost stand-in: ready, with a latch like CodexHost's security stop (M4a I-1). */
class FakeHost implements DaemonHost {
  listeners = new Set<(e: HostEvent) => void>();
  latched: string | null = null;
  cleared = 0;
  starts = 0;
  closed: string[] = [];
  busy = false;
  #state: HostState = { state: "ready", warnings: [] };
  #active = new Map<string, string>();
  #n = 0;
  emit(e: HostEvent): void {
    this.listeners.forEach((l) => l(e));
  }
  set(s: HostState): void {
    this.#state = s;
    this.emit({ type: "host", state: s });
  }
  securityStop(detail: string): void {
    this.latched = detail;
    this.#active.clear();
    this.set({ state: "failed", detail: `Security check failed: ${detail}` });
  }
  signedInAgain(): void {
    this.#active.clear(); // every process replaced, open threads closed
    this.emit({ type: "auth", auth: { state: "signed_in", planType: null } });
  }
  state(): HostState {
    return this.#state;
  }
  async start(): Promise<HostState> {
    this.starts++;
    this.set(this.latched !== null ? { state: "failed", detail: `Security check failed: ${this.latched}` } : { state: "ready", warnings: [] });
    return this.#state;
  }
  async stop(): Promise<void> {
    this.#active.clear();
    this.set({ state: "stopped" });
  }
  clearSecurityStop(): void {
    this.cleared++;
    this.latched = null;
  }
  async auth() {
    return { state: "signed_in" as const, planType: null };
  }
  async login() {
    return { authUrl: "https://auth.example.test/x" };
  }
  async openThread(id: string | null): Promise<string> {
    if (this.busy) throw new HostBusyError("Too many repositories are busy. Wait for a reply to finish.");
    return id ?? `thr-${++this.#n}`;
  }
  async closeThread(id: string): Promise<void> {
    this.closed.push(id);
    this.order?.push(`close:${id}`);
  }
  order: string[] | null = null;
  async startTurn(threadId: string): Promise<{ turnId: string }> {
    const turnId = `turn-${++this.#n}`;
    this.#active.set(threadId, turnId);
    return { turnId };
  }
  async interrupt(_threadId: string): Promise<void> {}
  activeTurn(threadId: string): string | null {
    return this.#active.get(threadId) ?? null;
  }
  on(l: (e: HostEvent) => void): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
}

function deps(o: { host?: DaemonHost; revokeDeadlineMs?: number; log?: (c: string) => void; mode?: "off" | "ask" | "automatic"; inspectable?: boolean; twoRoots?: boolean } = {}) {
  const store = Store.memory();
  const root = tempDir(); // an approved synthetic root (the bridge resolves the session to it)
  store.putApproval({ root, commonDir: `${root}/.git`, includeWorktrees: false, approvedAt: 1 });
  // twoRoots: session s2 is in a second approved root
  const root2 = tempDir();
  if (o.twoRoots) store.putApproval({ root: root2, commonDir: `${root2}/.git`, includeWorktrees: false, approvedAt: 1 });
  const rootOf = (id: string) => (o.twoRoots && id === "s2" ? root2 : root);
  const bridgeListeners = new Set<(e: BridgeEvent) => void>();
  const snap = () => ({ sessions: o.twoRoots ? [session("s1"), session("s2")] : [session("s1")], selection: { sessionId: "s1", via: "focus" as const, focusedSessionId: "s1", focusLabel: "Claude focus (from Claude's records)" as const, focusMovedTo: null, pinnedMissing: false }, desktopRecordsError: null, refreshedAt: 1 });
  const pins: Array<string | null> = [];
  const order: string[] = [];
  const bridge: DaemonBridge = {
    snapshot: snap, refresh: async () => snap(), worktree: (id) => resolved(rootOf(id)), events: () => [], hasUuid: () => false, liveBranch: async () => "main",
    pin: (id) => { pins.push(id); return { ...snap().selection, sessionId: id, via: id ? "pin" : "focus" }; },
    syncStatus: () => ({ state: "live", stats: null, lastPollAt: 1 }),
    resolveNow: async (id) => { order.push(`resolve:${id}`); return resolved(rootOf(id)); },
    on: (l) => { bridgeListeners.add(l); return () => { bridgeListeners.delete(l); }; },
  };
  const host = o.host ?? new DisabledHost("off");
  const privacy = new Privacy(store, { inspect: async (dir) => { if (!o.inspectable) throw new Error("nope"); return { toplevel: dir, gitDir: `${dir}/.git`, commonDir: `${dir}/.git` }; } }, tempDir());
  const chat = new ChatService({
    host, bridge, store, sharingMode: () => privacy.sharingMode(), isApproved: privacy.isApproved,
    launchFor: async (r) => ({ command: "/usr/bin/sandbox-exec", args: ["-p", r], env: {}, cwd: r }),
  });
  let shut = 0;
  if (o.mode) privacy.setSharingMode(o.mode);
  const d: DaemonDeps = { host, bridge, chat, privacy, store, version: "0.4.0", shutdown: () => { shut++; }, revokeDeadlineMs: o.revokeDeadlineMs, log: o.log ?? (() => undefined) };
  return { d, store, pins, root, root2, order, emitBridge: (e: BridgeEvent) => bridgeListeners.forEach((l) => l(e)), shut: () => shut };
}

test("hello checks the protocol version", async () => {
  const h = buildHandlers(deps().d);
  assert.deepEqual(await h["daemon.hello"]!({ protocolVersion: DAEMON_PROTOCOL_VERSION }), { protocolVersion: DAEMON_PROTOCOL_VERSION, daemonVersion: "0.4.0" });
  await assert.rejects(h["daemon.hello"]!({ protocolVersion: 99 }), (e: any) => toDaemonError(e).code === ErrorCodes.invalidRequest);
});

test("pin goes to the bridge and the store", async () => {
  const { d, store, pins } = deps();
  const h = buildHandlers(d);
  await h["sessions.pin"]!({ sessionId: "s1" });
  assert.deepEqual(pins, ["s1"]);
  assert.equal(store.getPin(), "s1");
  await h["sessions.pin"]!({ sessionId: null });
  assert.equal(store.getPin(), null);
  await assert.rejects(h["sessions.pin"]!({ sessionId: 5 }), (e: any) => toDaemonError(e).code === ErrorCodes.invalidParams);
});

test("privacy: get, set mode, refused approval carries its reason", async () => {
  const h = buildHandlers(deps().d);
  const g: any = await h["privacy.get"]!({});
  assert.equal(g.sharingMode, "ask");
  assert.match(g.redactionNotice, /does not guarantee/);
  assert.deepEqual(await h["privacy.setSharingMode"]!({ mode: "off" }), { sharingMode: "off" });
  await assert.rejects(h["privacy.setSharingMode"]!({ mode: "loud" }), (e: any) => toDaemonError(e).code === ErrorCodes.invalidParams);
  await assert.rejects(h["privacy.approve"]!({ root: "relative", includeWorktrees: false }), (e: any) => {
    const d = toDaemonError(e);
    return d.code === ErrorCodes.approvalRefused && (d.data as any).reason === "not_absolute";
  });
});

test("chat errors map to codes; host not ready is reported", async () => {
  const h = buildHandlers(deps().d);
  await assert.rejects(h["chat.prepare"]!({ sessionId: "zz", question: "q" }), (e: any) => toDaemonError(e).code === ErrorCodes.unknownSession);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  await assert.rejects(h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true }), (e: any) => toDaemonError(e).code === ErrorCodes.hostNotReady);
  await assert.rejects(h["chat.send"]!({ prepareId: "x", removeItemIds: [1] }), (e: any) => toDaemonError(e).code === ErrorCodes.invalidParams);
  await assert.rejects(h["auth.status"]!({}), (e: any) => toDaemonError(e).code === ErrorCodes.hostNotReady);
  assert.deepEqual(await h["host.status"]!({}), { state: "failed", detail: "off" });
});

test("HostBusyError is 'try again later', not a failure", async () => {
  const host = new FakeHost();
  host.busy = true;
  const h = buildHandlers(deps({ host }).d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  await assert.rejects(h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true }), (e: any) => toDaemonError(e).code === ErrorCodes.hostBusy);
  assert.equal(host.state().state, "ready");
});

test("a security stop is cleared only by the owner's acknowledgement", async () => {
  const host = new FakeHost();
  const h = buildHandlers(deps({ host }).d);
  await assert.rejects(h["host.acknowledgeSecurityStop"]!({}), (e: any) => toDaemonError(e).code === ErrorCodes.invalidRequest);
  host.securityStop("the repository tools socket was replaced");
  await assert.rejects(h["host.restart"]!({}), (e: any) => toDaemonError(e).code === ErrorCodes.securityCheckFailed); // a restart does not clear the latch
  assert.equal(host.cleared, 0);
  assert.equal(host.starts, 0);
  assert.deepEqual(await h["host.acknowledgeSecurityStop"]!({}), { state: "ready", warnings: [] });
  assert.equal(host.cleared, 1);
});

test("host.restart refuses a security failure that was not latched; only the acknowledgement brings Codex back", async () => {
  const host = new FakeHost();
  const h = buildHandlers(deps({ host }).d);
  host.set({ state: "failed", detail: "Security check failed: the thread's config did not match" }); // not latched
  await assert.rejects(h["host.restart"]!({}), (e: any) => toDaemonError(e).code === ErrorCodes.securityCheckFailed);
  assert.equal(host.starts, 0);
  assert.equal(host.state().state, "failed");
  assert.deepEqual(await h["host.acknowledgeSecurityStop"]!({}), { state: "ready", warnings: [] });
  // any other failure can still be restarted
  host.set({ state: "failed", detail: "Codex exited." });
  assert.deepEqual(await h["host.restart"]!({}), { state: "ready", warnings: [] });
});

test("events: bridge and host events become notifications, chat events carry the session id", () => {
  const { d, store, emitBridge } = deps({ host: new FakeHost() });
  const host = d.host as FakeHost;
  const got: Array<[string, any]> = [];
  wireEvents(d, (m, p) => got.push([m, p]));
  store.setThread("s1", "thr-1");
  emitBridge({ type: "worktree", sessionId: "s1", resolution: resolved("/r"), change: { from: "/a", to: "/r", banner: "Claude is now in /r (main)", contextNote: "Repository changed from /a to /r" } });
  host.emit({ type: "delta", threadId: "thr-1", turnId: "u1", itemId: "i1", text: "Hi" });
  host.emit({ type: "alert", threadId: "thr-1", turnId: "u1", kind: "guard", detail: "Codex started a commandExecution item" });
  host.emit({ type: "host", state: { state: "starting" } });
  assert.deepEqual(got.map(([m]) => m), ["session.worktree", "chat.delta", "security.alert", "host.changed"]);
  assert.equal(got[1]?.[1].sessionId, "s1");
  assert.equal(got[2]?.[1].sessionId, "s1");
});

test("after a sign-in replaced every process, the running turn is reported as abandoned", async () => {
  const x = deps({ host: new FakeHost() });
  const host = x.d.host as FakeHost;
  const got: Array<[string, any]> = [];
  wireEvents(x.d, (m, p) => got.push([m, p]));
  const h = buildHandlers(x.d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  const s: any = await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true });
  host.signedInAgain();
  assert.deepEqual(got.map(([m]) => m), ["auth.changed", "chat.turnCompleted"]);
  assert.deepEqual({ ...got[1]?.[1], error: null }, { sessionId: "s1", threadId: s.threadId, turnId: s.turnId, status: ABANDONED_STATUS, error: null });
  assert.equal(x.store.getCursor("s1"), null);
});

test("chat.prepare sends the preview without raw subagent updates or the cursor; a stale prepare has its own code", async () => {
  const x = deps({ host: new FakeHost() });
  const h = buildHandlers(x.d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  assert.deepEqual(Object.keys(p.preview).sort(), ["bytes", "items", "notes", "omitted"]);
  assert.equal(p.repo.state, "bound");
  await h["privacy.setSharingMode"]!({ mode: "off" });
  await assert.rejects(h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true }), (e: any) => toDaemonError(e).code === ErrorCodes.prepareStale);
});

test("a refused resume is reported as chat.threadReplaced", async () => {
  const host = new FakeHost();
  const x = deps({ host });
  const got: Array<[string, any]> = [];
  wireEvents(x.d, (m, p) => got.push([m, p]));
  x.store.setThread("s1", "thr-old");
  host.openThread = async (id: string | null) => {
    if (id) throw new RpcError({ code: -32000, message: "thread already has an active writer" });
    return "thr-new";
  };
  const h = buildHandlers(x.d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true });
  assert.deepEqual(got.filter(([m]) => m === "chat.threadReplaced"), [["chat.threadReplaced", { sessionId: "s1", threadId: "thr-new", reason: "resume_refused" }]]);
});

test("thread end: a session that leaves the list and a revoked approval close threads", async () => {
  const x = deps({ host: new FakeHost() });
  const host = x.d.host as FakeHost;
  host.order = x.order;
  wireEvents(x.d, () => undefined);
  const h = buildHandlers(x.d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  const s: any = await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true });
  host.emit({ type: "turnCompleted", threadId: s.threadId, turnId: s.turnId, status: "completed", error: null });
  await h["privacy.revoke"]!({ root: x.root });
  assert.deepEqual(host.closed, [s.threadId]);
  assert.deepEqual(x.order, ["resolve:s1", `close:${s.threadId}`]); // re-resolved before the close
  assert.equal(((await h["chat.prepare"]!({ sessionId: "s1", question: "q" })) as any).repo.state, "unavailable");
  const p2: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  const s2: any = await h["chat.send"]!({ prepareId: p2.prepareId, removeItemIds: [], confirmed: true });
  host.emit({ type: "turnCompleted", threadId: s2.threadId, turnId: s2.turnId, status: "completed", error: null });
  x.emitBridge({ type: "sessions", snapshot: { ...x.d.bridge.snapshot(), sessions: [] } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(host.closed, [s.threadId, s.threadId]);
});

test("Ask mode: a send without confirmation is refused and sends nothing; confirmed sends; Automatic needs no flag", async () => {
  const host = new FakeHost();
  let turns = 0;
  const start = host.startTurn.bind(host);
  host.startTurn = async (t: string) => { turns++; return start(t); };
  const h = buildHandlers(deps({ host }).d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  assert.equal(p.needsConfirm, true);
  for (const params of [{ prepareId: p.prepareId, removeItemIds: [] }, { prepareId: p.prepareId, removeItemIds: [], confirmed: false }]) {
    await assert.rejects(h["chat.send"]!(params), (e: any) => toDaemonError(e).code === ErrorCodes.confirmRequired);
  }
  assert.equal(turns, 0);
  await assert.rejects(h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: "yes" }), (e: any) => toDaemonError(e).code === ErrorCodes.invalidParams);
  assert.ok(await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true })); // the prepare was not used up
  assert.equal(turns, 1);

  const auto = new FakeHost();
  const ha = buildHandlers(deps({ host: auto, mode: "automatic" }).d);
  const pa: any = await ha["chat.prepare"]!({ sessionId: "s1", question: "q" });
  assert.equal(pa.needsConfirm, false);
  assert.ok(await ha["chat.send"]!({ prepareId: pa.prepareId, removeItemIds: [] }));
});

test("revoke: a failing close is reported as pendingClose with a short stderr code", async () => {
  const host = new FakeHost();
  const logs: string[] = [];
  const x = deps({ host, log: (c) => logs.push(c), revokeDeadlineMs: 60_000 });
  const h = buildHandlers(x.d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  const s: any = await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true });
  host.emit({ type: "turnCompleted", threadId: s.threadId, turnId: s.turnId, status: "completed", error: null });
  host.closeThread = async () => { throw new Error("/private/secret/path leaked"); };
  const r: any = await h["privacy.revoke"]!({ root: x.root });
  assert.equal(r.pendingClose, 1);
  assert.deepEqual(logs, ["revoke_close_failed"]);
  assert.equal(host.starts, 0); // the deadline is far away
});

test("revoke: a thread whose reply is stuck keeps its grant only until the deadline, then the host is restarted", async () => {
  const host = new FakeHost();
  const logs: string[] = [];
  const x = deps({ host, log: (c) => logs.push(c), revokeDeadlineMs: 20 });
  const h = buildHandlers(x.d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true });
  host.closeThread = async () => { throw new TurnBusyError(); }; // a reply is running; the interrupt never ends it
  const r: any = await h["privacy.revoke"]!({ root: x.root });
  assert.equal(r.pendingClose, 1);
  assert.equal(host.starts, 0);
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(host.starts, 1);
  assert.equal(host.state().state, "ready");
  assert.ok(logs.includes("revoke_forced_restart"));
});

test("an unknown prepare in Ask mode is refused without confirmation (fails closed)", async () => {
  const x = deps({ host: new FakeHost() });
  const h = buildHandlers(x.d);
  await assert.rejects(h["chat.send"]!({ prepareId: "evicted-or-never-made", removeItemIds: [] }), (e: any) => toDaemonError(e).code === ErrorCodes.confirmRequired);
  // with the flag it reaches ChatService, which reports the prepare as expired
  await assert.rejects(h["chat.send"]!({ prepareId: "evicted-or-never-made", removeItemIds: [], confirmed: true }), (e: any) => toDaemonError(e).code === ErrorCodes.prepareExpired);
});

test("revoke: a new thread opened in the window does not trigger the restart; the threads that were stuck closing do not either", async () => {
  const host = new FakeHost();
  const logs: string[] = [];
  const x = deps({ host, log: (c) => logs.push(c), revokeDeadlineMs: 40, inspectable: true });
  const h = buildHandlers(x.d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true });
  const realClose = host.closeThread.bind(host);
  host.closeThread = async () => { throw new TurnBusyError(); };
  assert.equal(((await h["privacy.revoke"]!({ root: x.root })) as any).pendingClose, 1);
  // the stuck reply ends and its thread closes; the owner approves again and a new thread opens on that root
  host.closeThread = realClose;
  await x.d.chat.closeSession("s1");
  await h["privacy.approve"]!({ root: x.root, includeWorktrees: false });
  host.openThread = async () => "thr-other";
  const p2: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  await h["chat.send"]!({ prepareId: p2.prepareId, removeItemIds: [], confirmed: true });
  assert.deepEqual(x.d.chat.revokedThreadIds(), []); // thr-other is on a root that is approved again
  assert.deepEqual(x.d.chat.openSessions(), ["s1"]);
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(host.starts, 0);
  assert.deepEqual(logs, []);
});

test("revoke: the timer does not stop or start a host that is not ready", async () => {
  const host = new FakeHost();
  const logs: string[] = [];
  const x = deps({ host, log: (c) => logs.push(c), revokeDeadlineMs: 20 });
  const h = buildHandlers(x.d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true });
  host.closeThread = async () => { throw new TurnBusyError(); };
  await h["privacy.revoke"]!({ root: x.root });
  host.set({ state: "starting" });
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(host.starts, 0);
  assert.equal(host.state().state, "starting");
  assert.deepEqual(logs, ["revoke_restart_skipped"]);
});

test("revoke: no restart when the threads closed", async () => {
  const host = new FakeHost();
  const x = deps({ host, revokeDeadlineMs: 10 });
  const h = buildHandlers(x.d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  const s: any = await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [], confirmed: true });
  host.emit({ type: "turnCompleted", threadId: s.threadId, turnId: s.turnId, status: "completed", error: null });
  const r: any = await h["privacy.revoke"]!({ root: x.root });
  assert.equal(r.pendingClose, 0);
  await new Promise((res) => setTimeout(res, 40));
  assert.equal(host.starts, 0);
});

test("revoke: revoking repo A leaves a running reply in approved repo B untouched and never restarts because of it", async () => {
  const host = new FakeHost();
  const logs: string[] = [];
  const interrupted: string[] = [];
  const x = deps({ host, log: (c) => logs.push(c), revokeDeadlineMs: 20, twoRoots: true });
  const h = buildHandlers(x.d);
  const a: any = await h["chat.send"]!({ prepareId: ((await h["chat.prepare"]!({ sessionId: "s1", question: "q" })) as any).prepareId, removeItemIds: [], confirmed: true });
  const b: any = await h["chat.send"]!({ prepareId: ((await h["chat.prepare"]!({ sessionId: "s2", question: "q" })) as any).prepareId, removeItemIds: [], confirmed: true });
  host.emit({ type: "turnCompleted", threadId: a.threadId, turnId: a.turnId, status: "completed", error: null });
  // B's reply is running: closing its thread would be refused (CodexHost's TurnBusyError) and interrupt it
  const realClose = host.closeThread.bind(host);
  host.closeThread = async (id: string) => { if (id === b.threadId) throw new TurnBusyError(); return realClose(id); };
  host.interrupt = async (id: string) => { interrupted.push(id); };
  const r: any = await h["privacy.revoke"]!({ root: x.root });
  assert.deepEqual(r, { revoked: true, pendingClose: 0 });
  assert.deepEqual(host.closed, [a.threadId]);
  assert.deepEqual(x.d.chat.openSessions(), ["s2"]);
  assert.deepEqual(interrupted, []); // B's reply keeps running
  assert.equal(host.activeTurn(b.threadId), b.turnId);
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(host.starts, 0);
  assert.deepEqual(logs, []);
});

test("revoke: an unknown root removes nothing and closes nothing", async () => {
  const host = new FakeHost();
  const logs: string[] = [];
  const x = deps({ host, log: (c) => logs.push(c), revokeDeadlineMs: 20 });
  const h = buildHandlers(x.d);
  await h["chat.send"]!({ prepareId: ((await h["chat.prepare"]!({ sessionId: "s1", question: "q" })) as any).prepareId, removeItemIds: [], confirmed: true });
  host.closeThread = async () => { throw new TurnBusyError(); };
  const r: any = await h["privacy.revoke"]!({ root: `${x.root}-not-approved` });
  assert.deepEqual(r, { revoked: false, pendingClose: 0 });
  assert.deepEqual(host.closed, []);
  assert.deepEqual(x.order, []); // nothing re-resolved
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(host.starts, 0);
  assert.deepEqual(logs, []);
});

test("shutdown calls the deps", async () => {
  const x = deps();
  await buildHandlers(x.d)["daemon.shutdown"]!({});
  assert.equal(x.shut(), 1);
});
