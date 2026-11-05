import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appPaths, ensureAppDirs } from "../../src/app/appPaths.ts";
import { ALLOWED_NESTED, checkProtectedFiles, checkToolSurface, CodeModeError, parseToolSurface, prepareCodeMode, trimCatalog, type CodexDebugRunner } from "../../src/codex/codeMode.ts";
import type { CodexInstall } from "../../src/codex/codexInstall.ts";
import { CATALOG_FILE } from "../../src/codex/config.ts";
import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);
const install: CodexInstall = { version: "0.166.0", vendorDir: "/v", binary: "/v/bin/codex", codeModeHost: "/v/bin/codex-code-mode-host", pathDir: null, resourcesDir: null };
const CATALOG = JSON.stringify({ models: [
  { slug: "m-code", tool_mode: "code_mode_only", multi_agent_version: "v2", apply_patch_tool_type: "freeform", priority: 1 },
  { slug: "m-direct", multi_agent_version: null, apply_patch_tool_type: "freeform" },
  { slug: "m-code2", tool_mode: "code_mode_only", multi_agent_version: "v1", apply_patch_tool_type: "freeform" },
] });
/** A `codex debug prompt-input` result: namespaces of top-level tools; nested tools as `### \`name\`` in exec. */
const promptInput = (ns: Record<string, string[]>, nested: string[]) => JSON.stringify([
  { type: "message", role: "developer" },
  { type: "additional_tools", tools: Object.entries(ns).map(([name, tools]) => ({
    name,
    tools: tools.map((t) => ({ name: t, description: t === "exec" && name === "functions" ? `Run JS.\n${nested.map((n) => `### \`${n}\`\nabout it`).join("\n")}` : "" })),
  })) },
]);
const GOOD = promptInput({ functions: ["exec", "wait"] }, []);

test("the catalog keeps code-mode models only, with the agent and apply_patch fields cleared", () => {
  const t = trimCatalog(CATALOG);
  assert.deepEqual(t.models, ["m-code", "m-code2"]);
  const c = JSON.parse(t.json);
  for (const m of c.models) {
    assert.equal(m.multi_agent_version, null);
    assert.equal(m.apply_patch_tool_type, null);
    assert.equal(m.tool_mode, "code_mode_only");
  }
  assert.equal(c.models[0].priority, 1); // everything else is kept as the pinned binary printed it
  assert.throws(() => trimCatalog("{"), CodeModeError);
  assert.throws(() => trimCatalog(JSON.stringify({ models: [{ slug: "x" }] })), CodeModeError);
});

test("the surface parser reads top-level tools and the tools nested in exec", () => {
  const s = parseToolSurface(promptInput({ functions: ["exec", "wait"], collaboration: ["spawn_agent"] }, ["mcp__companion_readonly__list_dir", "apply_patch"]));
  assert.deepEqual(s, { top: ["functions.exec", "functions.wait", "collaboration.spawn_agent"], nested: ["mcp__companion_readonly__list_dir", "apply_patch"] });
  assert.throws(() => parseToolSurface(JSON.stringify([{ type: "message" }])), CodeModeError);
});

test("the surface must be exactly exec and wait, with only the jail tools nested", () => {
  assert.deepEqual(checkToolSurface("m", { top: ["functions.wait", "functions.exec"], nested: [...ALLOWED_NESTED] }).failures, []);
  assert.match(checkToolSurface("m", { top: ["functions.exec", "functions.wait"], nested: ["apply_patch"] }).failures.join(), /apply_patch/);
  assert.match(checkToolSurface("m", { top: ["functions.exec", "functions.wait", "collaboration.spawn_agent"], nested: [] }).failures.join(), /collaboration\.spawn_agent/);
  assert.match(checkToolSurface("m", { top: ["functions.exec"], nested: [] }).failures.join(), /functions\.wait is missing/);
});

function fakeRunner(surface: (model: string) => string, canary = promptInput({ functions: ["exec", "wait"] }, ["list_mcp_resources"])) {
  const calls: string[][] = [];
  const homes = new Set<string>();
  const run: CodexDebugRunner = (args, home) => {
    calls.push([...args]);
    homes.add(home);
    if (args[1] === "models") return CATALOG;
    const cfg = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    assert.ok(cfg.includes(`model_catalog_json = ${JSON.stringify(path.join(home, CATALOG_FILE))}`), "the scratch config points at the scratch catalog");
    if (/^excluded_tool_namespaces = \["clock"\]$/m.test(cfg)) return canary;
    return surface(String(args[3]).replace(/^model="|"$/g, ""));
  };
  return { run, calls, homes };
}

test("prepareCodeMode writes the catalog and config, then checks every model offline", () => {
  const paths = ensureAppDirs(appPaths(tempDir()));
  const f = fakeRunner(() => GOOD);
  const r = prepareCodeMode({ install, paths, run: f.run });
  assert.deepEqual(r.result, { failures: [], warnings: [] });
  assert.deepEqual(r.models, ["m-code", "m-code2"]);
  assert.deepEqual(Object.keys(r.protectedFiles).sort(), ["companion-models.json", "config.toml"]);
  assert.deepEqual(checkProtectedFiles(paths.codexHome, r.protectedFiles), { failures: [], warnings: [] });
  const catalog = path.join(paths.codexHome, CATALOG_FILE);
  assert.equal(fs.statSync(catalog).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(catalog, "utf8")).models.map((m: any) => m.slug), ["m-code", "m-code2"]);
  assert.ok(fs.readFileSync(path.join(paths.codexHome, "config.toml"), "utf8").includes(`model_catalog_json = ${JSON.stringify(catalog)}`));
  assert.deepEqual(f.calls.map((c) => c.slice(0, 4).join(" ")), [
    "debug models", 'debug prompt-input -c model="m-code"', 'debug prompt-input -c model="m-code"', 'debug prompt-input -c model="m-code2"',
  ]);
  for (const h of f.homes) assert.equal(fs.existsSync(h), false, "the scratch home is removed");
});

test("prepareCodeMode fails closed: a widened surface, a blind parser, a runner error", () => {
  const paths = ensureAppDirs(appPaths(tempDir()));
  const wide = prepareCodeMode({ install, paths, run: fakeRunner((m) => (m === "m-code2" ? promptInput({ functions: ["exec", "wait"], collaboration: ["spawn_agent"] }, []) : GOOD)).run });
  assert.match(wide.result.failures.join(), /m-code2.*collaboration\.spawn_agent/);
  const blind = prepareCodeMode({ install, paths, run: fakeRunner(() => GOOD, GOOD).run });
  assert.match(blind.result.failures.join(), /cannot read the tools nested/);
  const broken = prepareCodeMode({ install, paths, run: () => { throw new CodeModeError("codex debug models failed under its offline profile"); } });
  assert.deepEqual(broken, { result: { failures: ["codex debug models failed under its offline profile"], warnings: [] }, models: [], protectedFiles: {} });
  const liveWide = prepareCodeMode({ install, paths, run: fakeRunner(() => GOOD).run, live: () => promptInput({ functions: ["exec", "wait"] }, ["create_goal"]) });
  assert.match(liveWide.result.failures.join(), /m-code, live.*create_goal/);
});

test("protected files: a changed byte, a hard link or a missing file fails the check (I-5)", () => {
  const paths = ensureAppDirs(appPaths(tempDir()));
  const r = prepareCodeMode({ install, paths, run: fakeRunner(() => GOOD).run });
  const cfg = path.join(paths.codexHome, "config.toml");
  fs.linkSync(cfg, path.join(paths.codexHome, "config-link.toml"));
  assert.match(checkProtectedFiles(paths.codexHome, r.protectedFiles).failures.join(), /config\.toml .*changed/);
  fs.rmSync(path.join(paths.codexHome, "config-link.toml"));
  assert.deepEqual(checkProtectedFiles(paths.codexHome, r.protectedFiles).failures, []);
  fs.appendFileSync(path.join(paths.codexHome, CATALOG_FILE), " ");
  assert.match(checkProtectedFiles(paths.codexHome, r.protectedFiles).failures.join(), /companion-models\.json .*changed/);
  fs.rmSync(cfg);
  assert.match(checkProtectedFiles(paths.codexHome, r.protectedFiles).failures.join(), /config\.toml .*missing/);
});
