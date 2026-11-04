// Codex itself under Seatbelt (spec §7.1.9, approved 2026-11-04). Reads: its own files, CODEX_HOME,
// the empty companion folder, system paths. Writes: CODEX_HOME only. Network: allowed.
// Children inherit this profile. See Task 6 in the M4a plan before widening anything.
import os from "node:os";
import path from "node:path";
import type { AppPaths } from "../app/appPaths.ts";
import { SANDBOX_EXEC } from "../launch/seatbelt.ts";
import type { CodexInstall } from "./codexInstall.ts";
import { BASE_MCP_COMMAND } from "./config.ts";

export interface CodexLaunch { command: string; args: string[]; env: Record<string, string>; cwd: string }
export interface CodexProfileOptions {
  keychainFileReads: boolean;
  metadataEverywhere: boolean;
  /** Empty in the approved profile. Anything here needs an owner ruling first. */
  extraReads: readonly string[];
  extraExec: readonly string[];
}

/** Measured in Task 6 Step 6. */
export const DEFAULT_CODEX_PROFILE_OPTIONS: CodexProfileOptions = { keychainFileReads: false, metadataEverywhere: false, extraReads: [], extraExec: [] };
/** Set in Task 6 Step 7: "ok" only if the strict profile passed every check. */
export const CODEX_SEATBELT_MEASURED: "ok" | "stopped" = "stopped";

export const SYSTEM_READS: readonly string[] = [
  "/usr/lib", "/usr/share", "/System", "/Library/Preferences", "/Library/Keychains",
  "/private/etc/ssl", "/private/etc/codex", "/private/var/db/timezone",
];
export const SYSTEM_READ_LITERALS: readonly string[] = [
  "/", "/usr", "/private/etc/localtime", "/private/etc/hosts", "/private/etc/resolv.conf", "/private/var/run/resolv.conf",
  "/dev/null", "/dev/urandom", "/dev/random",
];
export const MACH_LOOKUPS: readonly string[] = [
  "com.apple.SecurityServer", "com.apple.securityd.xpc", "com.apple.trustd", "com.apple.trustd.agent",
  "com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership",
  "com.apple.dnssd.service", "com.apple.SystemConfiguration.configd", "com.apple.SystemConfiguration.DNSConfiguration",
  "com.apple.networkd", "com.apple.cfprefsd.daemon", "com.apple.cfprefsd.agent", "com.apple.system.notification_center",
  "com.apple.logd", "com.apple.diagnosticd",
];

export function sbplString(s: string): string {
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error("control character in a Seatbelt path");
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildCodexProfile(i: { install: CodexInstall; codexHome: string; emptyCwd: string; home: string; options: CodexProfileOptions }): string {
  const sub = (p: string) => `(subpath ${sbplString(p)})`;
  const lit = (p: string) => `(literal ${sbplString(p)})`;
  const exec = [i.install.binary, ...(i.install.codeModeHost ? [i.install.codeModeHost] : []), SANDBOX_EXEC, BASE_MCP_COMMAND, ...i.options.extraExec];
  const reads = [
    i.install.vendorDir, i.codexHome, i.emptyCwd, ...SYSTEM_READS,
    ...(i.options.keychainFileReads ? [path.join(i.home, "Library", "Keychains")] : []),
    ...i.options.extraReads,
  ];
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    `(allow process-exec ${exec.map(lit).join(" ")}${i.install.pathDir ? ` ${sub(i.install.pathDir)}` : ""})`,
    `(allow file-read* ${reads.map(sub).join(" ")} ${SYSTEM_READ_LITERALS.map(lit).join(" ")})`,
    ...(i.options.metadataEverywhere ? ["(allow file-read-metadata)"] : []),
    `(allow file-write* ${sub(i.codexHome)} ${lit("/dev/null")})`,
    "(allow network*)",
    "(allow sysctl-read)",
    `(allow mach-lookup ${MACH_LOOKUPS.map((n) => `(global-name ${sbplString(n)})`).join(" ")})`,
    "",
  ].join("\n");
}

/** A fresh environment: nothing from companiond's env reaches Codex (no API keys). */
export function codexEnv(install: CodexInstall, paths: AppPaths, home: string): Record<string, string> {
  return {
    CODEX_HOME: paths.codexHome,
    HOME: home,
    TMPDIR: path.join(paths.codexHome, "tmp"),
    PATH: [install.pathDir, "/usr/bin", "/bin"].filter((x): x is string => typeof x === "string").join(":"),
    LANG: "en_US.UTF-8",
    CODEX_MANAGED_BY_NPM: "1",
  };
}

export function buildCodexLaunch(o: {
  install: CodexInstall; paths: AppPaths; sandboxed: boolean; home?: string; options?: CodexProfileOptions; extraArgs?: readonly string[];
}): CodexLaunch {
  const home = o.home ?? os.homedir();
  const codexArgs = ["app-server", ...(o.extraArgs ?? [])];
  const env = codexEnv(o.install, o.paths, home);
  if (!o.sandboxed) return { command: o.install.binary, args: codexArgs, env, cwd: o.paths.emptyCwd };
  const profile = buildCodexProfile({ install: o.install, codexHome: o.paths.codexHome, emptyCwd: o.paths.emptyCwd, home, options: o.options ?? DEFAULT_CODEX_PROFILE_OPTIONS });
  return { command: SANDBOX_EXEC, args: ["-p", profile, o.install.binary, ...codexArgs], env, cwd: o.paths.emptyCwd };
}
