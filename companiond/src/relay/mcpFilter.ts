// What the validator lets through between Codex and the jail (spec §7.1.9, §7.2; review C1, I3, M1, M2, M6).
// Pure: no I/O. Every forwarded line is re-serialised from parsed fields, so parser quirks cannot smuggle bytes.
import type { Readable, Writable } from "node:stream";

export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_IN_FLIGHT = 16;
export const MAX_ID_BYTES = 256;
export const IDLE_MS = 30 * 60_000;
/** Validator exit codes, outside Node's own (1–14) and the shell's (126+). The acceptor maps them to a BindingEnd;
 * a signal death or any other code counts as a violation (plan review I-2). */
export const EXIT = { normal: 80, idle: 81, violation: 82, limit: 83, jail: 84, error: 85 } as const;

type Json = Record<string, unknown>;
type Id = string | number;
export type Verdict =
  | { kind: "forward"; line: string }
  | { kind: "local"; line: string }
  | { kind: "drop" }
  | { kind: "close"; code: number; reason: string };

const FORWARDED = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"]);
// Measured (Step 1, code-mode spike): Codex asks every server for these. They never reach the jail and never close.
const LOCAL_RESULTS: Readonly<Record<string, Json>> = {
  "resources/list": { resources: [] },
  "resources/templates/list": { resourceTemplates: [] },
  "prompts/list": { prompts: [] },
};
const LOCAL_ERRORS: Readonly<Record<string, Json>> = { "resources/read": { code: -32002, message: "Resource not found" } };
// Measured (Step 1 item 6): Codex sends this on turn/interrupt. The jail ignores notifications, so it stops here.
const DROPPED = new Set(["notifications/cancelled"]);

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
export function isValidId(v: unknown): v is Id {
  if (typeof v === "string") return Buffer.byteLength(v) <= MAX_ID_BYTES;
  return typeof v === "number" && Number.isSafeInteger(v);
}
const idKey = (id: Id): string => `${typeof id}:${id}`;
const violation = (reason: string): Verdict => ({ kind: "close", code: EXIT.violation, reason });
const out = (m: Json): string => `${JSON.stringify(m)}\n`;
function parse(line: string): Json | null {
  try {
    const m: unknown = JSON.parse(line);
    return isObj(m) ? m : null;
  } catch {
    return null;
  }
}

export class McpFilter {
  readonly #tools: ReadonlySet<string>;
  readonly #outstanding = new Set<string>();

  constructor(tools: readonly string[]) {
    this.#tools = new Set(tools);
  }

  get inFlight(): number {
    return this.#outstanding.size;
  }

  fromClient(line: string): Verdict {
    const m = parse(line);
    if (!m || m.jsonrpc !== "2.0") return violation("client: not a JSON-RPC 2.0 object");
    if (typeof m.method !== "string") return violation("client: not a request or notification");
    if ("result" in m || "error" in m) return violation("client: a response mixed into a request");
    if ("params" in m && !isObj(m.params)) return violation("client: params is not an object");
    const method = m.method;
    const isNote = !("id" in m);
    const params = m.params as Json | undefined;
    if (DROPPED.has(method)) {
      if (!isNote || !params || !isValidId(params.requestId) || ("reason" in params && typeof params.reason !== "string")) {
        return violation("client: bad cancellation");
      }
      return { kind: "drop" };
    }
    const local = LOCAL_RESULTS[method];
    const localError = LOCAL_ERRORS[method];
    if (local || localError) {
      if (isNote || !isValidId(m.id)) return violation("client: bad id");
      return { kind: "local", line: out(local ? { jsonrpc: "2.0", id: m.id, result: local } : { jsonrpc: "2.0", id: m.id, error: localError }) };
    }
    if (!FORWARDED.has(method)) return violation("client: method not allowed");
    if (method.startsWith("notifications/") !== isNote) return violation("client: bad id");
    if (!isNote && !isValidId(m.id)) return violation("client: bad id");
    if (method === "tools/call") {
      if (!params || typeof params.name !== "string" || !this.#tools.has(params.name)) return violation("client: tool not allowed");
      if ("arguments" in params && !isObj(params.arguments)) return violation("client: tool arguments are not an object");
    }
    if (!isNote) {
      const k = idKey(m.id as Id);
      if (this.#outstanding.has(k)) return violation("client: duplicate request id");
      if (this.#outstanding.size >= MAX_IN_FLIGHT) return { kind: "close", code: EXIT.limit, reason: "client: too many requests in flight" };
      this.#outstanding.add(k);
    }
    return { kind: "forward", line: out({ jsonrpc: "2.0", ...(isNote ? {} : { id: m.id }), method, ...("params" in m ? { params } : {}) }) };
  }

  fromServer(line: string): Verdict {
    const m = parse(line);
    if (!m || m.jsonrpc !== "2.0") return violation("server: not a JSON-RPC 2.0 object");
    if ("method" in m) return violation("server: requests and notifications are not allowed");
    const id = m.id;
    if (!isValidId(id)) return violation("server: bad id");
    if (!this.#outstanding.delete(idKey(id))) return violation("server: response to an unknown id");
    if (("result" in m) === ("error" in m)) return violation("server: needs exactly one of result and error");
    if ("result" in m) {
      if (!isObj(m.result)) return violation("server: result is not an object");
      return { kind: "forward", line: out({ jsonrpc: "2.0", id, result: m.result }) };
    }
    const e = m.error;
    if (!isObj(e) || !Number.isSafeInteger(e.code) || typeof e.message !== "string") return violation("server: bad error object");
    return { kind: "forward", line: out({ jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...("data" in e ? { data: e.data } : {}) } }) };
  }
}

const fullFor = new WeakMap<Readable, Set<Writable>>();

/** Write with backpressure (review I3): while any destination of src is full, stop reading src; resume only when
 * every one of them has drained (plan review M-2). */
export function sendLine(dst: Writable, line: string, src: Readable): void {
  if (dst.write(line)) return;
  let full = fullFor.get(src);
  if (!full) {
    full = new Set();
    fullFor.set(src, full);
  }
  if (full.has(dst)) return;
  full.add(dst);
  src.pause();
  const waiting = full;
  dst.once("drain", () => {
    waiting.delete(dst);
    if (waiting.size === 0) src.resume();
  });
}
