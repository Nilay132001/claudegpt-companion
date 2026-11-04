import { test } from "node:test";
import assert from "node:assert/strict";
import { TranscriptParser, trimText, TOOL_OUTPUT_MAX } from "../../src/transcript/parser.ts";
import { assistantLine, MARK, markerLine, userLine } from "../helpers/fixtures.ts";

const S = "cli-a";
const CWD = "/syn/repo";

function bashPair(p: TranscriptParser, id: string, command: string, result: Record<string, unknown>, isError = false, text = "") {
  p.parseLine(assistantLine(S, CWD, [{ type: "tool_use", id, name: "Bash", input: { command } }]));
  const line = userLine(S, CWD, "", {
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] },
    toolUseResult: result,
  });
  const parsed = p.parseLine(line);
  assert.ok(parsed.ok);
  return parsed.events[0];
}

test("user and assistant text", () => {
  const p = new TranscriptParser();
  const u = p.parseLine(userLine(S, CWD, `${MARK} question`));
  assert.ok(u.ok);
  assert.equal(u.cwd, CWD);
  assert.equal(u.gitBranch, "syn-branch");
  assert.deepEqual(u.events.map((e) => e.kind), ["user_text"]);
  const a = p.parseLine(assistantLine(S, CWD, [{ type: "thinking", thinking: "x" }, { type: "text", text: `${MARK} answer` }]));
  assert.ok(a.ok);
  assert.deepEqual(a.events.map((e) => [e.kind, "text" in e ? e.text : ""]), [["assistant_text", `${MARK} answer`]]);
});

test("meta user records give no text", () => {
  const p = new TranscriptParser();
  const r = p.parseLine(userLine(S, CWD, `${MARK} caveat`, { isMeta: true }));
  assert.ok(r.ok);
  assert.deepEqual(r.events, []);
});

test("Bash tool call and result carry command, output, exit code and failure", () => {
  const p = new TranscriptParser();
  const e = bashPair(p, "tu-1", "npm test", { stdout: "# fail 1\n", stderr: "", interrupted: false }, true, "Exit code 1\n# fail 1");
  assert.equal(e.kind, "tool_result");
  if (e.kind !== "tool_result") return;
  assert.equal(e.command, "npm test");
  assert.equal(e.exitCode, 1);
  assert.equal(e.failure?.kind, "test_failure");
});

test("a successful Bash result has exit code 0 and no failure", () => {
  const p = new TranscriptParser();
  const e = bashPair(p, "tu-2", "ls", { stdout: "a\n", stderr: "", interrupted: false });
  assert.ok(e.kind === "tool_result" && e.exitCode === 0 && e.failure === null);
});

test("long tool output is trimmed, keeping the tail", () => {
  const p = new TranscriptParser();
  const big = "x".repeat(10_000) + "END";
  const e = bashPair(p, "tu-3", "cat", { stdout: big, stderr: "" });
  assert.ok(e.kind === "tool_result");
  if (e.kind !== "tool_result") return;
  assert.ok(e.stdout.length < TOOL_OUTPUT_MAX + 100);
  assert.ok(e.stdout.endsWith("END"));
});

test("a failed Bash result with huge stdout still detects the failure at the tail", () => {
  const p = new TranscriptParser();
  const big = "filler line\n".repeat(16_667) + "# fail 1\n";
  assert.ok(big.length > 200_000);
  const e = bashPair(p, "tu-3b", "npm test", { stdout: big, stderr: "" }, true, "Exit code 1");
  assert.ok(e.kind === "tool_result");
  if (e.kind !== "tool_result") return;
  assert.equal(e.failure?.kind, "test_failure");
});

