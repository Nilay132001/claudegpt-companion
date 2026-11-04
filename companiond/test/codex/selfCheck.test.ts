import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { OFF_FEATURES } from "../../src/codex/config.ts";
import { COMPANION_ALLOWLIST } from "../../src/codex/serverRequests.ts";
import {
  checkCodexHome, checkCompanionCwd, checkConfigRead, checkFeatureList, checkMcpStatus, checkThreadResponse, checkVersion,
  mergeChecks, versionFromUserAgent, type FsProbe,
} from "../../src/codex/selfCheck.ts";

const goodConfig = () => ({
  config: { features: Object.fromEntries(OFF_FEATURES.map((k) => [k, false])), web_search: "disabled" },
  origins: {},
  layers: [{ name: { type: "user", file: "/x/config.toml", profile: null }, version: "1", config: {}, disabledReason: null }],
});
const feature = (name: string, enabled = false, stage = "stable", defaultEnabled = false) => ({ name, stage, enabled, defaultEnabled, displayName: null, description: null, announcement: null });
const goodFeatures = () => OFF_FEATURES.map((n) => (n === "unified_exec" ? feature(n, true, "stable", true) : feature(n)));
const TOOLS = Object.fromEntries(["list_dir", "read_file", "search", "git_status", "git_diff"].map((t) => [t, { name: t }]));

test("version: pinned package and userAgent must agree", () => {
  assert.equal(versionFromUserAgent("codex_cli_rs/0.166.0 (Mac OS 27.0.1; arm64) claudegpt_companion"), "0.166.0");
  assert.equal(versionFromUserAgent("something else"), null);
  assert.deepEqual(checkVersion("0.166.0", "0.166.0", "codex_cli_rs/0.166.0").failures, []);
  assert.equal(checkVersion("0.166.0", "0.166.0", "?").warnings.length, 1);
  assert.equal(checkVersion("0.167.0", "0.166.0", "codex_cli_rs/0.167.0").failures.length, 2);
});

test("config/read: all flags off, web search off, no project layer", () => {
  assert.deepEqual(checkConfigRead(goodConfig(), OFF_FEATURES), { failures: [], warnings: [] });
  for (const k of OFF_FEATURES) {
    const c = goodConfig();
    (c.config.features as Record<string, boolean>)[k] = true;
    assert.match(checkConfigRead(c, OFF_FEATURES).failures.join(), new RegExp(`features\\.${k}`), k);
  }
  const ws = goodConfig(); ws.config.web_search = "live";
  assert.equal(checkConfigRead(ws, OFF_FEATURES).failures.length, 1);
  const proj = goodConfig(); proj.layers.push({ name: { type: "project", file: "/r/.codex", profile: null } as never, version: "1", config: {}, disabledReason: null });
  assert.match(checkConfigRead(proj, OFF_FEATURES).failures.join(), /project/);
  assert.equal(checkConfigRead({ config: {} }, OFF_FEATURES).failures.length, OFF_FEATURES.length + 2);
});

test("experimentalFeature/list: the unified_exec exception is exact and 0.166.0-only", () => {
  const r = checkFeatureList(goodFeatures(), OFF_FEATURES, "0.166.0");
  assert.deepEqual(r.failures, []);
  assert.equal(r.warnings.length, 1);
  assert.equal(checkFeatureList(goodFeatures(), OFF_FEATURES, "0.167.0").failures.length, 1);
  const other = goodFeatures().map((f) => (f.name === "unified_exec" ? feature(f.name, true, "beta", true) : f));
  assert.equal(checkFeatureList(other, OFF_FEATURES, "0.166.0").failures.length, 1);
  const shell = goodFeatures().map((f) => (f.name === "shell_tool" ? feature(f.name, true) : f));
  assert.match(checkFeatureList(shell, OFF_FEATURES, "0.166.0").failures.join(), /shell_tool/);
  assert.match(checkFeatureList(goodFeatures().slice(1), OFF_FEATURES, "0.166.0").failures.join(), /no shell_tool/);
  const dup = [...goodFeatures(), feature("shell_tool", true)];
  assert.match(checkFeatureList(dup, OFF_FEATURES, "0.166.0").failures.join(), /2 entries for shell_tool/);
});

