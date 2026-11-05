// In-process fake of `codex app-server` and a fake relay broker for CodexHost unit tests. Synthetic; no network,
// no real Codex, no sockets.
import path from "node:path";
import { PassThrough } from "node:stream";
import { LineBuffer } from "../../src/lineBuffer.ts";
import type { CodexLaunch } from "../../src/codex/codexSeatbelt.ts";
import { BASE_MCP_COMMAND, CATALOG_FILE, CODE_MODE_OFF_FEATURES, EXCLUDED_TOOL_NAMESPACES, OFF_FEATURES } from "../../src/codex/config.ts";
import type { SpawnedServer, SpawnFn } from "../../src/codex/spawn.ts";
import type { LaunchSpec } from "../../src/launch/seatbelt.ts";
import type { BrokerEvent, RelayBroker, RelayGrant } from "../../src/relay/broker.ts";
import { newToken } from "../../src/relay/handshake.ts";

export type Handler = (params: any, fake: FakeAppServer) => unknown;
export const FAKE_MODEL = "gpt-fake";

export class FakeAppServer {
  readonly launch: CodexLaunch;
  readonly received: any[] = [];
  readonly bound = new Set<string>();
  handlers: Record<string, Handler>;
  killed = false;
  #toClient = new PassThrough();
  #fromClient = new PassThrough();
  #lb = new LineBuffer();
  #onExit: ((d: string) => void) | null = null;
  #nextId = 1000;
  #answers = new Map<number, (m: any) => void>();
  // Shared by all fakes, so ids are unique across processes (real Codex ids are UUIDs).
  static #n = 0;