test("edit tools also produce a file_edit event", () => {
  const p = new TranscriptParser();
  const r = p.parseLine(assistantLine(S, CWD, [{ type: "tool_use", id: "tu-4", name: "Edit", input: { file_path: "/syn/repo/a.ts", old_string: "a", new_string: "b" } }]));
  assert.ok(r.ok);
  assert.deepEqual(r.events.map((e) => e.kind), ["tool_call", "file_edit"]);
  assert.equal(r.events[1].kind === "file_edit" && r.events[1].filePath, "/syn/repo/a.ts");
});

test("a subagent tool result becomes a subagent_summary", () => {
  const p = new TranscriptParser();
  p.parseLine(assistantLine(S, CWD, [{ type: "tool_use", id: "tu-5", name: "Task", input: { prompt: MARK } }]));
  const r = p.parseLine(
    userLine(S, CWD, "", {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-5", content: [{ type: "text", text: `${MARK} done` }] }] },
      toolUseResult: { status: "completed", content: [{ type: "text", text: `${MARK} summary` }] },
    }),
  );
  assert.ok(r.ok);
  assert.deepEqual(r.events.map((e) => [e.kind, "text" in e ? e.text : ""]), [["subagent_summary", `${MARK} summary`]]);
});

test("a subagent result without toolUseResult.content falls back to the tool_result block text", () => {
  const p = new TranscriptParser();
  p.parseLine(assistantLine(S, CWD, [{ type: "tool_use", id: "tu-6", name: "Agent", input: { prompt: MARK } }]));
  const r = p.parseLine(
    userLine(S, CWD, "", {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-6", content: [{ type: "text", text: `${MARK} block text` }] }] },
      toolUseResult: {
        isAsync: true,
        status: "async_launched",
        agentId: "agent-syn",
        description: "syn",
        resolvedModel: "syn-model",
        prompt: MARK,
        outputFile: "/syn/out",
        canReadOutputFile: true,
        canContinueAgent: true,
      },
    }),
  );
  assert.ok(r.ok);
  assert.deepEqual(r.events.map((e) => [e.kind, "text" in e ? e.text : ""]), [["subagent_summary", `${MARK} block text`]]);
});

test("unknown record types parse with no events and known=false; known silent types are known", () => {
  const p = new TranscriptParser();
  const u = p.parseLine(JSON.stringify({ type: "future-thing", uuid: "z", note: MARK }));
  assert.ok(u.ok && !u.known && u.events.length === 0);
  const k = p.parseLine(markerLine(S));
  assert.ok(k.ok && k.known);
});

test("state and metadata record types are known and silent; an invented type is unknown", () => {
  const p = new TranscriptParser();
  for (const type of ["atis-latch", "tools-used", "file-history-delta", "bridge-session", "pr-link", "relocated", "cost-state", "mode", "isolation-latch", "worktree-state"]) {
    const r = p.parseLine(JSON.stringify({ type, note: MARK }));
    assert.ok(r.ok && r.known && r.events.length === 0, type);
  }
  const wt = p.parseLine(JSON.stringify({ type: "worktree-state", note: MARK }));
  assert.ok(wt.ok && wt.known && wt.events.length === 0);
  const m = p.parseLine(JSON.stringify({ type: "made-up-type", note: MARK }));
  assert.ok(m.ok && !m.known);
});

test("malformed lines are reported, not thrown", () => {
  const p = new TranscriptParser();
  for (const bad of ["{", "[]", "42", '"x"']) assert.deepEqual(p.parseLine(bad), { ok: false });
});

test("trimText keeps short text as is", () => {
  assert.equal(trimText("abc", 10), "abc");
});

test("trimText never splits a surrogate pair", () => {
  const s = "😀".repeat(50);
  const t = trimText(s, 21);
  assert.equal(t.isWellFormed(), true);
  assert.ok(t.startsWith("😀") && t.endsWith("😀"));
});

test("sidechain records are flagged", () => {
  const p = new TranscriptParser();
  const r = p.parseLine(userLine(S, "/syn/other", "sub", { isSidechain: true }));
  assert.ok(r.ok && r.isSidechain);
});
