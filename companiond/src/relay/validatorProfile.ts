// The validator's own Seatbelt profile (spec §7.1.9; review C1): Node and companiond's code read-only, no network,
// no exec beyond Node itself, no process-fork, no file writes except /dev/null. The read rules mirror the jail's
// measured Node rules (M2, src/launch/seatbelt.ts) without the root, git or the developer folder.
import path from "node:path";
import { assertReadablePrefix, SANDBOX_EXEC, sbString, type LaunchSpec } from "../launch/seatbelt.ts";
import type { Toolchain } from "../launch/toolchain.ts";

const SYSTEM_READ_SUBPATHS = ["/usr/lib", "/usr/share", "/System", "/Library/Preferences"];
const SYSTEM_READ_LITERALS = ["/", "/usr", "/private/etc/localtime", "/dev/null", "/dev/urandom", "/dev/random"];
const SYSTEM_META_SUBPATHS = ["/usr", "/System", "/Library", "/private/etc", "/private/var/db", "/dev"];
const SYSTEM_META_LITERALS = ["/etc", "/var", "/tmp", "/private", "/private/var"];

function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let c = p; c !== "/"; ) {
    c = path.dirname(c);
    out.push(c);
  }
  return out;
}
const sub = (p: string) => `(subpath ${sbString(p)})`;
const lit = (p: string) => `(literal ${sbString(p)})`;

export function buildValidatorProfile(tc: Pick<Toolchain, "nodePath" | "nodeReadDirs" | "nodeReadFiles" | "metadataPaths" | "codeDir">): string {
  const reads = [...new Set([tc.codeDir, ...tc.nodeReadDirs])];
  for (const p of reads) assertReadablePrefix(p);
  const files = [...new Set(tc.nodeReadFiles)];
  const meta = [...new Set([...[...reads, ...files, tc.nodePath].flatMap(ancestors), ...files, ...tc.metadataPaths, ...SYSTEM_META_LITERALS])];
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    `(allow process-exec ${lit(tc.nodePath)})`,
    `(allow file-read* ${[...reads, ...SYSTEM_READ_SUBPATHS].map(sub).join(" ")} ${[...files, ...SYSTEM_READ_LITERALS].map(lit).join(" ")})`,
    `(allow file-read-metadata ${[...reads, ...SYSTEM_META_SUBPATHS].map(sub).join(" ")} ${meta.map(lit).join(" ")})`,
    '(allow file-write-data (literal "/dev/null"))',
    "(allow sysctl-read)",
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    "(deny network*)",
    "",
  ].join("\n");
}

export function buildValidatorLaunch(tc: Toolchain, tools: readonly string[]): LaunchSpec {
  return {
    command: SANDBOX_EXEC,
    args: ["-p", buildValidatorProfile(tc), tc.nodePath, path.join(tc.codeDir, "src", "relay", "validator.ts"), tools.join(",")],
    env: { PATH: "/usr/bin:/bin", OPENSSL_CONF: "/dev/null" },
    cwd: "/",
  };
}
