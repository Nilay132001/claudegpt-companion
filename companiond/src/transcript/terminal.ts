export interface TerminalFailure {
  kind: "test_failure" | "build_failure" | "command_failed";
  /** One line, at most 200 characters. */
  summary: string;
}

export interface CommandOutcome {
  exitCode: number | null;
  isError: boolean;
  stdout: string;
  stderr: string;
}

const TEST_PATTERNS: RegExp[] = [
  /^# fail [1-9]\d*/m, // node:test TAP
  /^ℹ fail [1-9]\d*/m, // node:test spec reporter
  /^Tests?:\s+.*\b[1-9]\d* failed/m, // jest, vitest
  /^=+ .*\b[1-9]\d* failed\b.*=+$/m, // pytest summary line
  /^FAILED \S+/m, // pytest
  /^--- FAIL: /m, // go test
  /^test result: FAILED/m, // cargo test
  /^✘ Test .* failed/m, // swift-testing
  /Executed \d+ tests?, with [1-9]\d* failures?/, // XCTest
];

const BUILD_PATTERNS: RegExp[] = [
  /error TS\d{4,5}:/, // tsc
  /^\S+:\d+:\d+: (fatal )?error: /m, // swiftc, clang, gcc
  /^error\[E\d{4}\]: /m, // rustc
  /^error: could not compile /m, // cargo
  /^error: (emit-module command failed|build had \d+ command failures?|fatalError)/m, // swift build
  /^npm (ERR!|error) /m,
  /\bBUILD FAILED\b/,
  /^SyntaxError: /m,
];

function firstLine(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m) return "";
  const start = text.lastIndexOf("\n", m.index) + 1;
  const end = text.indexOf("\n", m.index);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 200);
}

/**
 * Recognises test and build failures in a Bash result (spec §10). Only a failed command is examined
 * (non-zero exit or an error result), so "# fail 1" printed by a passing script is not a failure.
 */
export function detectFailure(o: CommandOutcome): TerminalFailure | null {
  const failed = o.isError || (o.exitCode !== null && o.exitCode !== 0);
  if (!failed) return null;
  const text = `${o.stdout}\n${o.stderr}`;
  for (const re of TEST_PATTERNS) if (re.test(text)) return { kind: "test_failure", summary: firstLine(text, re) };
  for (const re of BUILD_PATTERNS) if (re.test(text)) return { kind: "build_failure", summary: firstLine(text, re) };
  return { kind: "command_failed", summary: o.exitCode !== null ? `exit code ${o.exitCode}` : "command failed" };
}
