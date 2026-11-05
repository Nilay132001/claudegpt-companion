import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { OFF_FEATURES } from "../../src/codex/config.ts";
import { COMPANION_ALLOWLIST, toolAllowlist } from "../../src/codex/serverRequests.ts";
import { JIRA_SERVER_NAME, JIRA_TOOL_NAMES } from "../../src/jira/tools.ts";
import { TOOL_NAMES } from "../../src/jail/mcpServer.ts";
import {
  checkCodeModeConfig, checkCodexHome, checkCompanionCwd, checkConfigLayers, checkConfigRead, checkFeatureList, checkThreadModel, checkMcpStatus, checkThreadResponse, checkVersion,
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

test("version: pinned package and the running binary's userAgent must agree; a missing version fails (I-11)", () => {
  assert.equal(versionFromUserAgent("claudegpt_companion/0.166.0 (Mac OS 27.0.1; arm64) unknown (claudegpt_companion; 0.4.0)"), "0.166.0");
  assert.equal(versionFromUserAgent("codex_cli_rs/0.166.0 (Mac OS 27.0.1; arm64)"), "0.166.0");
  assert.equal(versionFromUserAgent("something else"), null);
  assert.deepEqual(checkVersion("0.166.0", "0.166.0", "claudegpt_companion/0.166.0 (Mac OS)"), { failures: [], warnings: [] });
  assert.match(checkVersion("0.166.0", "0.166.0", "?").failures.join(), /did not report its version/);
  assert.equal(checkVersion("0.167.0", "0.166.0", "claudegpt_companion/0.167.0").failures.length, 2);
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

const READONLY_ONLY = new Set(["companion-readonly"]); // a root-bound thread without Jira

test("MCP status: subset per process, exact per bound thread", () => {
  const base = [{ name: "companion-readonly", tools: {} }];
  assert.deepEqual(checkMcpStatus(base, COMPANION_ALLOWLIST, "process").failures, []);
  assert.match(checkMcpStatus(base, COMPANION_ALLOWLIST, "thread", READONLY_ONLY).failures.join(), /missing/);
  assert.deepEqual(checkMcpStatus([{ name: "companion-readonly", tools: TOOLS }], COMPANION_ALLOWLIST, "thread", READONLY_ONLY).failures, []);
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

const CATALOG = "/s/codex-home/companion-models.json";
const codeModeConfig = (features: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  config: { features: { code_mode_host: true, goals: false, code_mode: { excluded_tool_namespaces: ["functions", "clock"] }, ...features }, model_catalog_json: CATALOG, ...extra },
});

test("code-mode config: host on, both namespaces excluded, no direct-only namespaces, the generated catalog", () => {
  assert.deepEqual(checkCodeModeConfig(codeModeConfig(), [], CATALOG), { failures: [], warnings: [] });
  assert.match(checkCodeModeConfig(codeModeConfig({ code_mode_host: false }), [], CATALOG).failures.join(), /code_mode_host/);
  assert.match(checkCodeModeConfig(codeModeConfig({ code_mode: { excluded_tool_namespaces: ["clock"] } }), [], CATALOG).failures.join(), /excluded_tool_namespaces/);
  assert.match(checkCodeModeConfig(codeModeConfig({ code_mode: { excluded_tool_namespaces: ["clock", "functions"], direct_only_tool_namespaces: ["functions"] } }), [], CATALOG).failures.join(), /direct_only_tool_namespaces/);
  assert.match(checkCodeModeConfig(codeModeConfig({}, { model_catalog_json: "/elsewhere.json" }), [], CATALOG).failures.join(), /model_catalog_json/);
  assert.match(checkCodeModeConfig(codeModeConfig(), [{ name: "goals", enabled: true }], CATALOG).failures.join(), /goals/);
  assert.equal(checkCodeModeConfig({ config: {} }, [], CATALOG).failures.length, 3);
});

test("the thread's model must be one whose tool surface was checked", () => {
  assert.deepEqual(checkThreadModel({ model: "m1" }, ["m1"]), { failures: [], warnings: [] });
  assert.deepEqual(checkThreadModel({ thread: { model: "m1" } }, ["m1"]), { failures: [], warnings: [] });
  assert.equal(checkThreadModel({ model: "m2" }, ["m1"]).failures.length, 1);
  assert.equal(checkThreadModel({}, ["m1"]).failures.length, 1);
});

test("config layers: only the user layer at CODEX_HOME/config.toml and the system layer at /etc/codex (I-5)", () => {
  const layer = (type: string, file: string | null) => ({ name: { type, file, profile: null }, version: "1", config: {}, disabledReason: null });
  const ok = { layers: [layer("user", "/s/codex-home/config.toml"), layer("system", "/etc/codex/config.toml")] };
  assert.deepEqual(checkConfigLayers(ok, "/s/codex-home"), { failures: [], warnings: [] });
  assert.match(checkConfigLayers({ layers: [layer("user", "/s/codex-home/other.toml")] }, "/s/codex-home").failures.join(), /user config layer/);
  assert.match(checkConfigLayers({ layers: [...ok.layers, layer("managed", "/s/codex-home/managed_config.toml")] }, "/s/codex-home").failures.join(), /managed config layer/);
  assert.match(checkConfigLayers({ layers: [layer("system", "/etc/codex/config.toml")] }, "/s/codex-home").failures.join(), /no user config layer/);
  assert.equal(checkConfigLayers({}, "/s/codex-home").failures.length, 1);
});

const entry = (name: string, tools: readonly string[]) => ({ name, tools: Object.fromEntries(tools.map((t) => [t, {}])) });

test("M6: a bound Jira thread must list exactly the three Jira tools; an unbound readonly server may list none", () => {
  const ok = checkMcpStatus([entry("companion-readonly", []), entry(JIRA_SERVER_NAME, JIRA_TOOL_NAMES)], COMPANION_ALLOWLIST, "thread", new Set([JIRA_SERVER_NAME]));
  assert.deepEqual(ok.failures, []);
  const missing = checkMcpStatus([entry(JIRA_SERVER_NAME, ["jira_search"])], COMPANION_ALLOWLIST, "thread", new Set([JIRA_SERVER_NAME]));
  assert.ok(missing.failures.some((f) => f.includes("companion-jira/jira_get_issue is missing")));
  const both = checkMcpStatus([entry("companion-readonly", TOOL_NAMES), entry(JIRA_SERVER_NAME, JIRA_TOOL_NAMES)], COMPANION_ALLOWLIST, "thread");
  assert.deepEqual(both.failures, []);
});

test("M6: no write tool is visible — an extra or write-shaped tool on any server fails the self-check", () => {
  for (const scope of ["process", "thread"] as const) {
    const r = checkMcpStatus([entry(JIRA_SERVER_NAME, [...JIRA_TOOL_NAMES, "createJiraIssue"])], COMPANION_ALLOWLIST, scope, new Set([JIRA_SERVER_NAME]));
    assert.ok(r.failures.some((f) => f.includes("companion-jira/createJiraIssue is not allowlisted")), scope);
    assert.ok(r.failures.some((f) => f.includes("companion-jira/createJiraIssue looks like a write tool")), scope);
  }
  // Even an allowlist that wrongly contained a write tool is caught (defence in depth).
  const bad = toolAllowlist({ [JIRA_SERVER_NAME]: [...JIRA_TOOL_NAMES, "addCommentToJiraIssue"] });
  const r = checkMcpStatus([entry(JIRA_SERVER_NAME, [...JIRA_TOOL_NAMES, "addCommentToJiraIssue"])], bad, "thread");
  assert.ok(r.failures.some((f) => f.includes("looks like a write tool")));
  // Atlassian's remote server is never allowlisted.
  const remote = checkMcpStatus([entry("atlassian", ["getJiraIssue"])], COMPANION_ALLOWLIST, "process");
  assert.ok(remote.failures.some((f) => f.includes("MCP server atlassian is not allowlisted")));
});
