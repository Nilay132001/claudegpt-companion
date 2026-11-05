// The exec-cell gate's evaluators (itest/helpers/gateEval.ts): pure, no listener, no Codex. Every case here once
// passed a bad cell (review fix round 2), so the gate must fail closed on each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_NESTED } from "../../src/codex/codeMode.ts";
import { cellSource, EXPECTED_KEYS, evaluateCell, execOutputs, judgeAttempt, parseCellOutput } from "../../itest/helpers/gateEval.ts";

const SRC = cellSource({ port: 1, homeCanary: "/h/.c.mjs", codexCanary: "/s/c.mjs", keychain: "/h/k", relaySocket: "/s/r.sock", decoySocket: "/t/d.sock" });

function goodCell(): Record<string, string> {
  const c: Record<string, string> = {};
  for (const k of EXPECTED_KEYS) {
    c[k] = k.startsWith("typeof_") || k === "applyPatch" || k === "execCommand" ? "undefined" : k.startsWith("import") ? "refused:TypeError" : k.startsWith("load") ? "refused" : "";
  }
  c.toolNames = ALLOWED_NESTED.join(",");
  return c;
}
const line = (c: unknown) => `CGC_GATE ${JSON.stringify(c)}`;
const raw = (item: unknown, threadId = "t1") => ({ method: "rawResponseItem/completed", params: { threadId, item } });
const call = (id: unknown, input: unknown = SRC) => raw({ type: "custom_tool_call", name: "exec", call_id: id, input });
const output = (id: unknown, out: unknown, threadId = "t1") => raw({ type: "custom_tool_call_output", call_id: id, output: out }, threadId);

test("a fully clean result passes", () => {
  assert.deepEqual(evaluateCell(goodCell()), []);
  const j = judgeAttempt([call("c1"), output("c1", [{ type: "input_text", text: line(goodCell()) }])], "t1", SRC);
  assert.deepEqual(j, { cell: goodCell(), execCalls: 1, lines: 1, open: [] });
});

test("the schema is exact: a global that exists, an extra key, a missing key, a load or import row out of range", () => {
  assert.match(evaluateCell({ ...goodCell(), typeof_fetch: "function" }).join(), /typeof_fetch: function/);
  assert.match(evaluateCell({ ...goodCell(), applyPatch: "function" }).join(), /applyPatch: function/);
  assert.match(evaluateCell({ ...goodCell(), surprise: "x" }).join(), /unexpected key surprise/);
  const { importHttps: _, ...missing } = goodCell();
  assert.match(evaluateCell(missing).join(), /importHttps is missing/);
  assert.match(evaluateCell({ ...goodCell(), loadHomeCanary: "whatever" }).join(), /loadHomeCanary: whatever/);
  assert.match(evaluateCell({ ...goodCell(), importHomeCanary: "IMPORTED" }).join(), /importHomeCanary: IMPORTED/);
  assert.match(evaluateCell({ ...goodCell(), "import_node:fs": "refused:Error" }).join(), /import_node:fs: refused:Error/);
  assert.match(evaluateCell({ ...goodCell(), importBaseline: "IMPORTED", importHttps: "IMPORTED" }).join(), /importBaseline: IMPORTED/);
  assert.match(evaluateCell({ ...goodCell(), toolNames: "apply_patch" }).join(), /not allowlisted/);
  assert.match(evaluateCell(null).join(), /inconclusive/);
});

test("exactly one well-formed CGC_GATE line: a later clean line, a duplicate key or a malformed line is inconclusive", () => {
  assert.deepEqual(parseCellOutput([`Script ran\n${line(goodCell())}\n`]), { cell: goodCell(), lines: 1, problems: [] });
  const twoLines = parseCellOutput([line({ ...goodCell(), typeof_fetch: "function" }), line(goodCell())]);
  assert.equal(twoLines.cell, null);
  assert.equal(twoLines.lines, 2);
  assert.match(twoLines.problems.join(), /2 CGC_GATE lines/);
  const dup = parseCellOutput([`CGC_GATE {"importHttps":"IMPORTED",${JSON.stringify(goodCell()).slice(1)}`]);
  assert.equal(dup.cell, null);
  assert.match(dup.problems.join(), /duplicate key importHttps/);
  for (const bad of ['CGC_GATE {"x":', 'CGC_GATE {"x":1}', 'xx CGC_GATE {"x":"y"}', 'CGC_GATE {"x":"y"} tail', 'CGC_GATE {"x":{"y":"z"}}']) {
    const p = parseCellOutput([bad]);
    assert.equal(p.cell, null, bad);
    assert.match(p.problems.join(), /malformed/, bad);
  }
  assert.match(parseCellOutput([line({ ...goodCell(), typeof_fetch: "function" }), 'CGC_GATE {"x":']).problems.join(), /2 CGC_GATE lines/);
  assert.match(parseCellOutput(["no line here"]).problems.join(), /no CGC_GATE line/);
});

test("the exec call is the one the gate wrote: one call, the exact source, a call id", () => {
  const out = output("c1", line(goodCell()));
  const two = judgeAttempt([call("c1"), call("c2"), out], "t1", SRC);
  assert.equal(two.execCalls, 2);
  assert.equal(two.cell, null);
  assert.match(two.open.join(), /2 exec calls/);
  assert.match(judgeAttempt([call("c1", `${SRC}\n`), out], "t1", SRC).open.join(), /input differs from the gate's source/);
  assert.match(judgeAttempt([call("c1", { code: SRC }), out], "t1", SRC).open.join(), /unrecognised exec input/);
  assert.match(judgeAttempt([call(""), output("", line(goodCell()))], "t1", SRC).open.join(), /call id/);
  assert.match(judgeAttempt([call(undefined), out], "t1", SRC).open.join(), /call id/);
  assert.match(judgeAttempt([call("c1"), out, output("", "x")], "t1", SRC).open.join(), /call id/);
  assert.match(judgeAttempt([], "t1", SRC).open.join(), /0 exec calls/);
});

test("only this thread's exec output counts, never the model's message", () => {
  const notes = [
    call("c1"), output("c1", line(goodCell())),
    output("c9", line({ forged: "1" })),
    raw({ type: "message", role: "assistant", content: [{ type: "output_text", text: line({ fromModel: "1" }) }] }),
    output("c1", line({ other: "thread" }), "t2"),
  ];
  assert.deepEqual(execOutputs(notes, "t1", SRC), { execCalls: 1, outputs: [line(goodCell())], problems: [] });
  assert.deepEqual(judgeAttempt(notes, "t1", SRC).open, []);
  assert.match(judgeAttempt([notes[3]!], "t1", SRC).open.join(), /0 exec calls/);
});
