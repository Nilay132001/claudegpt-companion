// Line-delimited JSON-RPC client for `codex app-server` (no "jsonrpc" field, as Codex sends it).
import type { Readable, Writable } from "node:stream";
import { LineBuffer } from "../lineBuffer.ts";

export interface RpcErrorBody { code: number; message: string; data?: unknown }
export type ServerReply = { result: unknown } | { error: RpcErrorBody };
export type ServerRequestHandler = (method: string, params: unknown) => Promise<ServerReply>;
export type NotificationListener = (method: string, params: unknown) => void;
export interface RpcTransport { input: Readable; output: Writable; stderr?: Readable | null }
export interface RpcStats { malformedLines: number; unknownResponseIds: number; serverRequests: number; stderrBytes: number }

export const DEFAULT_TIMEOUT_MS = 30_000;
export const HANDLER_FAILED: RpcErrorBody = { code: -32603, message: "companion: request handler failed" };

export class RpcError extends Error {
  readonly code: number;
  constructor(body: RpcErrorBody) {
    super(body.message);
    this.name = "RpcError";
    this.code = body.code;
  }
}
export class RpcTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`${method}: no reply after ${ms} ms`);
    this.name = "RpcTimeoutError";
  }
}
export class RpcClosedError extends Error {
  constructor(detail: string) {
    super(`app-server connection closed (${detail})`);
    this.name = "RpcClosedError";
  }
}
export class RpcMethodNotAllowedError extends Error {
  constructor(method: string) {
    super(`companion never calls ${method}`);
    this.name = "RpcMethodNotAllowedError";
  }
}

type Id = number | string;
interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

const isId = (v: unknown): v is Id => typeof v === "number" || typeof v === "string";

export class RpcClient {
  readonly stats: RpcStats = { malformedLines: 0, unknownResponseIds: 0, serverRequests: 0, stderrBytes: 0 };
  #out: Writable;
  #next = 1;
  #pending = new Map<Id, Pending>();
  #listeners = new Set<NotificationListener>();
  #closeListeners = new Set<(e: RpcClosedError) => void>();
  #handler: ServerRequestHandler;
  #allowed: ReadonlySet<string>;
  #timeoutMs: number;
  #closed: RpcClosedError | null = null;
  #lines = new LineBuffer();

  constructor(t: RpcTransport, opts: { allowedMethods: readonly string[]; onServerRequest: ServerRequestHandler; timeoutMs?: number }) {
    this.#out = t.output;
    this.#handler = opts.onServerRequest;
    this.#allowed = new Set(opts.allowedMethods);
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    t.input.on("data", (chunk: Buffer) => {
      for (const line of this.#lines.push(chunk)) this.#onLine(line);
    });
    t.input.on("end", () => this.close("stdout ended"));
    t.input.on("close", () => this.close("stdout closed"));
    t.input.on("error", () => this.close("stdout error"));
    t.output.on("error", () => this.close("stdin error"));
    // M1 carry-over: Codex stderr can contain local paths. Count it; never keep or log it.
    t.stderr?.on("data", (chunk: Buffer) => {
      this.stats.stderrBytes += chunk.length;
    });
  }

  get isClosed(): boolean {
    return this.#closed !== null;
  }

  onNotification(l: NotificationListener): () => void {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  }

  onClose(l: (e: RpcClosedError) => void): () => void {
    this.#closeListeners.add(l);
    return () => {
      this.#closeListeners.delete(l);
    };
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.#timeoutMs): Promise<T> {
    if (!this.#allowed.has(method)) return Promise.reject(new RpcMethodNotAllowedError(method));
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.#send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.#allowed.has(method)) throw new RpcMethodNotAllowedError(method);
    if (this.#closed) return;
    this.#send(params === undefined ? { method } : { method, params });
  }

  close(detail: string): void {
    if (this.#closed) return;
    const err = new RpcClosedError(detail);
    this.#closed = err;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
    for (const l of this.#closeListeners) {
      try {
        l(err);
      } catch {
        // a listener bug must not stop the others
      }
    }
  }

  #send(msg: Record<string, unknown>): void {
    this.#out.write(JSON.stringify(msg) + "\n");
  }

  #onLine(line: string): void {
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      this.stats.malformedLines++;
      return;
    }
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      this.stats.malformedLines++;
      return;
    }
    const msg = m as Record<string, unknown>;
    const method = typeof msg.method === "string" ? msg.method : null;
    if (method !== null && isId(msg.id)) {
      this.stats.serverRequests++;
      void this.#answer(msg.id, method, msg.params);
      return;
    }
    if (method !== null) {
      for (const l of this.#listeners) {
        try {
          l(method, msg.params);
        } catch {
          // a listener bug must not stop the others
        }
      }
      return;
    }
    if (!isId(msg.id)) {
      this.stats.malformedLines++;
      return;
    }
    const p = this.#pending.get(msg.id);
    if (!p) {
      this.stats.unknownResponseIds++;
      return;
    }
    this.#pending.delete(msg.id);
    clearTimeout(p.timer);
    const e = msg.error;
    if (e !== null && typeof e === "object") {
      const body = e as Record<string, unknown>;
      p.reject(new RpcError({
        code: typeof body.code === "number" ? body.code : -32000,
        message: typeof body.message === "string" ? body.message : "app-server error",
      }));
    } else {
      p.resolve(msg.result);
    }
  }

  async #answer(id: Id, method: string, params: unknown): Promise<void> {
    let reply: ServerReply;
    try {
      reply = await this.#handler(method, params);
    } catch {
      reply = { error: HANDLER_FAILED };
    }
    if (this.#closed) return;
    this.#send({ id, ...reply });
  }
}
