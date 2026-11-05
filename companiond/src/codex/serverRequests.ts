// One reply per app-server request type (spec §7.1.4). Shapes from the Codex 0.166.0 generated types.
import { SERVER_NAME, TOOL_NAMES } from "../jail/mcpServer.ts";
import type { RpcErrorBody, ServerReply } from "./rpc.ts";

export type ToolAllowlist = ReadonlyMap<string, ReadonlySet<string>>;
export interface InFlightToolCall { threadId: string; itemId: string; server: string; tool: string }
/** A null callId must return null when more than one call is in flight. */
export type ToolCallLookup = (threadId: string, callId: string | null, server: string) => InFlightToolCall | null;
export interface ReplyDecision { reply: ServerReply; outcome: "declined" | "denied" | "accepted" | "errored"; alert: string | null }

export const READ_ONLY_REJECTION = "companion is read-only";
export const NOT_PERMITTED: RpcErrorBody = { code: -32000, message: "companion: request not permitted" };
// Measured in Task 3 Step 1 (binary strings) and Task 9 (live _meta keys).
export const APPROVAL_KIND_KEY = "codex_approval_kind";
export const APPROVAL_KIND_MCP_TOOL_CALL = "mcp_tool_call";
export const TOOL_NAME_KEYS: readonly string[] = ["tool_name", "toolName"];
export const CALL_ID_KEYS: readonly string[] = ["call_id", "callId"];

export function toolAllowlist(entries: Record<string, readonly string[]>): ToolAllowlist {
  return new Map(Object.entries(entries).map(([s, tools]) => [s, new Set(tools)]));
}
export const COMPANION_ALLOWLIST: ToolAllowlist = toolAllowlist({ [SERVER_NAME]: TOOL_NAMES });

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
/** The one string under these keys: null when none is set, undefined when several are set and differ. */
const agreed = (o: Record<string, unknown>, keys: readonly string[]): string | null | undefined => {
  const found = new Set<string>();
  for (const k of keys) {
    const s = str(o[k]);
    if (s) found.add(s);
  }
  if (found.size > 1) return undefined;
  return found.size === 1 ? [...found][0]! : null;
};

/** A tool-call approval, or null when it cannot be identified (then it is declined). */
export function identifyToolApproval(params: unknown, lookup: ToolCallLookup): { server: string; tool: string } | null {
  const p = obj(params);
  const server = str(p?.serverName);
  const threadId = str(p?.threadId);
  if (!p || !server || !threadId || p.mode !== "form") return null;
  const meta = obj(p._meta);
  if (!meta || meta[APPROVAL_KIND_KEY] !== APPROVAL_KIND_MCP_TOOL_CALL) return null;
  const metaTool = agreed(meta, TOOL_NAME_KEYS);
  const callId = agreed(meta, CALL_ID_KEYS);
  if (metaTool === undefined || callId === undefined) return null; // conflicting keys
  const item = lookup(threadId, callId, server);
  if (callId && !item) return null; // a named call that is not in flight
  if (metaTool && item && item.tool !== metaTool) return null;
  const tool = metaTool ?? item?.tool ?? null;
  return tool ? { server, tool } : null;
}

const DECLINE_ELICITATION: ServerReply = { result: { action: "decline", content: null, _meta: null } };
const ACCEPT_ELICITATION: ServerReply = { result: { action: "accept", content: null, _meta: null } };
const QUIET_ERRORS = new Set(["account/chatgptAuthTokens/refresh", "attestation/generate"]);
const KNOWN_ERRORS = new Set(["item/permissions/requestApproval", "item/tool/call", "item/tool/requestUserInput"]);

export function decideServerRequest(method: string, params: unknown, allow: ToolAllowlist, lookup: ToolCallLookup): ReplyDecision {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { reply: { result: { decision: "decline" } }, outcome: "declined", alert: "Codex asked to run a command. Declined." };
    case "item/fileChange/requestApproval":
      return { reply: { result: { decision: "decline" } }, outcome: "declined", alert: "Codex asked to change files. Declined." };
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        reply: { result: { decision: { denied: { rejection: READ_ONLY_REJECTION } } } },
        outcome: "denied",
        alert: "Codex asked to run or patch something. Denied.",
      };
    case "mcpServer/elicitation/request": {
      const id = identifyToolApproval(params, lookup);
      if (id && allow.get(id.server)?.has(id.tool)) return { reply: ACCEPT_ELICITATION, outcome: "accepted", alert: null };
      return { reply: DECLINE_ELICITATION, outcome: "declined", alert: "An MCP request was declined." };
    }
    default:
      return {
        reply: { error: NOT_PERMITTED },
        outcome: "errored",
        alert: QUIET_ERRORS.has(method) ? null : KNOWN_ERRORS.has(method) ? `Codex request ${method} refused.` : `Unknown Codex request ${method} refused.`,
      };
  }
}
