// CodexHost (spec §3, §7.1, §7.1.9): supervises app-server processes — one per approved root (cap, idle LRU close),
// plus a base process for threads with no root, plus a short-lived sign-in process. One process per root does NOT stop
// a process reading another relay's env (KERN_PROCARGS2); what limits a stolen token is single use, the TTL and
// detection: the real relay is then refused, which stops everything (plan review I-8). Runs the self-check, binds
// each thread to its root through the relay with a fresh one-time token, answers server requests per type and guards
// every turn. A refused relay connection, a replaced socket, a validator violation/limit/error, or any failed or
// failing check stops everything with "Security check failed". Broker security events and an unchecked model are
// latched (start() refuses until clearSecurityStop(); plan review I-1); other failed checks fail the host, and a
// retry re-runs every check (prepare() rewrites the protected files). Capacity limits are HostBusyError, never a stop.
import path from "node:path";
import type { AppPaths } from "../app/appPaths.ts";
import { SANDBOX_EXEC, type LaunchSpec } from "../launch/seatbelt.ts";
import { DEFAULT_TOKEN_TTL_MS, type BrokerEvent, type RelayBroker, type RelayGrant } from "../relay/broker.ts";
import { inertOverride, relayOverride } from "./binding.ts";
import { checkProtectedFiles, type PreparedCodeMode } from "./codeMode.ts";
import type { CodexLaunch } from "./codexSeatbelt.ts";
import { CATALOG_FILE, CODE_MODE_OFF_FEATURES, OFF_FEATURES } from "./config.ts";
import { RuntimeGuard } from "./guard.ts";
import { DEVELOPER_INSTRUCTIONS } from "./instructions.ts";
import { CLIENT_INFO, CLIENT_METHODS } from "./methods.ts";
import { RpcClient, RpcError } from "./rpc.ts";
import {
  checkCodeModeConfig, checkCodexHome, checkCompanionCwd, checkConfigLayers, checkConfigRead, checkFeatureList, checkMcpStatus,
  checkThreadModel, checkThreadResponse, checkVersion, mergeChecks, nodeFsProbe, type CheckResult, type FsProbe,
} from "./selfCheck.ts";
import { decideServerRequest, type ToolAllowlist } from "./serverRequests.ts";
import { nodeSpawn, type SpawnFn } from "./spawn.ts";

export type HostState =
  | { state: "stopped" } | { state: "starting" }
  | { state: "ready"; warnings: string[] } | { state: "failed"; detail: string };
export type AuthState = { state: "signed_in"; planType: string | null } | { state: "signed_out" } | { state: "unsupported"; mode: string };
export interface RootBinding { root: string; launch: LaunchSpec }
export interface ItemSummary { id: string; type: string; server: string | null; tool: string | null; status: string | null }
export type HostEvent =
  | { type: "host"; state: HostState }
  | { type: "auth"; auth: AuthState }
  | { type: "delta"; threadId: string; turnId: string; itemId: string; text: string }
  | { type: "item"; threadId: string; turnId: string; phase: "started" | "completed"; item: ItemSummary }
  | { type: "turnCompleted"; threadId: string; turnId: string; status: string; error: string | null }
  | { type: "alert"; threadId: string | null; turnId: string | null; kind: "guard" | "server_request" | "process"; detail: string };

export class SecurityCheckError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`Security check failed: ${detail}`);
    this.name = "SecurityCheckError";
    this.detail = detail;
  }
}
export class HostNotReadyError extends Error {
  constructor() {
    super("Codex is not ready.");
    this.name = "HostNotReadyError";
  }
}
export class TurnBusyError extends Error {
  constructor() {
    super("A reply is still running for this session.");
    this.name = "TurnBusyError";
  }
}
/** Capacity, not security: the caller retries later; the host stays ready (plan re-review N-1). */
export class HostBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostBusyError";
  }
}

export interface CodexHostOptions {
  paths: AppPaths;
  codexVersion: string;
  pinnedVersion: string;
  makeLaunch: () => CodexLaunch;
  /** The short-lived sign-in process: the production profile plus the callback port (ruling I-9). */
  makeLoginLaunch: () => CodexLaunch;
  prepare: () => PreparedCodeMode;
  broker: RelayBroker;
  relayBinary: string;
  allowlist: ToolAllowlist;
  spawn?: SpawnFn;
  offFeatures?: readonly string[];
  fsProbe?: FsProbe;
  maxProcesses?: number;
  /** Live bindings kept below the acceptor's cap of 16 (plan review I-3). */
  maxBindings?: number;
  timeoutMs?: number;
  tokenTtlMs?: number;
  loginTimeoutMs?: number;
  /** How long a thread move waits for the old process to exit before the host fails (default 10 s). */
  exitTimeoutMs?: number;
  /** Only for labelled measurements: allows a launch that is not under sandbox-exec (spec §7.1.9). */
  measurementOnly?: boolean;
}

