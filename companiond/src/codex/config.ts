// The companion's Codex config.toml (spec §7.1.1). Rewritten at every start.
import fs from "node:fs";
import path from "node:path";
import { AppDirError, ensurePrivateDir } from "../app/appPaths.ts";
import { SERVER_NAME, TOOL_NAMES } from "../jail/mcpServer.ts";

export const REQUIRED_OFF_FEATURES: readonly string[] = [
  "shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use",
  "image_generation", "multi_agent", "hooks", "memories", "view_image",
];
/** Measured in Task 5 Step 1. code_mode_host left this list on 2026-11-04: code mode is ON (owner ruling). */
export const CANDIDATE_OFF_FEATURES: readonly string[] = ["sleep_tool"];
export const OFF_FEATURES: readonly string[] = [...REQUIRED_OFF_FEATURES, ...CANDIDATE_OFF_FEATURES];
/** The base companion-readonly server does nothing: only a binding points it at the jail. */
export const BASE_MCP_COMMAND = "/usr/bin/false";
/** Code mode, closed down (owner ruling 2026-11-04; codemode-report.md "combinedB"). goals is checked through
 * config/read only: it is not known to be listed by experimentalFeature/list. */
export const CODE_MODE_OFF_FEATURES: readonly string[] = ["goals"];
export const EXCLUDED_TOOL_NAMESPACES: readonly string[] = ["clock", "functions"];
/** Generated at every start by codeMode.ts. Never a checked-in copy. */
export const CATALOG_FILE = "companion-models.json";
/** companiond writes these before spawn; the Codex profile denies Codex writes to them. */
export const CODEX_PROTECTED_FILES: readonly string[] = ["config.toml", CATALOG_FILE];
export interface CodeModeConfig { catalogPath: string; excluded?: readonly string[] }

export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

export function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

export function tomlValue(v: unknown): string {
  if (typeof v === "string") return tomlString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (v !== null && typeof v === "object") {
    return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(", ")} }`;
  }
  throw new TypeError(`cannot write ${typeof v} as TOML`);
}

export function buildCodexConfigToml(off: readonly string[] = OFF_FEATURES, codeMode?: CodeModeConfig): string {
  return [
    "# Written by companiond at every start. Edits are overwritten.",
    ...(codeMode ? [`model_catalog_json = ${tomlString(codeMode.catalogPath)}`] : []),
    'cli_auth_credentials_store = "keyring"',
    'web_search = "disabled"',
    // No approval_policy here: 0.166.0 refuses `approval_policy = "untrusted"` in config.toml
    // ("no longer supported"). thread/start sets it per thread and checkThreadResponse verifies it.
    'approvals_reviewer = "user"',
    'sandbox_mode = "read-only"',
    "",
    "[features]",
    ...off.map((k) => `${tomlKey(k)} = false`),
    ...(codeMode ? ["code_mode_host = true", ...CODE_MODE_OFF_FEATURES.map((k) => `${tomlKey(k)} = false`)] : []),
    "",
    ...(codeMode
      ? [
          "[features.code_mode]",
          `excluded_tool_namespaces = ${tomlValue([...(codeMode.excluded ?? EXCLUDED_TOOL_NAMESPACES)])}`,
          "",
          "[tools]",
          "experimental_request_user_input = { enabled = false }",
          "",
        ]
      : []),
    `[mcp_servers.${tomlKey(SERVER_NAME)}]`,
    `command = ${tomlString(BASE_MCP_COMMAND)}`,
    "args = []",
    `enabled_tools = ${tomlValue([...TOOL_NAMES])}`,
    "",
  ].join("\n");
}

/** companiond's staging folder for the files it writes into a Codex home: a sibling of that home, which Codex cannot
 * write (its profile allows writes inside CODEX_HOME only), so it is on the same volume and the rename is atomic. */
export const CODEX_STAGE_DIR = "codex-stage";
export const codexStageDir = (codexHome: string): string => path.join(path.dirname(codexHome), CODEX_STAGE_DIR);

/** Atomic, 0600 (final review I-1). Codex may write anything inside CODEX_HOME, so nothing is staged there: a temp
 * name inside it could be a symlink Codex planted, and companiond would write through it. The file is created in
 * companiond's own 0700 staging folder with O_CREAT|O_EXCL|O_NOFOLLOW (flag "wx", never following a link), then
 * renamed into CODEX_HOME; rename replaces a link at the destination, it never follows one. A name already taken in
 * the staging folder by anything but a plain file (a leftover of a crash) fails the write, so the start fails closed. */
export function writeCodexHomeFile(codexHome: string, name: string, body: string): void {
  if (name !== path.basename(name) || name.startsWith(".")) throw new Error("not a plain file name");
  const stage = codexStageDir(codexHome);
  ensurePrivateDir(stage);
  const tmpFile = path.join(stage, `${name}.tmp-${process.pid}`);
  const st = lstatOrNull(tmpFile);
  if (st && !st.isFile()) throw new AppDirError("Security check failed: the companion's staging folder holds an unexpected entry.");
  if (st) fs.unlinkSync(tmpFile); // unlink never follows a link
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const fd = fs.openSync(tmpFile, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpFile, path.join(codexHome, name));
  } catch (e) {
    fs.rmSync(tmpFile, { force: true });
    throw e;
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export function writeCodexConfig(codexHome: string, toml: string): void {
  writeCodexHomeFile(codexHome, "config.toml", toml);
}
