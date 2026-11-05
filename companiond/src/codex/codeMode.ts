// Code mode, closed down (owner ruling 2026-11-04; spec §7.1.1, §7.1.5). In Codex 0.166.0 a ChatGPT-login model
// reaches MCP tools only through functions.exec, so code mode is on and what the model sees is shrunk to
// functions.exec, functions.wait and, inside exec, the five jail tools:
//  - a model catalog GENERATED at every start from the pinned binary's own `codex debug models`, keeping only
//    code-mode models, with multi_agent_version and apply_patch_tool_type cleared (the only measured way to
//    remove collaboration.*). Never a checked-in copy.
//  - an offline check of the tool surface, per catalog model, with `codex debug prompt-input`, under the offline
//    Codex profile in a scratch CODEX_HOME (no login, no network, no MCP servers). The catalog is load-bearing,
//    so it is verified, not trusted: anything beyond the allowlist fails the start.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppDirError, ensurePrivateDir, type AppPaths } from "../app/appPaths.ts";
import { SERVER_NAME, TOOL_NAMES } from "../jail/mcpServer.ts";
import type { CodexInstall } from "./codexInstall.ts";
import { buildCodexLaunch, buildOfflineCodexLaunch, type CodexLaunch, type RelayEndpoint } from "./codexSeatbelt.ts";
import { buildCodexConfigToml, CATALOG_FILE, CODEX_PROTECTED_FILES, OFF_FEATURES, tomlString, writeCodexConfig, writeCodexHomeFile } from "./config.ts";
import type { CheckResult } from "./selfCheck.ts";

export const ALLOWED_TOP_LEVEL: readonly string[] = ["functions.exec", "functions.wait"];
export const NESTED_PREFIX = `mcp__${SERVER_NAME.replaceAll("-", "_")}__`;
export const ALLOWED_NESTED: readonly string[] = TOOL_NAMES.map((t) => `${NESTED_PREFIX}${t}`);

export class CodeModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeModeError";
  }
}
export interface ToolSurface { top: string[]; nested: string[] }
/** protectedFiles: sha256 of config.toml and the catalog as companiond wrote them (checked before every spawn and
 * every thread/start or thread/resume; plan review I-5). */
export interface PreparedCodeMode { result: CheckResult; models: string[]; protectedFiles: Record<string, string> }
/** Runs `codex <args>` with CODEX_HOME = home and returns stdout. Throws CodeModeError on failure. */
export type CodexDebugRunner = (args: readonly string[], home: string) => string;

/** Measured in Task 8 Step 7 (plan review I-6): does `codex debug prompt-input` with the real, signed-in CODEX_HOME,
 * under the production profile, list live-only tools (the goal tools with goals on are the canary)? If true, the
 * per-model surface check also runs live at every start; if false, the gap is a recorded residual risk. */
export const LIVE_SURFACE_CHECK: boolean = false;

const sha256 = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function snapshotProtectedFiles(codexHome: string): Record<string, string> {
  return Object.fromEntries(CODEX_PROTECTED_FILES.map((n) => [n, sha256(path.join(codexHome, n))]));
}

/** Each protected file is a regular file with one link and the content companiond wrote. */
export function checkProtectedFiles(codexHome: string, expected: Readonly<Record<string, string>>): CheckResult {
  const r: CheckResult = { failures: [], warnings: [] };
  for (const name of CODEX_PROTECTED_FILES) {
    const file = path.join(codexHome, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.nlink !== 1 || sha256(file) !== expected[name]) r.failures.push(`${name} in the Codex home changed since the start`);
    } catch {
      r.failures.push(`${name} in the Codex home is missing`);
    }
  }
  return r;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function trimCatalog(raw: string): { json: string; models: string[] } {
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new CodeModeError("codex debug models did not print JSON");
  }
  const all = obj(c)?.models;
  if (!Array.isArray(all)) throw new CodeModeError("codex debug models printed no model list");
  const kept = all
    .map(obj)
    .filter((m): m is Record<string, unknown> => m !== null && typeof m.slug === "string" && m.tool_mode === "code_mode_only")
    .map((m): Record<string, unknown> => ({ ...m, multi_agent_version: null, apply_patch_tool_type: null }));
  if (kept.length === 0) throw new CodeModeError("the pinned Codex lists no code-mode model");
  return { json: JSON.stringify({ ...obj(c), models: kept }), models: kept.map((m) => String(m.slug)) };
}

/** Every additional_tools item counts; any other item type that carries tools fails closed (format drift).
 *
 * Known risk: 0.166.0 lists the tools reachable from a cell only as `### \`name\`` headings in exec's description.
 * If a later Codex renders them differently, the parser stops seeing them. The canary in prepareCodeMode catches a
 * parser that sees NO nested tool; it cannot catch a partial change where only some tools use another format. The
 * pin to 0.166.0 is what keeps this format fixed. */