/** The host detail for every failure that is not a security check: the error's name is added, never its message. */
export const FAILED = "Codex stopped";
const UNSANDBOXED_WARNING ="measurement only: Codex is running without its Seatbelt profile";
const BASE = "";
const MAX_REBINDS = 3;
const REBIND_WINDOW_MS = 10 * 60_000;

/** checked: settles when the process's self-check has passed (or rejects when it failed). Nothing uses a process
 * before that, even when it is already in #procs (review fix 3). */
/** exited: settles when the process has exited (a thread move waits for it, see #leaveProcess). */
interface Proc { key: string; rpc: RpcClient; kill: () => void; threads: Set<string>; lastUsed: number; closing: boolean; checked: Promise<void>; exited: Promise<void> }
/** turn ids remembered per thread for a turn/completed that beats the turn/start reply; older ones are dropped. */
const MAX_FINISHED = 16;
interface ThreadState {
  threadId: string;
  proc: Proc;
  rootKey: string;
  binding: RootBinding | null;
  grant: RelayGrant | null;
  activeTurn: string | null;
  finished: Set<string>;
  needsRebind: boolean;
  lastUsed: number;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

async function pageAll(rpc: RpcClient, method: string, params: Record<string, unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const r = obj(await rpc.request(method, { ...params, cursor, limit: 200 }));
    if (Array.isArray(r?.data)) out.push(...r.data);
    cursor = str(r?.nextCursor);
    if (!cursor) break;
  }
  return out;
}

export class CodexHost {
  #o: CodexHostOptions;
  #spawn: SpawnFn;
  #off: readonly string[];
  #fs: FsProbe;
  #listeners = new Set<(e: HostEvent) => void>();
  #state: HostState = { state: "stopped" };
  #procs = new Map<string, Proc>();
  #threads = new Map<string, ThreadState>();
  #byGrant = new Map<string, string>();
  #models: readonly string[] = [];
  #protected: Readonly<Record<string, string>> = {};
  #rebinds = new Map<string, number[]>();
  #bindQueue: Promise<unknown> = Promise.resolve();
  /** Opens and closes of the same thread id, bound or not, run one at a time (review fix 1, final review I-2). */
  #idQueues = new Map<string, Promise<unknown>>();
  #login: { end: () => void } | null = null;
  #securityStopped: string | null = null;
  #warnings: string[] = [];
  #clock = 0;

