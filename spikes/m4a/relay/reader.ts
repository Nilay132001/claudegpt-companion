// SPIKE (M4a option b). The companiond-side reader: listens on one unix socket (0600, in a 0700 folder) and,
// per authorized connection, spawns the M2 jail (buildReadonlyLaunch, its own Seatbelt profile, OUTSIDE
// Codex's sandbox) and relays line-delimited JSON-RPC between the two, validating every line both ways.
// Authorization: the first line must be a one-time 64-hex token that companiond put into ONE thread's
// per-thread config (env of the relay). The token also picks the root: Codex never names a root itself.
// Anything unexpected closes the connection and kills the jail. Fail closed: a listener error exits.
//
// Run as its own process (so a test can kill it): node reader.ts <socketPath>
// stdin, one JSON line: {"grants":[{"token":"<64 hex>","kind":"jail"|"probe","root":"/abs"}],"fake":"/abs/fakeMcp.ts"}
// stdout: one JSON event per line (no tokens, no paths, no message bodies).
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { buildReadonlyLaunch, type LaunchSpec } from "../../../companiond/src/launch/seatbelt.ts";
import { TOOL_NAMES } from "../../../companiond/src/jail/mcpServer.ts";
import { LineBuffer } from "../../../companiond/src/lineBuffer.ts";
import { discoverToolchain } from "../../../companiond/src/launch/toolchain.ts";

export const MAX_LINE_BYTES = 1024 * 1024;
export const TOKEN_TIMEOUT_MS = 3000;
export const MAX_CONNECTIONS = 8;
const CLIENT_METHODS = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"]);
// Measured: Codex 0.166.0 asks every MCP server for resources/list right after tools/list, even though the jail
// advertises only `tools`. Closing on it would kill the server for the whole thread, so the reader answers these
// listing requests itself with "Method not found" (what the jail answers too). They never reach the jail.
const ANSWERED_LOCALLY = new Set(["resources/list", "resources/templates/list", "prompts/list"]);

type Json = Record<string, unknown>;
interface Grant { kind: "jail" | "probe"; launch: LaunchSpec; tools: readonly string[] }

const emit = (e: Json) => process.stdout.write(`${JSON.stringify(e)}\n`);
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown) => typeof v === "string" || typeof v === "number";

/** A line to forward to the jail, a reply to send back without forwarding, or the reason to close. */
export type ClientVerdict = { forward: Json } | { local: Json } | string;

export function checkClientLine(line: string, tools: readonly string[]): ClientVerdict {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return "client: not JSON";
  }
  if (!isObj(m) || m.jsonrpc !== "2.0") return "client: not a JSON-RPC 2.0 object";
  if (typeof m.method === "string" && ANSWERED_LOCALLY.has(m.method) && isId(m.id)) {
    return { local: { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } } };
  }
  if (typeof m.method !== "string" || !CLIENT_METHODS.has(m.method)) return "client: method not allowed";
  const note = m.method.startsWith("notifications/");
  if (note ? "id" in m : !isId(m.id)) return "client: bad id";
  if ("params" in m && !isObj(m.params)) return "client: bad params";
  if (m.method === "tools/call") {
    const name = (m.params as Json | undefined)?.name;
    if (typeof name !== "string" || !tools.includes(name)) return "client: tool not allowed";
  }
  return { forward: { jsonrpc: "2.0", ...(note ? {} : { id: m.id }), method: m.method, ...("params" in m ? { params: m.params } : {}) } };
}

export function checkServerLine(line: string): Json | string {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return "server: not JSON";
  }
  if (!isObj(m) || m.jsonrpc !== "2.0" || "method" in m) return "server: not a response";
  if (!(isId(m.id) || m.id === null) || ("result" in m) === ("error" in m)) return "server: bad response";
  return "result" in m ? { jsonrpc: "2.0", id: m.id, result: m.result } : { jsonrpc: "2.0", id: m.id, error: m.error };
}

const digest = (s: string) => crypto.createHash("sha256").update(s).digest();

