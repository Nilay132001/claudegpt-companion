// companion-readonly: MCP over newline-delimited JSON-RPC on stdio (spec §3, §7.2).
import type { Readable, Writable } from "node:stream";
import { LineBuffer } from "../lineBuffer.ts";
import { runTool, type JailContext } from "./tools.ts";

export const SERVER_NAME = "companion-readonly";
export const TOOL_NAMES = ["list_dir", "read_file", "search", "git_status", "git_diff"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

export type ServerState = { kind: "ready"; ctx: JailContext } | { kind: "refused"; reason: string };

const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const pathProp = { type: "string", description: "Path relative to the repository root." };

export const TOOL_DEFS = [
  {
    name: "list_dir",
    description: "List a folder in the selected repository. Read-only. Hidden: secrets, .git, dependency folders.",
    inputSchema: { type: "object", properties: { path: pathProp }, additionalProperties: false },
    annotations,
  },
  {
    name: "read_file",
    description: "Read a text file in the selected repository, with line numbers. Up to 2000 lines per call. Read-only.",
    inputSchema: {
      type: "object",
      properties: { path: pathProp, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: "search",
    description: "Search tracked and untracked files for a fixed string (git grep). Up to 500 hits. Read-only.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: "git_status",
    description: "Show the branch and uncommitted changes. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations,
  },
  {
    name: "git_diff",
    description: "Show uncommitted changes (working tree vs HEAD), optionally under one path. Read-only.",
    inputSchema: { type: "object", properties: { path: pathProp }, additionalProperties: false },
    annotations,
  },
];

type Json = Record<string, unknown>;
const result = (id: unknown, r: unknown): Json => ({ jsonrpc: "2.0", id, result: r });
const rpcError = (id: unknown, code: number, message: string): Json => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolReply = (id: unknown, text: string, isError: boolean): Json =>
  result(id, { content: [{ type: "text", text }], isError });

export async function handleMessage(state: ServerState, raw: unknown): Promise<Json | null> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return rpcError(null, -32600, "Invalid Request");
  const msg = raw as Json;
  const id = msg.id;
  if (id === undefined || id === null) return null; // notification
  if (typeof msg.method !== "string") return rpcError(id, -32600, "Invalid Request");
  const params = (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as Json;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return result(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: "0.2.0" },
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOL_DEFS });
    case "tools/call": {
      if (state.kind === "refused") return toolReply(id, state.reason, true);
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) return toolReply(id, "arguments must be an object.", true);
      const r = await runTool(state.ctx, name, args as Record<string, unknown>);
      return toolReply(id, r.text, r.isError);
    }
    default:
      return rpcError(id, -32601, "Method not found");
  }
}

const MAX_LINE_BYTES = 1024 * 1024;

export function serveStdio(state: ServerState, input: Readable, output: Writable): Promise<void> {
  const lb = new LineBuffer();
  let chain: Promise<void> = Promise.resolve();
  const send = (m: Json) => {
    output.write(`${JSON.stringify(m)}\n`);
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
      const reply = await handleMessage(state, msg);
      if (reply) send(reply);
    } catch {
      send(rpcError(null, -32603, "Internal error"));
    }
  };
  return new Promise((resolve) => {
    input.on("data", (chunk: Buffer) => {
      for (const line of lb.push(chunk)) chain = chain.then(() => handleLine(line));
      if (lb.pendingBytes > MAX_LINE_BYTES) {
        lb.reset();
        chain = chain.then(() => send(rpcError(null, -32700, "Message too large")));
      }
    });
    input.on("end", () => {
      void chain.then(resolve);
    });
  });
}
