// The companion's Codex config.toml (spec §7.1.1). Rewritten at every start.
import fs from "node:fs";
import path from "node:path";
import { SERVER_NAME, TOOL_NAMES } from "../jail/mcpServer.ts";

export const REQUIRED_OFF_FEATURES: readonly string[] = [
  "shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use",
  "image_generation", "multi_agent", "hooks", "memories", "view_image",
];
/** Measured in Task 5 Step 1: keep only keys that `codex features list` shows on 0.166.0. */
export const CANDIDATE_OFF_FEATURES: readonly string[] = ["code_mode_host", "sleep_tool"];
export const OFF_FEATURES: readonly string[] = [...REQUIRED_OFF_FEATURES, ...CANDIDATE_OFF_FEATURES];
/** The base companion-readonly server does nothing: only a binding points it at the jail. */
export const BASE_MCP_COMMAND = "/usr/bin/false";

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

export function buildCodexConfigToml(off: readonly string[] = OFF_FEATURES): string {
  return [
    "# Written by companiond at every start. Edits are overwritten.",
    'cli_auth_credentials_store = "keyring"',
    'web_search = "disabled"',
    // No approval_policy here: 0.166.0 refuses `approval_policy = "untrusted"` in config.toml
    // ("no longer supported"). thread/start sets it per thread and checkThreadResponse verifies it.
    'approvals_reviewer = "user"',
    'sandbox_mode = "read-only"',
    "",
    "[features]",
    ...off.map((k) => `${tomlKey(k)} = false`),
    "",
    `[mcp_servers.${tomlKey(SERVER_NAME)}]`,
    `command = ${tomlString(BASE_MCP_COMMAND)}`,
    "args = []",
    `enabled_tools = ${tomlValue([...TOOL_NAMES])}`,
    "",
  ].join("\n");
}

export function writeCodexConfig(codexHome: string, toml: string): void {
  const file = path.join(codexHome, "config.toml");
  const tmpFile = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmpFile, toml, { mode: 0o600 });
  fs.chmodSync(tmpFile, 0o600);
  fs.renameSync(tmpFile, file);
}
