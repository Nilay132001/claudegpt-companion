import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BASE_MCP_COMMAND, buildCodexConfigToml, CODEX_PROTECTED_FILES, OFF_FEATURES, REQUIRED_OFF_FEATURES, tomlString, tomlValue, writeCodexConfig,
} from "../../src/codex/config.ts";
import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);

test("TOML strings escape quotes, backslashes and control characters", () => {
  assert.equal(tomlString('a"b\\c\nd'), '"a\\"b\\\\c\\u000ad"');
  assert.equal(tomlValue({ A: "x", "b.c": ["1", true, 2] }), '{ A = "x", "b.c" = ["1", true, 2] }');
  assert.throws(() => tomlValue(1.5));
});

test("the config turns every feature off and keeps the base server inert", () => {
  const t = buildCodexConfigToml();
  assert.equal(REQUIRED_OFF_FEATURES.length, 11);
  for (const k of OFF_FEATURES) assert.match(t, new RegExp(`^${k} = false$`, "m"), k);
  assert.match(t, /^cli_auth_credentials_store = "keyring"$/m);
  assert.match(t, /^web_search = "disabled"$/m);
  assert.doesNotMatch(t, /^approval_policy/m); // 0.166.0 rejects it in config.toml; set per thread instead
  assert.match(t, /^approvals_reviewer = "user"$/m);
  assert.match(t, /^sandbox_mode = "read-only"$/m);
  assert.match(t, /^\[mcp_servers\.companion-readonly\]$/m);
  assert.match(t, new RegExp(`^command = "${BASE_MCP_COMMAND}"$`, "m"));
  assert.match(t, /^enabled_tools = \["list_dir", "read_file", "search", "git_status", "git_diff"\]$/m);
  assert.doesNotMatch(t, /api_key|OPENAI/i);
});

test("the config file is written 0600", () => {
  const home = tempDir();
  writeCodexConfig(home, "x = 1\n");
  const f = path.join(home, "config.toml");
  assert.equal(fs.readFileSync(f, "utf8"), "x = 1\n");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test("code mode: catalog path, code_mode_host on, goals off, namespaces excluded, request_user_input off", () => {
  const t = buildCodexConfigToml(OFF_FEATURES, { catalogPath: "/s/codex-home/companion-models.json" });
  assert.match(t, /^model_catalog_json = "\/s\/codex-home\/companion-models\.json"$/m);
  assert.ok(t.indexOf("model_catalog_json") < t.indexOf("[features]"), "a top-level key before any table");
  assert.match(t, /^\[features\]\n(?:[a-z_]+ = false\n)+code_mode_host = true\ngoals = false\n/m);
  assert.match(t, /^\[features\.code_mode\]\nexcluded_tool_namespaces = \["clock", "functions"\]$/m);
  assert.match(t, /^\[tools\]\nexperimental_request_user_input = \{ enabled = false \}$/m);
  assert.doesNotMatch(t, /direct_only_tool_namespaces|code_mode_host = false/);
  assert.equal(OFF_FEATURES.includes("code_mode_host"), false);
  assert.deepEqual(CODEX_PROTECTED_FILES, ["config.toml", "companion-models.json"]);
  assert.match(buildCodexConfigToml(OFF_FEATURES, { catalogPath: "/c.json", excluded: ["clock"] }), /^excluded_tool_namespaces = \["clock"\]$/m);
});
