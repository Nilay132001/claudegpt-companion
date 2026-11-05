// Codex itself under Seatbelt (spec §7.1.9: approved 2026-11-04; relay and code-mode rulings 2026-11-04).
// Measured rules only (step1-report.md, codemode-report.md). Children inherit this profile: the code-mode host and
// the relay run under it too. Online (app-server): exec of Codex, its code-mode host and the relay; reads of its own
// files, CODEX_HOME, the empty folder, system paths and the login keychain file; writes only CODEX_HOME minus the
// files companiond writes; network only TCP 443 (not loopback), the DNS socket and the one relay socket.
// Offline (`codex debug …` for the self-check): the same without any network, keychain or relay rule.
import os from "node:os";
import path from "node:path";
import type { AppPaths } from "../app/appPaths.ts";
import { SANDBOX_EXEC } from "../launch/seatbelt.ts";
import type { CodexInstall } from "./codexInstall.ts";
import { CODEX_PROTECTED_FILES } from "./config.ts";

export interface CodexLaunch { command: string; args: string[]; env: Record<string, string>; cwd: string }
export interface RelayEndpoint { binary: string; socket: string }
export interface CodexProfileInput {
  install: CodexInstall;
  codexHome: string;
  emptyCwd: string;
  supportDir: string;
  home: string;
  /** null = the offline profile (no network at all). */
  relay: RelayEndpoint | null;
  /** File names inside CODEX_HOME that Codex may not write (companiond writes them before spawn). */
  protectedFiles: readonly string[];
  /** The short-lived sign-in process only (ruling I-9): adds LOGIN_RULES. Needs relay !== null. */
  login?: boolean;
}

/** Measured while planning (signed out, macOS 27, Codex 0.166.0): Codex's ChatGPT sign-in listens on 127.0.0.1:1455
 * (redirect_uri http://127.0.0.1:1455/auth/callback). bind alone is not enough; bind + inbound on localhost:1455 lets
 * account/login/start succeed, keeps every other port closed (1456: EPERM), but SBPL also lets it bind 1455 on
 * 0.0.0.0 and the Mac's own address (recorded residual risk). Only the sign-in process gets these rules. */
export const LOGIN_CALLBACK_PORT = 1455;
export const LOGIN_RULES: readonly string[] = [
  `(allow network-bind (local tcp "localhost:${LOGIN_CALLBACK_PORT}"))`,
  `(allow network-inbound (local tcp "localhost:${LOGIN_CALLBACK_PORT}"))`,
];
/** Keychain and trust services: not reachable from the offline profile (plan review M-1; measured: debug models and
 * prompt-input still run without them). */
const KEYCHAIN_MACH = /SecurityServer|securityd|trustd/;

/** Set in Task 10, and only on measured success of the end-to-end suites and the exec-cell gate. */
export const CODEX_SEATBELT_MEASURED: "ok" | "stopped" = "stopped";

export const DNS_SOCKET = "/private/var/run/mDNSResponder";
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

/** Every folder above p, "/" included: metadata-only literals (the measured parentMetadata variant). */
export function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let d = path.dirname(p); ; d = path.dirname(d)) {
    out.push(d);
    if (d === path.dirname(d)) return out;
  }
}

export function buildCodexProfile(i: CodexProfileInput): string {
  if (!i.install.codeModeHost) throw new Error("This Codex install has no code-mode host.");
  if (i.login && !i.relay) throw new Error("The sign-in profile is an online profile.");
  const sub = (p: string) => `(subpath ${sbplString(p)})`;
  const lit = (p: string) => `(literal ${sbplString(p)})`;
  const keychains = path.join(i.home, "Library", "Keychains");
  const r = i.relay;
  const exec = [i.install.binary, i.install.codeModeHost, ...(r ? [r.binary] : [])];
  const reads = [i.install.vendorDir, i.codexHome, i.emptyCwd, ...SYSTEM_READS];
  const readLiterals = [...SYSTEM_READ_LITERALS, ...(r ? [r.binary, path.join(keychains, "login.keychain-db")] : [])];
  const meta = [...new Set([...[i.codexHome, i.install.vendorDir, i.supportDir].flatMap(ancestors), ...(r ? [keychains] : [])])];
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    `(allow process-exec ${exec.map(lit).join(" ")})`,
    `(allow file-read* ${reads.map(sub).join(" ")} ${readLiterals.map(lit).join(" ")})`,
    `(allow file-read-metadata ${meta.map(lit).join(" ")})`,
    `(allow file-write* ${sub(i.codexHome)} ${lit("/dev/null")})`,
    // Later rules win: companiond writes these before spawn, and a cell or patch must never rewrite them (ruling).
    ...(i.protectedFiles.length > 0 ? [`(deny file-write* ${i.protectedFiles.map((f) => lit(path.join(i.codexHome, f))).join(" ")})`] : []),
    ...(r
      ? [
          '(allow network-outbound (remote tcp "*:443"))',
          '(deny network-outbound (remote tcp "localhost:*"))', // review I5: no local service on 443
          `(allow network-outbound (remote unix-socket (path-literal ${sbplString(DNS_SOCKET)})))`,
          `(allow network-outbound (remote unix-socket (path-literal ${sbplString(r.socket)})))`,
        ]
      : []),
    ...(i.login ? LOGIN_RULES : []),
    "(allow sysctl-read)",
    `(allow mach-lookup ${(r ? MACH_LOOKUPS : MACH_LOOKUPS.filter((n) => !KEYCHAIN_MACH.test(n))).map((n) => `(global-name ${sbplString(n)})`).join(" ")})`,
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
  install: CodexInstall; paths: AppPaths; sandboxed: boolean; relay?: RelayEndpoint; home?: string; extraArgs?: readonly string[];
  /** The sign-in process (ruling I-9). */
  login?: boolean;
  /** Default ["app-server"]; the live surface check runs ["debug", "prompt-input", …] under the same profile. */
  subcommand?: readonly string[];
}): CodexLaunch {
  const home = o.home ?? os.homedir();
  const codexArgs = [...(o.subcommand ?? ["app-server"]), ...(o.extraArgs ?? [])];
  const env = codexEnv(o.install, o.paths, home);
  if (!o.sandboxed) return { command: o.install.binary, args: codexArgs, env, cwd: o.paths.emptyCwd };
  if (!o.relay) throw new Error("A sandboxed Codex needs the relay endpoint for its profile.");
  const profile = buildCodexProfile({
    install: o.install, codexHome: o.paths.codexHome, emptyCwd: o.paths.emptyCwd, supportDir: o.paths.supportDir, home,
    relay: o.relay, protectedFiles: CODEX_PROTECTED_FILES, login: o.login === true,
  });
  return { command: SANDBOX_EXEC, args: ["-p", profile, o.install.binary, ...codexArgs], env, cwd: o.paths.emptyCwd };
}

/** `codex <args>` offline in a scratch CODEX_HOME (callers append the subcommand). No network, no credentials. */
export function buildOfflineCodexLaunch(install: CodexInstall, scratchHome: string): CodexLaunch {
  const profile = buildCodexProfile({ install, codexHome: scratchHome, emptyCwd: scratchHome, supportDir: scratchHome, home: scratchHome, relay: null, protectedFiles: [] });
  return {
    command: SANDBOX_EXEC,
    args: ["-p", profile, install.binary],
    env: { CODEX_HOME: scratchHome, HOME: scratchHome, TMPDIR: path.join(scratchHome, "tmp"), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    cwd: scratchHome,
  };
}
