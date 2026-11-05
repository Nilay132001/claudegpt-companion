// companion-jira: MCP over newline-delimited JSON-RPC on stdio (owner ruling B). Only initialize, ping, tools/list and
// tools/call; the validator in front of it allows nothing else either.
import { SUPPORTED_PROTOCOL_VERSIONS } from "../jail/mcpServer.ts";
import { JIRA_SERVER_NAME, JIRA_TOOL_DEFS, runJiraTool, type JiraApi } from "./tools.ts";

export type JiraServerState = { kind: "ready"; api: JiraApi } | { kind: "refused"; reason: string };
type Json = Record<string, unknown>;
const result = (id: unknown, r: unknown): Json => ({ jsonrpc: "2.0", id, result: r });
const rpcError = (id: unknown, code: number, message: string): Json => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolReply = (id: unknown, text: string, isError: boolean): Json => result(id, { content: [{ type: "text", text }], isError });

export async function handleJiraMessage(state: JiraServerState, raw: unknown): Promise<Json | null> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return rpcError(null, -32600, "Invalid Request");
  const msg = raw as Json;
  const id = msg.id;
  if (id === undefined || id === null) return null;
  if (typeof msg.method !== "string") return rpcError(id, -32600, "Invalid Request");
  const params = (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as Json;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return result(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: JIRA_SERVER_NAME, version: "0.6.0" },
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: JIRA_TOOL_DEFS });
    case "tools/call": {
      if (state.kind === "refused") return toolReply(id, state.reason, true);
      const args = params.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) return toolReply(id, "arguments must be an object.", true);
      const r = await runJiraTool(state.api, typeof params.name === "string" ? params.name : "", args as Json);
      return toolReply(id, r.text, r.isError);
    }
    default:
      return rpcError(id, -32601, "Method not found");
  }
}
