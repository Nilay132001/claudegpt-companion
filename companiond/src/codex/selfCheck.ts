// Startup and per-thread self-check (spec §7.1.2, §7.1.5). Pure evaluators; CodexHost gathers the data.
// Failure details never contain local paths: they reach the UI as "Security check failed: <detail>".
import fs from "node:fs";
import path from "node:path";
import type { ToolAllowlist } from "./serverRequests.ts";

export interface CheckResult { failures: string[]; warnings: string[] }
export interface FsProbe { exists(p: string): boolean; list(p: string): string[] }

export const UNIFIED_EXEC_EXCEPTION = { feature: "unified_exec", version: "0.166.0", stage: "stable", enabled: true, defaultEnabled: true } as const;
export const INSTRUCTION_FILES: readonly string[] = [".git", "AGENTS.md", "AGENTS.override.md"];

export const nodeFsProbe: FsProbe = {
  exists: (p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  },
  list: (p) => fs.readdirSync(p),
};

const empty = (): CheckResult => ({ failures: [], warnings: [] });
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function mergeChecks(...rs: CheckResult[]): CheckResult {
  return { failures: rs.flatMap((r) => r.failures), warnings: rs.flatMap((r) => r.warnings) };
}

export function versionFromUserAgent(ua: unknown): string | null {
  if (typeof ua !== "string") return null;
  return /\bcodex[\w-]*\/(\d+\.\d+\.\d+)\b/i.exec(ua)?.[1] ?? null;
}

export function checkVersion(installed: string, pinned: string, userAgent: unknown): CheckResult {
  const r = empty();
  if (installed !== pinned) r.failures.push(`Codex ${installed} is installed; pinned is ${pinned}`);
  const ua = versionFromUserAgent(userAgent);
  if (ua === null) r.warnings.push("app-server did not report its version; using the installed package version");
  else if (ua !== pinned) r.failures.push(`app-server reports Codex ${ua}; pinned is ${pinned}`);
  return r;
}

export function checkConfigRead(resp: unknown, off: readonly string[]): CheckResult {
  const r = empty();
  const cfg = obj(obj(resp)?.config) ?? {};
  const features = obj(cfg.features) ?? {};
  for (const k of off) if (features[k] !== false) r.failures.push(`config/read: features.${k} is not false`);
  if (cfg.web_search !== "disabled") r.failures.push("config/read: web_search is not disabled");
  const layers = obj(resp)?.layers;
  if (!Array.isArray(layers)) r.failures.push("config/read returned no layers");
  else if (layers.some((l) => obj(obj(l)?.name)?.type === "project")) r.failures.push("config/read: a project config layer is loaded");
  return r;
}

export function checkFeatureList(entries: readonly unknown[], off: readonly string[], version: string): CheckResult {
  const r = empty();
  const x = UNIFIED_EXEC_EXCEPTION;
  for (const k of off) {
    const e = entries.map(obj).find((f) => f?.name === k);
    if (!e) {
      r.failures.push(`experimentalFeature/list has no ${k}`);
      continue;
    }
    if (e.enabled === false) continue;
    if (k === x.feature && version === x.version && e.stage === x.stage && e.enabled === x.enabled && e.defaultEnabled === x.defaultEnabled) {
      r.warnings.push("unified_exec: experimentalFeature/list shows it on while config/read shows it off (known on Codex 0.166.0, spec §7.1.5)");
    } else {
      r.failures.push(`experimentalFeature/list: ${k} is enabled`);
    }
  }
  return r;
}

export function checkCompanionCwd(cwd: string, fsx: FsProbe = nodeFsProbe): CheckResult {
  const r = empty();
  if (fsx.list(cwd).length !== 0) r.failures.push("the companion's empty folder is not empty");
  let dir = cwd;
  for (let up = 0; ; up++) {
    for (const name of INSTRUCTION_FILES) {
      if (fsx.exists(path.join(dir, name))) {
        r.failures.push(up === 0 ? `${name} found in the companion's folder` : `${name} found ${up} folder(s) above the companion's folder`);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return r;
}

export function checkCodexHome(codexHome: string, fsx: FsProbe = nodeFsProbe): CheckResult {
  const r = empty();
  for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
    if (fsx.exists(path.join(codexHome, name))) r.failures.push(`${name} found in the companion's Codex home`);
  }
  return r;
}

export function checkMcpStatus(entries: readonly unknown[], allow: ToolAllowlist, scope: "process" | "thread"): CheckResult {
  const r = empty();
  const seen = new Set<string>();
  for (const raw of entries) {
    const e = obj(raw);
    const name = typeof e?.name === "string" ? e.name : "<unnamed>";
    seen.add(name);
    const allowed = allow.get(name);
    if (!allowed) {
      r.failures.push(`MCP server ${name} is not allowlisted`);
      continue;
    }
    const tools = Object.keys(obj(e?.tools) ?? {});
    for (const t of tools) if (!allowed.has(t)) r.failures.push(`MCP tool ${name}/${t} is not allowlisted`);
    if (scope === "thread") for (const t of allowed) if (!tools.includes(t)) r.failures.push(`MCP tool ${name}/${t} is missing`);
  }
  if (scope === "thread") for (const s of allow.keys()) if (!seen.has(s)) r.failures.push(`MCP server ${s} is not running for this thread`);
  return r;
}

export function checkThreadResponse(resp: unknown, emptyCwd: string): CheckResult {
  const r = empty();
  const o = obj(resp);
  const src = o?.instructionSources;
  if (!Array.isArray(src)) r.failures.push("thread response has no instructionSources");
  else if (src.length > 0) r.failures.push(`Codex loaded ${src.length} instruction file(s) for this thread`);
  if (o?.cwd !== emptyCwd) r.failures.push("thread cwd is not the companion's empty folder");
  if (o?.approvalPolicy !== "untrusted") r.failures.push("thread approval policy is not untrusted");
  if (obj(o?.sandbox)?.type !== "readOnly") r.failures.push("thread sandbox is not read-only");
  return r;
}
