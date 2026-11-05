// The exec-cell gate's evaluators (test/helpers/gateEval.ts): pure, no listener, no Codex. Every case here once
// passed a bad cell (review fix round 2), so the gate must fail closed on each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_NESTED } from "../../src/codex/codeMode.ts";
import {
  cellSource, controlRowOk, EXPECTED_KEYS, evaluateCell, execOutputs, judgeAttempt, MUST_BE_UNDEFINED, parseCellOutput, runAttempts, type JudgedAttempt,
} from "../helpers/gateEval.ts";

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
  assert.equal(MUST_BE_UNDEFINED.length, 15);
  for (const k of MUST_BE_UNDEFINED) {
    for (const v of ["function", "object", ""]) assert.deepEqual(evaluateCell({ ...goodCell(), [k]: v }), [`${k}: ${v}`], `${k} = ${JSON.stringify(v)}`);
  }
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

const judged = (execCalls: number, open: string[], lines = execCalls): JudgedAttempt => ({ cell: null, execCalls, lines, open });
function scripted(results: JudgedAttempt[]) {
  const calls: number[] = [];
  return { calls, run: async (i: number) => { calls.push(i); return results[i] ?? judged(0, ["ran out"]); } };
}

test("retry rule: no exec call retries; an attempt with an exec call is final; every attempt's evidence is kept", async () => {
  const retry = scripted([judged(0, ["0 exec calls"], 0), judged(1, [])]);
  const r1 = await runAttempts(2, retry.run);
  assert.deepEqual(retry.calls, [0, 1]);
  assert.deepEqual(r1.last, judged(1, []));
  assert.deepEqual(r1.attempts, [{ execCalls: 0, lines: 0, open: ["0 exec calls"] }, { execCalls: 1, lines: 1, open: [] }]);

  const final = scripted([judged(1, ["typeof_fetch: function"]), judged(1, [])]);
  const r2 = await runAttempts(2, final.run);
  assert.deepEqual(final.calls, [0], "an open attempt with an exec call is not retried into a pass");
  assert.deepEqual(r2.last?.open, ["typeof_fetch: function"]);
  assert.equal(r2.attempts.length, 1);

  const twoCalls = scripted([judged(2, ["2 exec calls"]), judged(1, [])]);
  assert.deepEqual((await runAttempts(2, twoCalls.run)).last?.open, ["2 exec calls"]);
  assert.deepEqual(twoCalls.calls, [0]);

  const never = scripted([judged(0, ["a"], 0), judged(0, ["b"], 0), judged(1, [])]);
  const r3 = await runAttempts(2, never.run);
  assert.deepEqual(never.calls, [0, 1], "at most `max` attempts");
  assert.deepEqual(r3.attempts.map((a) => a.open), [["a"], ["b"]]);
  assert.deepEqual(r3.last?.open, ["b"]);
  assert.deepEqual(await runAttempts(0, never.run), { last: null, attempts: [] });
});

test("probe control rows: only ECONNREFUSED or OK show the connect reached the network stack", () => {
  for (const e of ["ECONNREFUSED", "OK"]) assert.equal(controlRowOk(e), true, e);
  for (const e of ["EPERM", "EACCES", "ETIMEDOUT", "EAI", "OTHER", "ENOENT", "", undefined]) assert.equal(controlRowOk(e), false, String(e));
});
