import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BASE_MCP_COMMAND, buildCodexConfigToml, CODEX_PROTECTED_FILES, codexStageDir, OFF_FEATURES, REQUIRED_OFF_FEATURES, tomlString, tomlValue, writeCodexConfig,
} from "../../src/codex/config.ts";
import { AppDirError } from "../../src/app/appPaths.ts";
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

/** A Codex home inside its own temp root, so the staging folder (a sibling) is inside the root too. */
const codexHome = (): string => {
  const home = path.join(tempDir(), "codex-home");
  fs.mkdirSync(home, { mode: 0o700 });
  return home;
};

test("the config file is written 0600, staged outside CODEX_HOME in a 0700 folder", () => {
  const home = codexHome();
  writeCodexConfig(home, "x = 1\n");
  const f = path.join(home, "config.toml");
  assert.equal(fs.readFileSync(f, "utf8"), "x = 1\n");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(home), ["config.toml"], "nothing is staged inside CODEX_HOME");
  const stage = codexStageDir(home);
  assert.equal(path.dirname(stage), path.dirname(home));
  assert.equal(fs.lstatSync(stage).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(stage), [], "the staged file was renamed away");
  writeCodexConfig(home, "x = 2\n"); // a rewrite replaces it
  assert.equal(fs.readFileSync(f, "utf8"), "x = 2\n");
});

test("a symlink planted at a staging name is never written through: the write fails closed (final review I-1)", () => {
  const home = codexHome();
  const victim = path.join(tempDir(), "victim.txt");
  fs.writeFileSync(victim, "SYNTHETIC FIXTURE victim\n", { mode: 0o644 });
  // The old staging name inside CODEX_HOME (which Codex can write) is ignored altogether ...
  fs.symlinkSync(victim, path.join(home, `config.toml.tmp-${process.pid}`));
  writeCodexConfig(home, "x = 1\n");
  assert.equal(fs.readFileSync(victim, "utf8"), "SYNTHETIC FIXTURE victim\n");
  // ... and a link at the staging name in companiond's own folder refuses the write.
  const stage = codexStageDir(home);
  fs.symlinkSync(victim, path.join(stage, `config.toml.tmp-${process.pid}`));
  assert.throws(() => writeCodexConfig(home, "x = 2\n"), AppDirError);
  assert.equal(fs.readFileSync(victim, "utf8"), "SYNTHETIC FIXTURE victim\n");
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), "x = 1\n", "the old config stays");
});

test("a staging folder replaced by a symlink is refused; nothing is written or chmodded through it (final review I-1)", () => {
  const home = codexHome();
  const elsewhere = tempDir();
  fs.chmodSync(elsewhere, 0o755);
  fs.symlinkSync(elsewhere, codexStageDir(home));
  assert.throws(() => writeCodexConfig(home, "x = 1\n"), AppDirError);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.equal(fs.statSync(elsewhere).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(home, "config.toml")), false);
});

test("a symlink at the destination name is replaced, not followed", () => {
  const home = codexHome();
  const victim = path.join(tempDir(), "victim.txt");
  fs.writeFileSync(victim, "SYNTHETIC FIXTURE victim\n");
  fs.symlinkSync(victim, path.join(home, "config.toml"));
  writeCodexConfig(home, "x = 1\n");
  assert.equal(fs.readFileSync(victim, "utf8"), "SYNTHETIC FIXTURE victim\n");
  assert.equal(fs.lstatSync(path.join(home, "config.toml")).isFile(), true);
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