function fakeFs(present: string[], listing: Record<string, string[]> = {}): FsProbe {
  return { exists: (p) => present.includes(p), list: (p) => listing[p] ?? [] };
}

test("companion folder: empty, and no .git or AGENTS file in it or any ancestor", () => {
  const cwd = "/a/b/empty";
  assert.deepEqual(checkCompanionCwd(cwd, fakeFs([])), { failures: [], warnings: [] });
  for (const bad of ["/a/.git", "/a/b/AGENTS.md", "/AGENTS.override.md", "/a/b/empty/.git"]) {
    assert.equal(checkCompanionCwd(cwd, fakeFs([bad])).failures.length, 1, bad);
  }
  assert.match(checkCompanionCwd(cwd, fakeFs([], { [cwd]: ["x"] })).failures.join(), /not empty/);
  assert.match(checkCompanionCwd("rel/dir", fakeFs([])).failures.join(), /absolute/);
  const unlistable: FsProbe = { exists: () => false, list: () => { throw new Error("ENOENT /secret/path"); } };
  const u = checkCompanionCwd(cwd, unlistable);
  assert.equal(u.failures.length, 1);
  assert.doesNotMatch(u.failures.join(), /secret|ENOENT/);
  assert.doesNotMatch(checkCompanionCwd(cwd, fakeFs(["/a/.git"])).failures.join(), /\/a/); // no paths in the detail
});

test("CODEX_HOME must not hold global instruction files", () => {
  assert.deepEqual(checkCodexHome("/h", fakeFs([])).failures, []);
  assert.equal(checkCodexHome("/h", fakeFs([path.join("/h", "AGENTS.md")])).failures.length, 1);
});

test("MCP status: subset per process, exact per bound thread", () => {
  const base = [{ name: "companion-readonly", tools: {} }];
  assert.deepEqual(checkMcpStatus(base, COMPANION_ALLOWLIST, "process").failures, []);
  assert.match(checkMcpStatus(base, COMPANION_ALLOWLIST, "thread").failures.join(), /missing/);
  assert.deepEqual(checkMcpStatus([{ name: "companion-readonly", tools: TOOLS }], COMPANION_ALLOWLIST, "thread").failures, []);
  const extra = [{ name: "companion-readonly", tools: { ...TOOLS, write_file: {} } }];
  assert.match(checkMcpStatus(extra, COMPANION_ALLOWLIST, "process").failures.join(), /write_file/);
  assert.match(checkMcpStatus([{ name: "other", tools: {} }], COMPANION_ALLOWLIST, "process").failures.join(), /other/);
  assert.match(checkMcpStatus([], COMPANION_ALLOWLIST, "thread").failures.join(), /not running/);
});

test("thread responses: no instruction files, empty cwd, untrusted, read-only", () => {
  const good = { thread: { id: "t" }, cwd: "/e", instructionSources: [], approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } };
  assert.deepEqual(checkThreadResponse(good, "/e").failures, []);
  assert.match(checkThreadResponse({ ...good, instructionSources: ["/r/AGENTS.md"] }, "/e").failures.join(), /instruction/);
  assert.equal(checkThreadResponse({ ...good, cwd: "/r" }, "/e").failures.length, 1);
  assert.equal(checkThreadResponse({ ...good, approvalPolicy: "never" }, "/e").failures.length, 1);
  assert.equal(checkThreadResponse({ ...good, sandbox: { type: "workspaceWrite" } }, "/e").failures.length, 1);
  for (const rev of ["auto_review", "guardian_subagent", undefined]) {
    assert.match(checkThreadResponse({ ...good, approvalsReviewer: rev }, "/e").failures.join(), /reviewer/, String(rev));
  }
  assert.equal(checkThreadResponse({}, "/e").failures.length, 5);
  assert.equal(mergeChecks(checkThreadResponse({}, "/e"), { failures: [], warnings: ["w"] }).warnings.length, 1);
});
