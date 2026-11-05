import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeGuard, type GuardAlert } from "../../src/codex/guard.ts";
import { APPROVAL_KIND_KEY, COMPANION_ALLOWLIST, decideServerRequest } from "../../src/codex/serverRequests.ts";

function setup() {
  const interrupts: string[] = [];
  const alerts: GuardAlert[] = [];
  const g = new RuntimeGuard(COMPANION_ALLOWLIST, {
    interrupt: async (t, u) => { interrupts.push(`${t}/${u}`); },
    alert: (a) => alerts.push(a),
  });
  const started = (item: Record<string, unknown>, turnId = "u1") => g.onNotification("item/started", { threadId: "t1", turnId, item, startedAtMs: 1 });
  return { g, interrupts, alerts, started };
}

test("allowlisted item types pass", () => {
  const { interrupts, started } = setup();
  for (const type of ["userMessage", "agentMessage", "reasoning", "plan", "contextCompaction"]) started({ type, id: type });
  started({ type: "mcpToolCall", id: "m1", server: "companion-readonly", tool: "read_file", status: "inProgress" });
  assert.deepEqual(interrupts, []);
});

test("every other item type interrupts the turn and alerts", () => {
  for (const type of [
    "commandExecution", "fileChange", "webSearch", "imageView", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity",
    "imageGeneration", "functionCallOutput", "sleep", "hookPrompt", "enteredReviewMode", "exitedReviewMode", "mysteryItem",
  ]) {
    const { interrupts, alerts, started } = setup();
    started({ type, id: "x" });
    assert.deepEqual(interrupts, ["t1/u1"], type);
    assert.equal(alerts[0]?.itemType, type);
  }
});

test("mcpToolCall on another tool or server interrupts", () => {
  for (const [server, tool] of [["companion-readonly", "write_file"], ["atlassian", "read_file"]]) {
    const { interrupts, started } = setup();
    started({ type: "mcpToolCall", id: "m", server, tool });
    assert.deepEqual(interrupts, ["t1/u1"], `${server}/${tool}`);
  }
});

test("an item without a type, and item/completed, are checked too", () => {
  const { g, interrupts } = setup();
  g.onNotification("item/completed", { threadId: "t1", turnId: "u2", item: { id: "z" }, completedAtMs: 1 });
  assert.deepEqual(interrupts, ["t1/u2"]);
});

test("one interrupt per turn", () => {
  const { interrupts, alerts, started } = setup();
  started({ type: "commandExecution", id: "a" });
  started({ type: "fileChange", id: "b" });
  assert.deepEqual(interrupts, ["t1/u1"]);
  assert.equal(alerts.length, 2);
});

test("fileChange item/started before its approval request: interrupted and declined", () => {
  const { g, interrupts, started } = setup();
  started({ type: "fileChange", id: "f1", changes: [], status: "inProgress" });
  const d = decideServerRequest("item/fileChange/requestApproval", { threadId: "t1", turnId: "u1", itemId: "f1" }, COMPANION_ALLOWLIST, g.lookup);
  assert.deepEqual(interrupts, ["t1/u1"]);
  assert.deepEqual(d.reply, { result: { decision: "decline" } });
});

test("in-flight tool calls feed the elicitation lookup", () => {
  const { g, started } = setup();
  started({ type: "mcpToolCall", id: "m1", server: "companion-readonly", tool: "search" });
  assert.equal(g.lookup("t1", "m1", "companion-readonly")?.tool, "search");
  assert.equal(g.lookup("t1", null, "companion-readonly")?.tool, "search"); // only one in flight
  started({ type: "mcpToolCall", id: "m2", server: "companion-readonly", tool: "git_diff" });
  assert.equal(g.lookup("t1", null, "companion-readonly"), null); // ambiguous
  assert.equal(g.lookup("t1", "m1", "other"), null); // server must match
  g.onNotification("item/completed", { threadId: "t1", turnId: "u1", item: { type: "mcpToolCall", id: "m1", server: "companion-readonly", tool: "search" } });
  assert.equal(g.lookup("t1", "m1", "companion-readonly"), null);
  g.onNotification("turn/completed", { threadId: "t1", turn: { id: "u1", status: "completed" } });
  assert.equal(g.lookup("t1", "m2", "companion-readonly"), null);
  const p = { threadId: "t1", turnId: "u1", serverName: "companion-readonly", mode: "form", _meta: { [APPROVAL_KIND_KEY]: "mcp_tool_call" } };
  assert.equal(decideServerRequest("mcpServer/elicitation/request", p, COMPANION_ALLOWLIST, g.lookup).outcome, "declined");
});

test("a rejected interrupt alerts and is retried on the next bad item", async () => {
  const alerts: GuardAlert[] = [];
  let calls = 0;
  const g = new RuntimeGuard(COMPANION_ALLOWLIST, {
    interrupt: async () => { calls++; if (calls === 1) throw new Error("/secret/path failed"); },
    alert: (a) => alerts.push(a),
  });
  const bad = (id: string) => g.onNotification("item/started", { threadId: "t1", turnId: "u1", item: { type: "commandExecution", id } });
  bad("a");
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  const failure = alerts.find((a) => a.itemType === "interrupt");
  assert.ok(failure);
  assert.ok(!failure.detail.includes("secret"));
  bad("b");
  assert.equal(calls, 2);
  bad("c");
  assert.equal(calls, 2); // the retry went through, so no third
});

test("an interrupt that throws synchronously does not escape and is retried", () => {
  const alerts: GuardAlert[] = [];
  let calls = 0;
  const g = new RuntimeGuard(COMPANION_ALLOWLIST, {
    interrupt: () => { calls++; throw new Error("boom"); },
    alert: (a) => alerts.push(a),
  });
  const bad = () => g.onNotification("item/started", { threadId: "t1", turnId: "u1", item: { type: "fileChange", id: "x" } });
  assert.doesNotThrow(bad);
  assert.doesNotThrow(bad);
  assert.equal(calls, 2);
  assert.ok(alerts.some((a) => a.itemType === "interrupt"));
});

test("a second turn on the same thread gets its own interrupt; turn/completed prunes", () => {
  const { g, interrupts, started } = setup();
  started({ type: "commandExecution", id: "a" }, "u1");
  g.onNotification("turn/completed", { threadId: "t1", turn: { id: "u1", status: "interrupted" } });
  started({ type: "commandExecution", id: "b" }, "u2");
  assert.deepEqual(interrupts, ["t1/u1", "t1/u2"]);
  started({ type: "commandExecution", id: "c" }, "u1"); // u1 was pruned, so a stray late item interrupts again
  assert.deepEqual(interrupts, ["t1/u1", "t1/u2", "t1/u1"]);
});
