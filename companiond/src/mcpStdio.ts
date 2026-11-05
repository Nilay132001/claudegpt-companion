// Newline-delimited JSON-RPC over stdio, shared by companion-readonly and companion-jira (spec §3, §11).
import type { Readable, Writable } from "node:stream";
import { LineBuffer } from "./lineBuffer.ts";

/** MCP protocol versions both servers answer initialize with (the newest first). Here, not in src/jail/, so that
 * companion-jira, which holds the token, loads no jail code (final review M-3). */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Json = Record<string, unknown>;
const MAX_LINE_BYTES = 1024 * 1024;
const rpcError = (id: unknown, code: number, message: string): Json => ({ jsonrpc: "2.0", id, error: { code, message } });

// The id of a parsed request, when it has a usable one (for error replies).
function requestId(msg: unknown): string | number | null {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return null;
  const id = (msg as Json).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

export function serveLines(input: Readable, output: Writable, handle: (raw: unknown) => Promise<Json | null>): Promise<void> {
  const lb = new LineBuffer({ maxLineBytes: MAX_LINE_BYTES });
  let repliedInvalid = 0;
  let repliedOversized = 0;
  let chain: Promise<void> = Promise.resolve();
  let closed = false; // the reader went away (EPIPE): stop writing, stop reading
  const send = (m: Json) => {
    if (!closed) output.write(`${JSON.stringify(m)}\n`);
  };
  const handleLine = async (line: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send(rpcError(null, -32700, "Parse error"));
      return;
    }
    try {
      const reply = await handle(msg);
      if (reply) send(reply);
    } catch {
      send(rpcError(requestId(msg), -32603, "Internal error"));
    }
  };
  return new Promise((resolve) => {
    output.on("error", () => {
      closed = true;
      input.destroy();
      resolve();
    });
    input.on("data", (chunk: Buffer) => {
      for (const line of lb.push(chunk)) chain = chain.then(() => handleLine(line));
      // Lines LineBuffer drops still get a reply, so a client never waits forever.
      while (repliedInvalid < lb.invalidUtf8Lines) {
        repliedInvalid++;
        chain = chain.then(() => send(rpcError(null, -32700, "Parse error")));
      }
      while (repliedOversized < lb.oversizedLines) {
        repliedOversized++;
        chain = chain.then(() => send(rpcError(null, -32700, "Message too large")));
      }
    });
    input.on("error", () => {
      void chain.then(resolve);
    });
    input.on("end", () => {
      void chain.then(resolve);
    });
  });
}