  constructor(launch: CodexLaunch, handlers: Record<string, Handler>) {
    this.launch = launch;
    this.handlers = handlers;
    this.#fromClient.on("data", (c: Buffer) => {
      for (const l of this.#lb.push(c)) this.#onLine(JSON.parse(l));
    });
  }
  next(prefix: string): string {
    return `${prefix}-${++FakeAppServer.#n}`;
  }
  server(): SpawnedServer {
    return {
      transport: { input: this.#toClient, output: this.#fromClient, stderr: null },
      kill: () => {
        this.killed = true;
        this.exit("killed");
      },
      onExit: (cb) => {
        this.#onExit = cb;
      },
    };
  }
  notify(method: string, params: unknown): void {
    this.#toClient.write(JSON.stringify({ method, params }) + "\n");
  }
  request(method: string, params: unknown): Promise<any> {
    const id = this.#nextId++;
    return new Promise((res) => {
      this.#answers.set(id, res);
      this.#toClient.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  exit(detail: string): void {
    if (!this.#toClient.writableEnded) this.#toClient.end();
    this.#onExit?.(detail);
  }
  methods(): string[] {
    return this.received.filter((m) => typeof m.method === "string").map((m) => m.method);
  }
  last(method: string): any {
    return [...this.received].reverse().find((m) => m.method === method)?.params;
  }
  #onLine(m: any): void {
    this.received.push(m);
    if (typeof m.method === "string" && m.id !== undefined) {
      const h = this.handlers[m.method];
      try {
        if (!h) throw { code: -32601, message: `fake: no handler for ${m.method}` };
        this.#toClient.write(JSON.stringify({ id: m.id, result: h(m.params, this) }) + "\n");
      } catch (e: any) {
        this.#toClient.write(JSON.stringify({ id: m.id, error: { code: e?.code ?? -32000, message: e?.message ?? "fake error" } }) + "\n");
      }
    } else if (m.id !== undefined && m.method === undefined) {
      this.#answers.get(m.id)?.(m);
    }
  }
}

const TOOLS = Object.fromEntries(["list_dir", "read_file", "search", "git_status", "git_diff"].map((t) => [t, { name: t }]));

export function goodHandlers(): Record<string, Handler> {
  const thread = (id: string, params: any, f: FakeAppServer) => {
    const c = params?.config ?? {};
    const command = c["mcp_servers.companion-readonly.command"];
    const token = c["mcp_servers.companion-readonly.env"]?.CGC_RELAY_TOKEN;
    if (typeof command === "string" && command !== BASE_MCP_COMMAND && typeof token === "string") f.bound.add(id);
    else f.bound.delete(id);
    return {
      thread: { id }, model: FAKE_MODEL, cwd: params.cwd, instructionSources: [], approvalPolicy: params.approvalPolicy,
      approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false },
    };
  };
  return {
    // The real 0.166.0 shape (measured): Codex's version under the client's originator name (plan review I-11).
    initialize: () => ({ userAgent: "claudegpt_companion/0.166.0 (Mac OS 27.0.1; arm64) unknown (claudegpt_companion; 0.4.0)", codexHome: "/x", platformFamily: "unix", platformOs: "macos" }),
    "config/read": (_p, f) => ({
      config: {
        features: {
          ...Object.fromEntries([...OFF_FEATURES, ...CODE_MODE_OFF_FEATURES].map((k) => [k, false])),
          code_mode_host: true,
          code_mode: { excluded_tool_namespaces: [...EXCLUDED_TOOL_NAMESPACES] },
        },
        web_search: "disabled",
        model_catalog_json: path.join(f.launch.env.CODEX_HOME ?? "", CATALOG_FILE),
      },
      origins: {},
      layers: [
        { name: { type: "user", file: path.join(f.launch.env.CODEX_HOME ?? "", "config.toml"), profile: null }, version: "1", config: {}, disabledReason: null },
        { name: { type: "system", file: "/etc/codex/config.toml" }, version: "1", config: {}, disabledReason: null },
      ],
    }),
    "experimentalFeature/list": () => ({
      data: OFF_FEATURES.map((name) => ({ name, stage: "stable", enabled: name === "unified_exec", defaultEnabled: name === "unified_exec", displayName: null, description: null, announcement: null })),
      nextCursor: null,
    }),
    "mcpServerStatus/list": (p, f) => ({ data: [{ name: "companion-readonly", tools: p?.threadId && f.bound.has(p.threadId) ? TOOLS : {} }], nextCursor: null }),
    "thread/start": (p, f) => thread(f.next("thr"), p, f),
    "thread/resume": (p, f) => thread(p.threadId, p, f),
    "thread/unsubscribe": () => ({ status: "unsubscribed" }),
    "turn/start": (_p, f) => ({ turn: { id: f.next("turn"), status: "inProgress", items: [], error: null } }),
    "turn/interrupt": () => ({}),
    "account/read": () => ({ account: { type: "chatgpt", email: null, planType: "plus", workspaceName: null }, requiresOpenaiAuth: true }),
    "account/login/start": () => ({ type: "chatgpt", loginId: "l1", authUrl: "https://auth.example/start" }),
  };
}

export function fakeSpawn(handlers: () => Record<string, Handler> = goodHandlers): { spawn: SpawnFn; servers: FakeAppServer[] } {
  const servers: FakeAppServer[] = [];
  return {
    servers,
    spawn: (launch) => {
      const f = new FakeAppServer(launch, handlers());
      servers.push(f);
      return f.server();
    },
  };
}

export interface FakeGrant { id: string; token: string; launch: LaunchSpec; ttl: number | null; revoked: boolean }

/** Records grants; tests emit broker events by hand. Like the real acceptor, more than `maxLive` live grants is a
 * refused connection, and an unhealthy broker must be restarted. */
export class FakeBroker implements RelayBroker {
  readonly grants: FakeGrant[] = [];
  isHealthy = true;
  restarts = 0;
  restartFails = false;
  maxLive = 16;
  #listeners = new Set<(e: BrokerEvent) => void>();

  healthy(): boolean {
    return this.isHealthy;
  }
  async restart(): Promise<void> {
    this.restarts++;
    if (this.restartFails) throw new Error("SYNTHETIC: a foreign listener holds the socket");
    this.isHealthy = true;
  }
  live(): number {
    return this.grants.filter((g) => !g.revoked).length;
  }
  grant(launch: LaunchSpec): RelayGrant {
    const g: FakeGrant = { id: `g${this.grants.length + 1}`, token: newToken(), launch, ttl: null, revoked: false };
    this.grants.push(g);
    if (this.live() > this.maxLive) this.emit({ type: "refused", reason: "too many connections" });
    return {
      id: g.id,
      token: g.token,
      arm: (ttlMs) => {
        g.ttl = ttlMs ?? null;
      },
      revoke: () => {
        g.revoked = true;
      },
    };
  }
  on(l: (e: BrokerEvent) => void): () => void {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  }
  emit(e: BrokerEvent): void {
    for (const l of this.#listeners) l(e);
  }
}
