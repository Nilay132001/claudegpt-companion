import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_KIND_KEY, APPROVAL_KIND_MCP_TOOL_CALL, COMPANION_ALLOWLIST, decideServerRequest, identifyToolApproval,
  NOT_PERMITTED, READ_ONLY_REJECTION, type InFlightToolCall, type ToolCallLookup,
} from "../../src/codex/serverRequests.ts";

const none: ToolCallLookup = () => null;
const inflight = (tool: string, server = "companion-readonly"): ToolCallLookup =>
  (threadId, _callId, s) => (s === server ? ({ threadId, itemId: "i1", server, tool } satisfies InFlightToolCall) : null);

function elicitation(over: Record<string, unknown> = {}, meta: Record<string, unknown> | null = { [APPROVAL_KIND_KEY]: APPROVAL_KIND_MCP_TOOL_CALL, tool_name: "read_file" }) {
  return { threadId: "t1", turnId: "u1", serverName: "companion-readonly", mode: "form", message: "Allow?", requestedSchema: { type: "object", properties: {} }, _meta: meta, ...over };
}
const decide = (method: string, params: unknown, lookup = none) => decideServerRequest(method, params, COMPANION_ALLOWLIST, lookup);
const ACCEPT = { result: { action: "accept", content: null, _meta: null } };
const DECLINE = { result: { action: "decline", content: null, _meta: null } };

test("command and file-change approvals are declined with an alert", () => {
  for (const m of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
    const d = decide(m, { threadId: "t1", turnId: "u1", itemId: "i1" });
    assert.deepEqual(d.reply, { result: { decision: "decline" } }, m);
    assert.equal(d.outcome, "declined");
    assert.ok(d.alert);
  }
});

test("legacy exec and patch approvals are denied", () => {
  for (const m of ["execCommandApproval", "applyPatchApproval"]) {
    const d = decide(m, {});
    assert.deepEqual(d.reply, { result: { decision: { denied: { rejection: READ_ONLY_REJECTION } } } });
    assert.equal(d.outcome, "denied");
  }
});

test("an allowlisted tool-call approval is accepted (tool from _meta)", () => {
  const d = decide("mcpServer/elicitation/request", elicitation());
  assert.deepEqual(d.reply, ACCEPT);
  assert.equal(d.outcome, "accepted");
  assert.equal(d.alert, null);
});

test("the tool name can come from the in-flight mcpToolCall item", () => {
  const p = elicitation({}, { [APPROVAL_KIND_KEY]: APPROVAL_KIND_MCP_TOOL_CALL, call_id: "i1" });
  assert.deepEqual(decide("mcpServer/elicitation/request", p, inflight("git_status")).reply, ACCEPT);
  assert.deepEqual(identifyToolApproval(p, inflight("git_status")), { server: "companion-readonly", tool: "git_status" });
});

test("everything else is declined", () => {
  const cases: Array<[string, unknown, ToolCallLookup]> = [
    ["other server", elicitation({ serverName: "atlassian" }), none],
    ["other tool", elicitation({}, { [APPROVAL_KIND_KEY]: APPROVAL_KIND_MCP_TOOL_CALL, tool_name: "write_file" }), none],
    ["meta and item disagree", elicitation(), inflight("search")],
    ["url mode", { threadId: "t1", turnId: null, serverName: "companion-readonly", mode: "url", message: "Sign in", url: "https://x.example", elicitationId: "e", _meta: null }, none],
    ["openai/form mode", elicitation({ mode: "openai/form" }), none],
    ["openaiForm mode", elicitation({ mode: "openaiForm" }), none],
    ["form without approval kind", elicitation({}, { tool_name: "read_file" }), none],
    ["no _meta", elicitation({}, null), none],
    ["no tool name anywhere", elicitation({}, { [APPROVAL_KIND_KEY]: APPROVAL_KIND_MCP_TOOL_CALL }), none],
    ["conflicting tool name keys", elicitation({}, { [APPROVAL_KIND_KEY]: APPROVAL_KIND_MCP_TOOL_CALL, tool_name: "read_file", toolName: "write_file" }), none],
    ["conflicting call id keys", elicitation({}, { [APPROVAL_KIND_KEY]: APPROVAL_KIND_MCP_TOOL_CALL, tool_name: "read_file", call_id: "a", callId: "b" }), inflight("read_file")],
    ["call id not in flight", elicitation({}, { [APPROVAL_KIND_KEY]: APPROVAL_KIND_MCP_TOOL_CALL, tool_name: "read_file", call_id: "i1" }), none],
    ["not an object", "junk", none],
  ];
  for (const [why, params, lookup] of cases) {
    assert.deepEqual(decide("mcpServer/elicitation/request", params, lookup).reply, DECLINE, why);
  }
});

test("other request types get a JSON-RPC error", () => {
  for (const m of [
    "item/permissions/requestApproval", "item/tool/call", "item/tool/requestUserInput",
    "account/chatgptAuthTokens/refresh", "attestation/generate", "something/new",
  ]) {
    const d = decide(m, {});
    assert.deepEqual(d.reply, { error: NOT_PERMITTED }, m);
    assert.equal(d.outcome, "errored");
  }
  assert.equal(decide("account/chatgptAuthTokens/refresh", {}).alert, null); // expected in keyring mode, no alert
  assert.ok(decide("item/tool/call", {}).alert);
  assert.match(decide("something/new", {}).alert ?? "", /something\/new/);
});