async function main(): Promise<void> {
  const socketPath = process.argv[2];
  if (!socketPath) throw new Error("usage: reader.ts <socketPath>");
  const cfg = JSON.parse(await new Promise<string>((res) => {
    let b = "";
    process.stdin.on("data", (c: Buffer) => {
      b += c.toString("utf8");
      const nl = b.indexOf("\n");
      if (nl >= 0) res(b.slice(0, nl));
    });
  })) as { grants: { token: string; kind: "jail" | "probe"; root: string }[]; fake: string };
  // Parent gone = companiond gone: stop serving.
  process.stdin.on("end", () => process.exit(0));

  const tc = discoverToolchain();
  const grants = new Map<Buffer, Grant>();
  for (const g of cfg.grants) {
    if (!/^[0-9a-f]{64}$/.test(g.token)) throw new Error("bad token shape");
    const l = await buildReadonlyLaunch({ root: g.root, toolchain: tc });
    const launch: LaunchSpec = g.kind === "jail" ? l : {
      command: l.command,
      args: [l.args[0] as string, l.args[1] as string, tc.nodePath, cfg.fake],
      env: { ...l.env, FAKE_ROOT: l.env.COMPANION_ROOT as string, FAKE_GIT: tc.gitPath, FAKE_PROBE: "1" },
      cwd: l.cwd,
    };
    grants.set(digest(g.token), { kind: g.kind, launch, tools: g.kind === "jail" ? TOOL_NAMES : ["whereami"] });
  }

  // Constant-time over every grant; a used token is removed (one connection per token).
  const take = (token: string): Grant | null => {
    const d = digest(token);
    let hit: Buffer | null = null;
    for (const k of grants.keys()) if (crypto.timingSafeEqual(k, d)) hit = k;
    if (!hit) return null;
    const g = grants.get(hit) ?? null;
    grants.delete(hit);
    return g;
  };

  let open = 0;
  let seq = 0;
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    const id = ++seq;
    open++;
    let closed = false;
    let child: ChildProcess | null = null;
    let head = Buffer.alloc(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = (reason: string) => {
      if (closed) return;
      closed = true;
      open--;
      clearTimeout(timer);
      emit({ ev: "close", conn: id, reason });
      sock.destroy();
      if (child && child.exitCode === null) child.kill("SIGKILL");
    };
    sock.on("error", () => close("socket error"));
    sock.on("close", () => close("socket closed"));
    if (open > MAX_CONNECTIONS) return close("too many connections");
    timer = setTimeout(() => close("no token in time"), TOKEN_TIMEOUT_MS);

    const fromClient = new LineBuffer({ maxLineBytes: MAX_LINE_BYTES });
    const fromServer = new LineBuffer({ maxLineBytes: MAX_LINE_BYTES });
    let grant: Grant | null = null;
    const pump = (chunk: Buffer) => {
      if (closed || !grant || !child?.stdin) return;
      const lines = fromClient.push(chunk);
      if (fromClient.oversizedLines || fromClient.invalidUtf8Lines) return close("client: oversized or invalid line");
      for (const line of lines) {
        const r = checkClientLine(line, grant.tools);
        if (typeof r === "string") {
          // Diagnostics only: the refused method's name (never params), so the allowlist can be checked.
          let m: unknown;
          try { m = (JSON.parse(line) as Json).method; } catch {}
          emit({ ev: "refused", conn: id, method: typeof m === "string" ? m.slice(0, 64) : null });
          return close(r);
        }
        if ("local" in r) {
          emit({ ev: "answered-locally", conn: id });
          sock.write(`${JSON.stringify(r.local)}\n`);
          continue;
        }
        emit({ ev: "method", conn: id, method: r.forward.method });
        child.stdin.write(`${JSON.stringify(r.forward)}\n`);
      }
    };
    sock.on("end", () => child?.stdin?.end());
    sock.on("data", (chunk: Buffer) => {
      if (closed) return;
      if (grant) return pump(chunk);
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(0x0a);
      if (nl < 0) {
        if (head.length > 64) close("unauthorized: no token line");
        return;
      }
      const token = head.subarray(0, nl).toString("latin1");
      const rest = head.subarray(nl + 1);
      head = Buffer.alloc(0);
      const g = /^[0-9a-f]{64}$/.test(token) ? take(token) : null;
      if (!g) return close("unauthorized: bad token");
      clearTimeout(timer);
      grant = g;
      const c = spawn(g.launch.command, g.launch.args, { env: g.launch.env, cwd: g.launch.cwd, stdio: ["pipe", "pipe", "ignore"] });
      child = c;
      emit({ ev: "accept", conn: id, kind: g.kind, jailPid: c.pid ?? null });
      c.on("error", () => close("jail spawn error"));
      c.on("exit", (code, sig) => {
        emit({ ev: "jail-gone", conn: id });
        close(`jail exited ${code ?? sig}`);
      });
      c.stdin?.on("error", () => close("jail stdin error"));
      c.stdout?.on("data", (chunk: Buffer) => {
        if (closed) return;
        const lines = fromServer.push(chunk);
        if (fromServer.oversizedLines || fromServer.invalidUtf8Lines) return close("server: oversized or invalid line");
        for (const line of lines) {
          const r = checkServerLine(line);
          if (typeof r === "string") return close(r);
          sock.write(`${JSON.stringify(r)}\n`);
        }
      });
      if (rest.length) pump(rest);
    });
  });
  server.on("error", () => process.exit(1)); // fail closed
  const old = process.umask(0o077);
  server.listen(socketPath, () => {
    process.umask(old);
    fs.chmodSync(socketPath, 0o600);
    emit({ ev: "listening", mode: (fs.statSync(socketPath).mode & 0o777).toString(8) });
  });
  const stop = () => {
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", stop);
}

if (import.meta.main) {
  main().catch(() => process.exit(1));
}
