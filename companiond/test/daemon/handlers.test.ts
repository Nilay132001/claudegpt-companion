import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { BridgeEvent } from "../../src/bridge/sessionBridge.ts";
import { ChatService } from "../../src/chat/chatService.ts";
import { HostBusyError, type HostEvent, type HostState } from "../../src/codex/codexHost.ts";
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
  async interrupt(): Promise<void> {}
  activeTurn(threadId: string): string | null {
    return this.#active.get(threadId) ?? null;
  }
  on(l: (e: HostEvent) => void): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
}

function deps(o: { host?: DaemonHost } = {}) {
  const store = Store.memory();
  const root = tempDir(); // an approved synthetic root (the bridge resolves the session to it)
  store.putApproval({ root, commonDir: `${root}/.git`, includeWorktrees: false, approvedAt: 1 });
  const bridgeListeners = new Set<(e: BridgeEvent) => void>();
  const snap = () => ({ sessions: [session("s1")], selection: { sessionId: "s1", via: "focus" as const, focusedSessionId: "s1", focusLabel: "Claude focus (from Claude's records)" as const, focusMovedTo: null, pinnedMissing: false }, desktopRecordsError: null, refreshedAt: 1 });
  const pins: Array<string | null> = [];
  const order: string[] = [];
  const bridge: DaemonBridge = {
    snapshot: snap, refresh: async () => snap(), worktree: () => resolved(root), events: () => [], hasUuid: () => false, liveBranch: async () => "main",
    pin: (id) => { pins.push(id); return { ...snap().selection, sessionId: id, via: id ? "pin" : "focus" }; },
    syncStatus: () => ({ state: "live", stats: null, lastPollAt: 1 }),
    resolveNow: async (id) => { order.push(`resolve:${id}`); return resolved(root); },
    on: (l) => { bridgeListeners.add(l); return () => { bridgeListeners.delete(l); }; },
  };
  const host = o.host ?? new DisabledHost("off");
  const privacy = new Privacy(store, { inspect: async () => { throw new Error("nope"); } }, tempDir());
  const chat = new ChatService({
    host, bridge, store, sharingMode: () => privacy.sharingMode(), isApproved: privacy.isApproved,
    launchFor: async (r) => ({ command: "/usr/bin/sandbox-exec", args: ["-p", r], env: {}, cwd: r }),
  });
  let shut = 0;
  const d: DaemonDeps = { host, bridge, chat, privacy, store, version: "0.4.0", shutdown: () => { shut++; } };
  return { d, store, pins, root, order, emitBridge: (e: BridgeEvent) => bridgeListeners.forEach((l) => l(e)), shut: () => shut };
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
  await assert.rejects(h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [] }), (e: any) => toDaemonError(e).code === ErrorCodes.hostNotReady);
  await assert.rejects(h["chat.send"]!({ prepareId: "x", removeItemIds: [1] }), (e: any) => toDaemonError(e).code === ErrorCodes.invalidParams);
  await assert.rejects(h["auth.status"]!({}), (e: any) => toDaemonError(e).code === ErrorCodes.hostNotReady);
  assert.deepEqual(await h["host.status"]!({}), { state: "failed", detail: "off" });
});

test("HostBusyError is 'try again later', not a failure", async () => {
  const host = new FakeHost();
  host.busy = true;
  const h = buildHandlers(deps({ host }).d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  await assert.rejects(h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [] }), (e: any) => toDaemonError(e).code === ErrorCodes.hostBusy);
  assert.equal(host.state().state, "ready");
});

test("a security stop is cleared only by the owner's acknowledgement", async () => {
  const host = new FakeHost();
  const h = buildHandlers(deps({ host }).d);
  await assert.rejects(h["host.acknowledgeSecurityStop"]!({}), (e: any) => toDaemonError(e).code === ErrorCodes.invalidRequest);
  host.securityStop("the repository tools socket was replaced");
  const r: any = await h["host.restart"]!({});
  assert.match(r.detail, /^Security check failed/); // a restart does not clear the latch
  assert.equal(host.cleared, 0);
  assert.deepEqual(await h["host.acknowledgeSecurityStop"]!({}), { state: "ready", warnings: [] });
  assert.equal(host.cleared, 1);
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
  const s: any = await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [] });
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
  await assert.rejects(h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [] }), (e: any) => toDaemonError(e).code === ErrorCodes.prepareStale);
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
  await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [] });
  assert.deepEqual(got.filter(([m]) => m === "chat.threadReplaced"), [["chat.threadReplaced", { sessionId: "s1", threadId: "thr-new", reason: "resume_refused" }]]);
});

test("thread end: a session that leaves the list and a revoked approval close threads", async () => {
  const x = deps({ host: new FakeHost() });
  const host = x.d.host as FakeHost;
  host.order = x.order;
  wireEvents(x.d, () => undefined);
  const h = buildHandlers(x.d);
  const p: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  const s: any = await h["chat.send"]!({ prepareId: p.prepareId, removeItemIds: [] });
  host.emit({ type: "turnCompleted", threadId: s.threadId, turnId: s.turnId, status: "completed", error: null });
  await h["privacy.revoke"]!({ root: x.root });
  assert.deepEqual(host.closed, [s.threadId]);
  assert.deepEqual(x.order, ["resolve:s1", `close:${s.threadId}`]); // re-resolved before the close
  assert.equal(((await h["chat.prepare"]!({ sessionId: "s1", question: "q" })) as any).repo.state, "unavailable");
  const p2: any = await h["chat.prepare"]!({ sessionId: "s1", question: "q" });
  const s2: any = await h["chat.send"]!({ prepareId: p2.prepareId, removeItemIds: [] });
  host.emit({ type: "turnCompleted", threadId: s2.threadId, turnId: s2.turnId, status: "completed", error: null });
  x.emitBridge({ type: "sessions", snapshot: { ...x.d.bridge.snapshot(), sessions: [] } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(host.closed, [s.threadId, s.threadId]);
});

test("shutdown calls the deps", async () => {
  const x = deps();
  await buildHandlers(x.d)["daemon.shutdown"]!({});
  assert.equal(x.shut(), 1);
});