  constructor(o: CodexHostOptions) {
    this.#o = o;
    this.#spawn = o.spawn ?? nodeSpawn;
    this.#off = o.offFeatures ?? OFF_FEATURES;
    this.#fs = o.fsProbe ?? nodeFsProbe;
    o.broker.on((e) => this.#onBroker(e));
  }

  on(l: (e: HostEvent) => void): () => void {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  }

  state(): HostState {
    return this.#state;
  }

  activeTurn(threadId: string): string | null {
    return this.#threads.get(threadId)?.activeTurn ?? null;
  }

  async start(): Promise<HostState> {
    if (this.#state.state === "ready" || this.#state.state === "starting") return this.#state;
    if (this.#securityStopped !== null) {
      // Latched (plan review I-1): a retry must not turn fail-stop into fail-restart.
      this.#set({ state: "failed", detail: `Security check failed: ${this.#securityStopped}` });
      return this.#state;
    }
    this.#set({ state: "starting" });
    this.#warnings = [];
    try {
      const pre = mergeChecks(checkCompanionCwd(this.#o.paths.emptyCwd, this.#fs), checkCodexHome(this.#o.paths.codexHome, this.#fs));
      if (pre.failures.length > 0) throw new SecurityCheckError(pre.failures.join("; "));
      // After a replaced socket the acceptor re-runs every start check before anything is bound again.
      if (!this.#o.broker.healthy()) await this.#o.broker.restart();
      this.#requireNoSecurityStop();
      const prep = this.#o.prepare(); // writes the catalog and config.toml, then checks the tool surface
      if (prep.result.failures.length > 0) throw new SecurityCheckError(prep.result.failures.join("; "));
      this.#models = prep.models;
      this.#protected = prep.protectedFiles;
      this.#addWarnings(prep.result.warnings);
      await this.#proc(BASE);
      this.#requireNoSecurityStop();
      this.#set({ state: "ready", warnings: [...this.#warnings] });
    } catch (e) {
      this.#fail(e);
    }
    return this.#state;
  }

  /** M4b calls this only after the owner acknowledged the "Security check failed" message. */
  clearSecurityStop(): void {
    this.#securityStopped = null;
  }

  async stop(): Promise<void> {
    this.#login?.end();
    for (const t of this.#threads.values()) this.#dropGrant(t);
    for (const p of this.#procs.values()) this.#close(p);
    this.#procs.clear();
    this.#threads.clear();
    this.#byGrant.clear();
    this.#set({ state: "stopped" });
  }

  async auth(): Promise<AuthState> {
    const r = obj(await (await this.#base()).rpc.request("account/read", { refreshToken: false }));
    const acct = obj(r?.account);
    if (!acct) return { state: "signed_out" };
    if (acct.type === "chatgpt") return { state: "signed_in", planType: str(acct.planType) };
    return { state: "unsupported", mode: str(acct.type) ?? "unknown" };
  }

  /** Sign-in in its own short-lived Codex process under the sign-in profile (ruling I-9). The base process never
   * listens on the callback port. The process ends on account/login/completed or after loginTimeoutMs. */
  async login(): Promise<{ authUrl: string }> {
    this.#requireReady();
    this.#login?.end();
    this.#requireProtected();
    const launch = this.#o.makeLoginLaunch();
    this.#requireSandboxed(launch);
    const s = this.#spawn(launch);
    const rpc = new RpcClient(s.transport, {
      allowedMethods: CLIENT_METHODS,
      timeoutMs: this.#o.timeoutMs,
      onServerRequest: async (method, params) => decideServerRequest(method, params, this.#o.allowlist, () => null).reply,
    });
    s.onExit((d) => rpc.close(d));
    let timer: NodeJS.Timeout | undefined;
    const handle = {
      end: () => {
        clearTimeout(timer);
        if (this.#login === handle) this.#login = null;
        s.kill();
        rpc.close("sign-in ended");
      },
    };
    this.#login = handle;
    timer = setTimeout(handle.end, this.#o.loginTimeoutMs ?? 10 * 60_000);
    timer.unref();
    rpc.onNotification((m, p) => {
      if (m !== "account/login/completed") return;
      handle.end();
      void this.#afterSignIn(obj(p)?.success === true);
    });
    try {
      const init = await rpc.request("initialize", { clientInfo: CLIENT_INFO, capabilities: null });
      rpc.notify("initialized");
      const cfg = await rpc.request("config/read", { includeLayers: true, cwd: this.#o.paths.emptyCwd });
      const check = mergeChecks(
        checkVersion(this.#o.codexVersion, this.#o.pinnedVersion, obj(init)?.userAgent),
        checkConfigRead(cfg, [...this.#off, ...CODE_MODE_OFF_FEATURES]),
        checkCodeModeConfig(cfg, [], path.join(this.#o.paths.codexHome, CATALOG_FILE)),
        checkConfigLayers(cfg, this.#o.paths.codexHome),
      );
      if (check.failures.length > 0) throw new SecurityCheckError(check.failures.join("; "));
      const r = obj(await rpc.request("account/login/start", { type: "chatgpt" }));
      const authUrl = str(r?.authUrl);
      if (!authUrl || !authUrl.startsWith("https://")) throw new Error("Sign-in did not return an https link.");
      return { authUrl };
    } catch (e) {
      handle.end();
      throw e;
    }
  }

  /** Plan re-review N-2: sign-in completed in ANOTHER process. Whether a running app-server picks up credentials it
   * did not write is unmeasured (measuring it needs a real sign-in), so every running process is replaced: open
   * conversations are closed (tokens revoked; M4b reopens them), the base process is re-spawned and re-checked, and
   * only then is the new auth state emitted. The old processes are dropped and the new base is registered in one
   * synchronous step, so no open sees an old process, and an open that arrives during the new base's self-check
   * waits for it (Proc.checked; review fix 3). No unsubscribe is sent: the processes are killed. */
  async #afterSignIn(success: boolean): Promise<void> {
    if (success && this.#state.state === "ready") {
      for (const t of this.#threads.values()) this.#dropGrant(t);
      this.#threads.clear();
      this.#byGrant.clear();
      for (const p of [...this.#procs.values()]) this.#close(p);
      this.#procs.clear();
      try {
        await this.#proc(BASE);
      } catch (e) {
        this.#fail(e);
        return;
      }
    }
    const auth = await this.auth().catch(() => null);
    if (auth) this.#emit({ type: "auth", auth });
  }

  async openThread(threadId: string | null, binding: RootBinding | null): Promise<string> {
    const open = (): Promise<string> => {
      // Every open runs one at a time, bound or not: the acceptor never sees more than one handshake from us at once
      // (I-3), and a move that closes a process (#leaveProcess) can never kill it under another open in flight on it,
      // the base process included (Task 10 review I2).
      const run = this.#bindQueue.then(() => this.#openThread(threadId, binding));
      this.#bindQueue = run.catch(() => undefined);
      return run;
    };
    if (threadId === null) return open();
    // Review fix 1: an unbound open racing a bound one for the same id must not replace its state (and orphan its
    // live grant), so every open of one id waits for the previous one.
    return this.#onIdQueue(threadId, open);
  }

  /** Thread end (ruling I1): unsubscribe and revoke its token. On the same per-id queue as openThread (final review
   * I-2): a close that arrives while an open of the same id is in flight waits for it and unloads what it produced,
   * so no grant or binding outlives a closed conversation. */
  async closeThread(threadId: string): Promise<void> {
    return this.#onIdQueue(threadId, async () => {
      const t = this.#threads.get(threadId);
      if (!t) return;
      if (t.activeTurn) throw new TurnBusyError();
      await this.#unload(t);
    });
  }

  /** Runs fn after every earlier open or close of this id has settled. */
  #onIdQueue<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#idQueues.get(threadId) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.#idQueues.set(threadId, tail);
    void tail.then(() => {
      if (this.#idQueues.get(threadId) === tail) this.#idQueues.delete(threadId);
    });
    return run;
  }

  async #openThread(threadId: string | null, binding: RootBinding | null): Promise<string> {
    this.#requireReady();
    const rootKey = binding?.root ?? BASE;
    const loaded = threadId ? this.#threads.get(threadId) : undefined;
    if (loaded && loaded.rootKey === rootKey && !loaded.needsRebind && !loaded.proc.rpc.isClosed) return loaded.threadId;
    if (loaded) {
      if (loaded.activeTurn) throw new TurnBusyError();
      if (loaded.rootKey !== rootKey && !loaded.proc.rpc.isClosed) await this.#leaveProcess(loaded);
      else await this.#unload(loaded);
      // A #fail during the wait (review I1) ends the move here: nothing is spawned, granted or resumed.
      this.#requireReady();
    }
    let grant: RelayGrant | null = null;
    let t: ThreadState | null = null;
    let asking = false;
    let requested = false;
    try {
      if (binding) await this.#makeRoomForBinding();
      const proc = await this.#proc(rootKey);
      this.#requireProtected();
      // Codex re-reads config per thread: a layer file added since the process started must fail here (N-4).
      const cfg = await proc.rpc.request("config/read", { includeLayers: true, cwd: this.#o.paths.emptyCwd });
      const cfgCheck = mergeChecks(
        checkConfigRead(cfg, [...this.#off, ...CODE_MODE_OFF_FEATURES]),
        checkConfigLayers(cfg, this.#o.paths.codexHome),
        checkCodeModeConfig(cfg, [], path.join(this.#o.paths.codexHome, CATALOG_FILE)),
      );
      if (cfgCheck.failures.length > 0) throw new SecurityCheckError(cfgCheck.failures.join("; "));
      grant = binding ? this.#o.broker.grant(binding.launch) : null;
      const cwd = this.#o.paths.emptyCwd;
      const params: Record<string, unknown> = {
        cwd,
        sandbox: "read-only",
        approvalPolicy: "untrusted",
        developerInstructions: DEVELOPER_INSTRUCTIONS,
        config: grant ? relayOverride(this.#o.relayBinary, grant.token, cwd) : inertOverride(),
      };
      asking = true;
      const resp = threadId ? await proc.rpc.request("thread/resume", { threadId, ...params }) : await proc.rpc.request("thread/start", params);
      requested = true;
      grant?.arm(this.#o.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS); // the relay connected during thread/start; seconds to spare
      this.#requireReady(); // a #fail may have run while we waited
      const id = str(obj(obj(resp)?.thread)?.id);
      if (!id) throw new SecurityCheckError("app-server returned no thread id");
      // Final review m5: a resume must answer for the thread it was asked for, never store state under another id.
      if (threadId && id !== threadId) throw new SecurityCheckError("app-server resumed a different thread");
      t = { threadId: id, proc, rootKey, binding, grant, activeTurn: null, finished: new Set(), needsRebind: false, lastUsed: ++this.#clock };
      // Defensive (review fix 1): state already held for this id is ended, never silently replaced, so its grant
      // can never outlive it.
      const old = this.#threads.get(id);
      if (old) {
        this.#dropGrant(old);
        old.proc.threads.delete(id);
      }
      this.#threads.set(id, t);
      proc.threads.add(id);
      if (grant) this.#byGrant.set(grant.id, id);
      const mcp = await this.#threadStatus(proc, id);
      this.#requireReady();
      const check = mergeChecks(
        checkThreadResponse(resp, cwd),
        checkThreadModel(resp, this.#models),
        checkMcpStatus(mcp, this.#o.allowlist, binding ? "thread" : "process"),
      );
      if (check.failures.length > 0) throw new SecurityCheckError(check.failures.join("; "));
      return id;
    } catch (e) {
      // Plan review I-4: an error is never weaker than a mismatch. The token is revoked and the thread dropped; once
      // Codex has (or may have) loaded the thread, everything stops. A JSON-RPC error reply to thread/start or
      // thread/resume itself (no thread loaded, for example an unknown thread id) is passed to the caller instead.
      grant?.revoke();
      if (t) {
        if (this.#threads.get(t.threadId) === t) this.#threads.delete(t.threadId);
        t.proc.threads.delete(t.threadId);
        if (grant) this.#byGrant.delete(grant.id);
      }
      const plainRefusal = (asking && !requested && e instanceof RpcError) || e instanceof HostBusyError || e instanceof TurnBusyError;
      if (!plainRefusal && this.#state.state === "ready") {
        this.#fail(e instanceof SecurityCheckError ? e : new SecurityCheckError(`a conversation could not be checked (${e instanceof Error ? e.name : "error"})`));
      }
      throw e;
    }
  }

  async startTurn(threadId: string, text: string): Promise<{ turnId: string }> {
    this.#requireReady();
    let t = this.#threads.get(threadId);
    if (!t) throw new Error("That conversation is not open.");
    if (t.activeTurn) throw new TurnBusyError();
    if (t.needsRebind) {
      await this.openThread(threadId, t.binding); // a fresh grant; the old binding ended
      t = this.#threads.get(threadId);
      if (!t) throw new Error("That conversation is not open.");
      // Another startTurn may have rebound and started its turn while this one waited (review fix 4).
      if (t.activeTurn) throw new TurnBusyError();
    }
    t.lastUsed = ++this.#clock;
    t.activeTurn = "pending";
    let turnId: string | null = null;
    try {
      const resp = await t.proc.rpc.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
      turnId = str(obj(obj(resp)?.turn)?.id);
    } finally {
      t.activeTurn = null;
    }
    if (!turnId) throw new Error("app-server returned no turn id");
    if (!t.finished.has(turnId)) t.activeTurn = turnId;
    t.proc.lastUsed = ++this.#clock;
    return { turnId };
  }

  async interrupt(threadId: string): Promise<void> {
    const t = this.#threads.get(threadId);
    if (!t?.activeTurn || t.activeTurn === "pending") return;
    await t.proc.rpc.request("turn/interrupt", { threadId, turnId: t.activeTurn });
  }

  /** The base process, spawned again on demand when a thread move closed it. A failed spawn or self-check fails the
   * host, as at start. */
  async #base(): Promise<Proc> {
    this.#requireReady();
    try {
      const p = await this.#proc(BASE);
      this.#requireReady();
      return p;
    } catch (e) {
      if (!(e instanceof HostNotReadyError) && this.#state.state === "ready") this.#fail(e);
      throw e;
    }
  }

  #requireReady(): void {
    if (this.#state.state !== "ready") throw new HostNotReadyError();
  }

  /** Processes may be spawned only while the host is starting or ready, never after a #fail or stop(). */
  #requireLive(): void {
    if (this.#state.state !== "ready" && this.#state.state !== "starting") throw new HostNotReadyError();
  }

  /** A security event that arrived while start() was waiting is latched: start() never goes ready over it. */
  #requireNoSecurityStop(): void {
    if (this.#securityStopped !== null) throw new SecurityCheckError(this.#securityStopped);
  }

  #addWarnings(ws: readonly string[]): void {
    for (const w of ws) if (!this.#warnings.includes(w)) this.#warnings.push(w);
  }

  /** config.toml and the catalog are exactly what companiond wrote: one link, same bytes (plan review I-5). */
  #requireProtected(): void {
    const c = checkProtectedFiles(this.#o.paths.codexHome, this.#protected);
    if (c.failures.length > 0) throw new SecurityCheckError(c.failures.join("; "));
  }

  #requireSandboxed(launch: CodexLaunch): void {
    if (launch.command === SANDBOX_EXEC && launch.args[0] === "-p") return;
    // No silent weaker fallback: an unsandboxed Codex runs only when a measurement asks for it by name.
    if (this.#o.measurementOnly !== true) throw new SecurityCheckError("Codex must run under its Seatbelt profile.");
    this.#addWarnings([UNSANDBOXED_WARNING]);
  }

  /** The only way CodexHost asks for a thread's MCP status: always by serverName. Measured while planning: the same
   * call without serverName re-spawns the thread's servers, spends the one-time token and is refused (M-10). */
  async #threadStatus(proc: Proc, threadId: string): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const serverName of this.#o.allowlist.keys()) out.push(...(await pageAll(proc.rpc, "mcpServerStatus/list", { threadId, serverName })));
    return out;
  }

  /** Keeps live bindings below the acceptor's cap: the least recently used idle bound thread is closed first (I-3). */
  async #makeRoomForBinding(): Promise<void> {
    const max = this.#o.maxBindings ?? 12;
    const bound = [...this.#threads.values()].filter((t) => t.grant !== null);
    if (bound.length < max) return;
    const idle = bound.filter((t) => !t.activeTurn).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) throw new HostBusyError("Too many conversations are busy. Wait for a reply to finish.");
    try {
      await this.#unload(idle); // its token is revoked before the unsubscribe is sent
    } catch {
      throw new HostBusyError("An older conversation could not be closed. Try again.");
    }
  }

  async #proc(key: string): Promise<Proc> {
    this.#requireLive();
    const existing = this.#procs.get(key);
    if (existing && !existing.rpc.isClosed) {
      existing.lastUsed = ++this.#clock;
      await existing.checked; // a process still in its self-check is not used before it passes (review fix 3)
      this.#requireLive();
      return existing;
    }
    if (key !== BASE) await this.#evictIfFull();
    this.#requireLive(); // nothing is spawned after a #fail or stop() that ran during an await (review I1)
    this.#requireProtected();
    const launch = this.#o.makeLaunch();
    this.#requireSandboxed(launch);
    const s = this.#spawn(launch);
    let rpc: RpcClient | null = null;
    const guard = new RuntimeGuard(this.#o.allowlist, {
      interrupt: async (threadId, turnId) => {
        await rpc?.request("turn/interrupt", { threadId, turnId });
      },
      alert: (a) => this.#emit({ type: "alert", threadId: a.threadId, turnId: a.turnId, kind: "guard", detail: a.detail }),
    });
    rpc = new RpcClient(s.transport, {
      allowedMethods: CLIENT_METHODS,
      timeoutMs: this.#o.timeoutMs,
      onServerRequest: async (method, params) => {
        const d = decideServerRequest(method, params, this.#o.allowlist, guard.lookup);
        if (d.alert) {
          const p = obj(params);
          this.#emit({ type: "alert", threadId: str(p?.threadId), turnId: str(p?.turnId), kind: "server_request", detail: d.alert });
        }
        return d.reply;
      },
    });
    let settle: { ok: () => void; fail: (e: unknown) => void } = { ok: () => undefined, fail: () => undefined };
    const checked = new Promise<void>((ok, fail) => {
      settle = { ok, fail };
    });
    checked.catch(() => undefined); // the spawning caller gets the error itself; waiters get it through `checked`
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((ok) => {
      markExited = ok;
    });
    const proc: Proc = { key, rpc, kill: () => s.kill(), threads: new Set(), lastUsed: ++this.#clock, closing: false, checked, exited };
    rpc.onNotification((m, p) => {
      guard.onNotification(m, p);
      this.#onNotification(m, p);
    });
    s.onExit((detail) => {
      markExited();
      rpc?.close(detail);
    });
    rpc.onClose(() => this.#onClosed(proc));
    this.#procs.set(key, proc);
    try {
      const init = await rpc.request("initialize", { clientInfo: CLIENT_INFO, capabilities: null });
      this.#requireLive();
      rpc.notify("initialized");
      const check = await this.#processCheck(rpc, init);
      this.#requireLive(); // a process that finished its check after a #fail is closed below, never used
      if (check.failures.length > 0) throw new SecurityCheckError(check.failures.join("; "));
      this.#addWarnings(check.warnings);
    } catch (e) {
      this.#close(proc);
      if (this.#procs.get(key) === proc) this.#procs.delete(key);
      settle.fail(e);
      throw e;
    }
    settle.ok();
    return proc;
  }

  async #processCheck(rpc: RpcClient, init: unknown): Promise<CheckResult> {
    const cfg = await rpc.request("config/read", { includeLayers: true, cwd: this.#o.paths.emptyCwd });
    const features = await pageAll(rpc, "experimentalFeature/list", {});
    const mcp = await pageAll(rpc, "mcpServerStatus/list", {});
    return mergeChecks(
      checkVersion(this.#o.codexVersion, this.#o.pinnedVersion, obj(init)?.userAgent),
      checkConfigRead(cfg, [...this.#off, ...CODE_MODE_OFF_FEATURES]),
      checkConfigLayers(cfg, this.#o.paths.codexHome),
      checkCodeModeConfig(cfg, features, path.join(this.#o.paths.codexHome, CATALOG_FILE)),
      checkFeatureList(features, this.#off, this.#o.codexVersion),
      checkCompanionCwd(this.#o.paths.emptyCwd, this.#fs),
      checkCodexHome(this.#o.paths.codexHome, this.#fs),
      checkMcpStatus(mcp, this.#o.allowlist, "process"),
    );
  }

  async #evictIfFull(): Promise<void> {
    const max = this.#o.maxProcesses ?? 3;
    const roots = [...this.#procs.values()].filter((p) => p.key !== BASE && !p.rpc.isClosed);
    if (roots.length < max) return;
    const idle = roots
      .filter((p) => [...p.threads].every((t) => !this.#threads.get(t)?.activeTurn))
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) throw new HostBusyError("Too many repositories are busy. Wait for a reply to finish.");
    for (const id of [...idle.threads]) {
      const st = this.#threads.get(id);
      // Tokens are revoked before each unsubscribe; a failed unsubscribe is capacity trouble, not a security event.
      if (st) await this.#unload(st).catch(() => undefined);
    }
    this.#close(idle);
    this.#procs.delete(idle.key);
  }

  /** A thread moving to another root (measured on 0.166.0: after a real turn, thread/unsubscribe leaves the thread
   * loaded and its writer lock held, so thread/resume elsewhere is refused until the old process exits). Every
   * thread on the old process is unloaded as eviction does (tokens revoked before unsubscribe), then the process is
   * closed and its exit awaited before the caller resumes. A busy sibling refuses the move and changes nothing. */
  async #leaveProcess(t: ThreadState): Promise<void> {
    const p = t.proc;
    const others = [...p.threads].flatMap((id) => {
      const s = this.#threads.get(id);
      return s && s !== t ? [s] : [];
    });
    if (others.some((s) => s.activeTurn)) throw new HostBusyError("Another conversation in this repository is busy. Wait for its reply to finish.");
    // Each #unload drops its thread synchronously before it awaits, so no sibling can start a turn after this point.
    await Promise.all([t, ...others].map((s) => this.#unload(s).catch(() => undefined)));
    this.#close(p);
    if (this.#procs.get(p.key) === p) this.#procs.delete(p.key);
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      p.exited.then(() => true),
      new Promise<boolean>((ok) => {
        timer = setTimeout(() => ok(false), this.#o.exitTimeoutMs ?? 10_000);
      }),
    ]);
    clearTimeout(timer);
    if (!exited) {
      const e = new Error("Codex did not stop");
      e.name = "CodexExitTimeout";
      this.#fail(e);
      throw e;
    }
  }

  async #unload(t: ThreadState): Promise<void> {
    this.#threads.delete(t.threadId);
    t.proc.threads.delete(t.threadId);
    this.#dropGrant(t);
    if (!t.proc.rpc.isClosed) await t.proc.rpc.request("thread/unsubscribe", { threadId: t.threadId });
  }

  #dropGrant(t: ThreadState): void {
    if (!t.grant) return;
    this.#byGrant.delete(t.grant.id);
    t.grant.revoke();
    t.grant = null;
  }

  #close(p: Proc): void {
    p.closing = true;
    p.kill();
    p.rpc.close("stopped by companion");
  }

  #onClosed(p: Proc): void {
    for (const id of p.threads) {
      const t = this.#threads.get(id);
      if (t) this.#dropGrant(t);
      this.#threads.delete(id);
    }
    p.threads.clear();
    if (this.#procs.get(p.key) === p) this.#procs.delete(p.key);
    if (p.closing) return;
    this.#emit({ type: "alert", threadId: null, turnId: null, kind: "process", detail: "Codex stopped unexpectedly." });
    this.#fail(new Error("Codex stopped unexpectedly."));
  }

  #onBroker(e: BrokerEvent): void {
    if (e.type === "bound") return;
    if (e.type === "refused") return this.#securityStop("an unknown program tried to use the repository tools");
    if (e.type === "socketReplaced") return this.#securityStop("the repository tools socket was replaced");
    const threadId = this.#byGrant.get(e.grantId) ?? null;
    this.#byGrant.delete(e.grantId);
    if (e.end === "revoked") return;
    // A crash of the validator arrives as "violation" (I-2); "error" (a spawn or socket failure) also stops.
    // "dropped" (the relay vanished mid-handshake, nothing bound) is rebound like normal/idle/jail (N-5).
    if (e.end === "violation" || e.end === "limit" || e.end === "error") {
      return this.#securityStop("the repository tools stopped in a way that is not allowed");
    }
    const t = threadId ? this.#threads.get(threadId) : undefined;
    if (t && t.grant?.id === e.grantId) {
      const now = Date.now();
      const recent = (this.#rebinds.get(t.threadId) ?? []).filter((x) => now - x < REBIND_WINDOW_MS);
      recent.push(now);
      this.#rebinds.set(t.threadId, recent);
      if (recent.length > MAX_REBINDS) return this.#securityStop("the repository tools keep stopping");
      t.grant = null;
      t.needsRebind = true;
    }
    this.#emit({ type: "alert", threadId, turnId: null, kind: "process", detail: "The repository tools stopped. They restart with the next message." });
  }

  /** Latched: start() refuses until clearSecurityStop() (plan review I-1). */
  #securityStop(detail: string): void {
    this.#securityStopped = detail;
    if (this.#state.state !== "ready" && this.#state.state !== "starting") return;
    this.#emit({ type: "alert", threadId: null, turnId: null, kind: "process", detail: `Security check failed: ${detail}` });
    this.#fail(new SecurityCheckError(detail));
  }

  #onNotification(method: string, params: unknown): void {
    const p = obj(params);
    const threadId = str(p?.threadId);
    switch (method) {
      case "item/agentMessage/delta": {
        const turnId = str(p?.turnId);
        const itemId = str(p?.itemId);
        if (threadId && turnId && itemId && typeof p?.delta === "string") this.#emit({ type: "delta", threadId, turnId, itemId, text: p.delta });
        return;
      }
      case "item/started":
      case "item/completed": {
        const turnId = str(p?.turnId);
        const it = obj(p?.item);
        if (!threadId || !turnId || !it) return;
        this.#emit({
          type: "item", threadId, turnId, phase: method === "item/started" ? "started" : "completed",
          item: { id: str(it.id) ?? "", type: str(it.type) ?? "unknown", server: str(it.server), tool: str(it.tool), status: str(it.status) },
        });
        return;
      }
      case "turn/started": {
        const t = threadId ? this.#threads.get(threadId) : undefined;
        const turn = obj(p?.turn);
        const turnId = str(turn?.id);
        // The model is checked at start/resume; if a turn reports another one, its surface was never checked (M-11).
        const model = str(turn?.model);
        if (model && !this.#models.includes(model)) return this.#securityStop("a turn runs a model whose tool surface was not checked");
        if (t && turnId && !t.finished.has(turnId)) t.activeTurn = turnId;
        return;
      }
      case "turn/completed": {
        const turn = obj(p?.turn);
        const turnId = str(turn?.id);
        if (!threadId || !turnId) return;
        const t = this.#threads.get(threadId);
        if (t) {
          t.finished.add(turnId);
          for (const old of t.finished) {
            if (t.finished.size <= MAX_FINISHED) break;
            t.finished.delete(old); // insertion order: the oldest first
          }
          if (t.activeTurn === turnId) t.activeTurn = null;
        }
        this.#emit({ type: "turnCompleted", threadId, turnId, status: str(turn?.status) ?? "unknown", error: str(obj(turn?.error)?.message) });
        return;
      }
      case "account/updated":
      case "account/login/completed":
        void this.auth().then((auth) => this.#emit({ type: "auth", auth }), () => undefined);
        return;
      default:
        return;
    }
  }

  #fail(e: unknown): void {
    this.#login?.end();
    for (const t of this.#threads.values()) this.#dropGrant(t);
    for (const p of this.#procs.values()) this.#close(p);
    this.#procs.clear();
    this.#threads.clear();
    this.#byGrant.clear();
    // A latched security stop always wins over a later, plainer failure (review fix 2). Other errors never show
    // their message: it can hold local paths or Codex output (review fix 5).
    const detail = this.#securityStopped !== null
      ? `Security check failed: ${this.#securityStopped}`
      : e instanceof SecurityCheckError
        ? e.message
        : `${FAILED} (${e instanceof Error ? e.name : "error"})`;
    this.#set({ state: "failed", detail });
  }

  #set(s: HostState): void {
    this.#state = s;
    this.#emit({ type: "host", state: s });
  }

  #emit(e: HostEvent): void {
    for (const l of this.#listeners) {
      try {
        l(e);
      } catch {
        // a listener bug must not stop the others
      }
    }
  }
}
