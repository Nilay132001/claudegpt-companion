// companion-jira's Seatbelt profile (owner ruling B). The validator's profile (no fork, exec of Node only, Node and
// companiond code read-only, no writes) plus outbound HTTPS: TCP 443 minus loopback, the DNS socket and the DNS /
// network mach services from Codex's measured list. No keychain or trust services: Node's TLS uses its own CA list.
import path from "node:path";
import { DNS_SOCKET, LOOPBACK_DENY, MACH_LOOKUPS } from "../codex/codexSeatbelt.ts";
import { assertReadablePrefix, SANDBOX_EXEC, sbString, type LaunchSpec } from "../launch/seatbelt.ts";
import type { Toolchain } from "../launch/toolchain.ts";

const SYSTEM_READ_SUBPATHS = ["/usr/lib", "/usr/share", "/System", "/Library/Preferences", "/private/var/db/timezone"];
const SYSTEM_READ_LITERALS = ["/", "/usr", "/private/etc/localtime", "/private/etc/hosts", "/private/etc/resolv.conf", "/private/var/run/resolv.conf",
  "/dev/null", "/dev/urandom", "/dev/random"];
const SYSTEM_META_SUBPATHS = ["/usr", "/System", "/Library", "/private/etc", "/private/var/db", "/dev"];
const SYSTEM_META_LITERALS = ["/etc", "/var", "/tmp", "/private", "/private/var", "/private/var/run"];
const KEYCHAIN_MACH = /SecurityServer|securityd|trustd/;
export const JIRA_MACH_LOOKUPS: readonly string[] = MACH_LOOKUPS.filter((n) => !KEYCHAIN_MACH.test(n));

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

export function buildJiraProfile(tc: Pick<Toolchain, "nodePath" | "nodeReadDirs" | "nodeReadFiles" | "metadataPaths" | "codeDir">): string {
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
    '(allow network-outbound (remote tcp "*:443"))',
    LOOPBACK_DENY,
    `(allow network-outbound (remote unix-socket (path-literal ${sbString(DNS_SOCKET)})))`,
    `(allow mach-lookup ${JIRA_MACH_LOOKUPS.map((n) => `(global-name "${n}")`).join(" ")})`,
    "",
  ].join("\n");
}

export function buildJiraLaunch(tc: Toolchain, extraArgs: readonly string[] = []): LaunchSpec {
  return {
    command: SANDBOX_EXEC,
    // --use-bundled-ca: Node 26 defaults to the system CA store, which needs keychain and trust services the profile denies.
    args: ["-p", buildJiraProfile(tc), tc.nodePath, "--use-bundled-ca", path.join(tc.codeDir, "src", "jira", "main.ts"), ...extraArgs],
    env: { PATH: "/usr/bin:/bin", OPENSSL_CONF: "/dev/null" },
    cwd: "/",
  };
}