export function parseToolSurface(raw: string): ToolSurface {
  let items: unknown;
  try {
    items = JSON.parse(raw);
  } catch {
    throw new CodeModeError("codex debug prompt-input did not print JSON");
  }
  if (!Array.isArray(items)) throw new CodeModeError("codex debug prompt-input lists no tools");
  const top: string[] = [];
  const nested: string[] = [];
  let seen = false;
  for (const item of items.map(obj)) {
    if (item?.type !== "additional_tools") {
      if (item && "tools" in item) throw new CodeModeError("codex debug prompt-input lists tools in an item type the companion does not know");
      continue;
    }
    if (!Array.isArray(item.tools)) throw new CodeModeError("codex debug prompt-input lists no tools");
    seen = true;
    for (const nsRaw of item.tools) {
      const ns = obj(nsRaw);
      const name = String(ns?.name ?? "?");
      if (!Array.isArray(ns?.tools)) {
        top.push(name);
        continue;
      }
      for (const tRaw of ns.tools) {
        const t = obj(tRaw);
        const tool = String(t?.name ?? "?");
        top.push(`${name}.${tool}`);
        if (name === "functions" && tool === "exec") nested.push(...[...String(t?.description ?? "").matchAll(/^### `([^`]+)`/gm)].map((m) => String(m[1])));
      }
    }
  }
  if (!seen) throw new CodeModeError("codex debug prompt-input lists no tools");
  return { top, nested };
}

export function checkToolSurface(model: string, s: ToolSurface): CheckResult {
  const r: CheckResult = { failures: [], warnings: [] };
  for (const t of s.top) if (!ALLOWED_TOP_LEVEL.includes(t)) r.failures.push(`tool surface (${model}): ${t} is exposed`);
  for (const t of ALLOWED_TOP_LEVEL) if (!s.top.includes(t)) r.failures.push(`tool surface (${model}): ${t} is missing`);
  for (const n of s.nested) if (!ALLOWED_NESTED.includes(n)) r.failures.push(`tool surface (${model}): ${n} is reachable from exec`);
  return r;
}

function runLaunch(l: CodexLaunch, what: string): string {
  // stderr is never kept: it can hold local paths.
  const r = spawnSync(l.command, l.args, { cwd: l.cwd, env: l.env, stdio: ["ignore", "pipe", "ignore"], timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new CodeModeError(`codex ${what} failed under its profile`);
  return r.stdout.toString("utf8");
}

export function offlineRunner(install: CodexInstall): CodexDebugRunner {
  return (args, scratchHome) => {
    const l = buildOfflineCodexLaunch(install, scratchHome);
    return runLaunch({ ...l, args: [...l.args, ...args] }, `${args.slice(0, 2).join(" ")} (offline)`);
  };
}

/** `codex <args>` under the PRODUCTION profile with the real CODEX_HOME: Codex reads its own keyring; companiond reads
 * nothing. Used only when LIVE_SURFACE_CHECK is true, and by the Task 8 Step 7 measurement. */
export function liveRunner(install: CodexInstall, paths: AppPaths, relay: RelayEndpoint, home?: string): CodexDebugRunner {
  return (args) => runLaunch(buildCodexLaunch({ install, paths, sandboxed: true, relay, home, subcommand: args }), `${args.slice(0, 2).join(" ")} (live)`);
}

export const promptInputArgs = (model: string, extra: readonly string[] = []): string[] => ["debug", "prompt-input", "-c", `model=${tomlString(model)}`, ...extra, "hi"];

/** Writes the catalog and config.toml into CODEX_HOME and checks the tool surface offline (and, with `live`, live)
 * for every catalog model. */
export function prepareCodeMode(o: { install: CodexInstall; paths: AppPaths; off?: readonly string[]; run?: CodexDebugRunner; live?: CodexDebugRunner }): PreparedCodeMode {
  const run = o.run ?? offlineRunner(o.install);
  const off = o.off ?? OFF_FEATURES;
  // The scratch home sits in its own private root, so its staging folder (a sibling, see codexStageDir) is ours too.
  const scratchRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cgc-codemode-")));
  const scratch = path.join(scratchRoot, "home");
  try {
    fs.mkdirSync(scratch, { mode: 0o700 });
    fs.mkdirSync(path.join(scratch, "tmp"), { mode: 0o700 });
    // Codex's TMPDIR. Codex can replace it with a link: checked (and chmodded) without following one (final review I-1).
    ensurePrivateDir(path.join(o.paths.codexHome, "tmp"));
    const catalog = trimCatalog(run(["debug", "models"], scratch));
    writeCodexHomeFile(o.paths.codexHome, CATALOG_FILE, catalog.json);
    writeCodexConfig(o.paths.codexHome, buildCodexConfigToml(off, { catalogPath: path.join(o.paths.codexHome, CATALOG_FILE) }));
    // The same config in the scratch home, pointing at the scratch copy of the catalog.
    writeCodexHomeFile(scratch, CATALOG_FILE, catalog.json);
    const scratchConfig = (excluded?: readonly string[]) =>
      writeCodexConfig(scratch, buildCodexConfigToml(off, { catalogPath: path.join(scratch, CATALOG_FILE), excluded }));
    const result: CheckResult = { failures: [], warnings: [] };
    // Parser canary: with the `functions` namespace left in, exec lists nested tools. If the parser sees none,
    // it could not see a widened surface either, so the check fails closed.
    scratchConfig(["clock"]);
    if (parseToolSurface(run(promptInputArgs(catalog.models[0] as string), scratch)).nested.length === 0) {
      result.failures.push("tool surface: cannot read the tools nested in functions.exec");
    }
    scratchConfig();
    for (const m of catalog.models) result.failures.push(...checkToolSurface(m, parseToolSurface(run(promptInputArgs(m), scratch))).failures);
    if (o.live) {
      for (const m of catalog.models) result.failures.push(...checkToolSurface(`${m}, live`, parseToolSurface(o.live(promptInputArgs(m), o.paths.codexHome))).failures);
    }
    return { result, models: catalog.models, protectedFiles: snapshotProtectedFiles(o.paths.codexHome) };
  } catch (e) {
    const detail = e instanceof CodeModeError ? e.message
      : e instanceof AppDirError ? e.message.replace(/^Security check failed: /, "")
      : "the code-mode self-check could not run";
    return { result: { failures: [detail], warnings: [] }, models: [], protectedFiles: {} };
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}
