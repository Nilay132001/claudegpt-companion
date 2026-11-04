import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFailure } from "../../src/transcript/terminal.ts";

const run = (stdout: string, exitCode: number | null = 1, stderr = "") => detectFailure({ exitCode, isError: exitCode !== 0, stdout, stderr });

test("recognises test runners", () => {
  for (const [out, line] of [
    ["# tests 3\n# fail 1\n", "# fail 1"],
    ["ℹ tests 3\nℹ fail 2\n", "ℹ fail 2"],
    ["Tests:       1 failed, 4 passed, 5 total", "Tests:       1 failed, 4 passed, 5 total"],
    ["==== 2 failed, 10 passed in 0.31s ====", "==== 2 failed, 10 passed in 0.31s ===="],
    ["--- FAIL: TestSynthetic (0.00s)", "--- FAIL: TestSynthetic (0.00s)"],
    ["test result: FAILED. 1 passed; 1 failed", "test result: FAILED. 1 passed; 1 failed"],
  ] as const) {
    assert.deepEqual(run(out), { kind: "test_failure", summary: line }, out);
  }
});

test("recognises build errors, in stdout or stderr", () => {
  assert.deepEqual(run("src/a.ts(3,1): error TS2304: Cannot find name 'x'."), {
    kind: "build_failure",
    summary: "src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
  });
  assert.equal(run("", 1, "Sources/A.swift:4:2: error: cannot find 'y' in scope")?.kind, "build_failure");
  assert.equal(run("", 101, "error[E0425]: cannot find value `x`")?.kind, "build_failure");
});

test("a bare 'error: ' line is only command_failed, not a build failure", () => {
  assert.deepEqual(run("error: pathspec 'x' did not match", 1), { kind: "command_failed", summary: "exit code 1" });
});

test("output of a successful command is never a failure, whatever it prints", () => {
  assert.equal(run("# tests 3\n# fail 0\n", 0), null);
  assert.equal(run("# fail 1\nerror TS2304: x", 0), null);
  assert.equal(detectFailure({ exitCode: null, isError: false, stdout: "# fail 1", stderr: "" }), null);
});

test("a plain non-zero exit is command_failed", () => {
  assert.deepEqual(run("nothing useful", 2), { kind: "command_failed", summary: "exit code 2" });
});
