import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BASE_MCP_COMMAND, buildCodexConfigToml, OFF_FEATURES, REQUIRED_OFF_FEATURES, tomlString, tomlValue, writeCodexConfig,
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
  assert.match(t, /^approval_policy = "untrusted"$/m);
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
