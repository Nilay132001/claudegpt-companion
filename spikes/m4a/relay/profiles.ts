// SPIKE (M4a option b). Codex's Seatbelt profile with the relay: the approved strict profile
// (companiond/src/codex/codexSeatbelt.ts) with three changes, nothing wider:
//  1. process-exec: the Codex binary and ONE launcher (the relay). Not sandbox-exec, not /usr/bin/false,
//     not the codex-path folder, not the code-mode host.
//  2. file-read-metadata literals on the ancestor folders of CODEX_HOME, the vendor folder and the companion
//     folder (the measured parentMetadata variant), plus a read literal on the launcher itself.
//  3. network: no `network*`. Outbound TCP to port 443 (OpenAI, unmeasured until the owner signs in) and
//     outbound unix-socket to exactly the relay socket. No inbound, no bind.
import path from "node:path";
import { MACH_LOOKUPS, SYSTEM_READ_LITERALS, SYSTEM_READS, sbplString } from "../../../companiond/src/codex/codexSeatbelt.ts";

export interface RelayProfileInput {
  codexBinary: string;
  vendorDir: string;
  codexHome: string;
  emptyCwd: string;
  supportDir: string;
  launcher: string;
  relaySocket: string;
}

export function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let d = path.dirname(p); ; d = path.dirname(d)) {
    out.push(d);
    if (d === path.dirname(d)) return out;
  }
}

export function buildRelayCodexProfile(i: RelayProfileInput): string {
  const sub = (p: string) => `(subpath ${sbplString(p)})`;
  const lit = (p: string) => `(literal ${sbplString(p)})`;
  const reads = [i.vendorDir, i.codexHome, i.emptyCwd, ...SYSTEM_READS];
  const meta = [...new Set([i.codexHome, i.vendorDir, i.supportDir].flatMap(ancestors))];
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    `(allow process-exec ${lit(i.codexBinary)} ${lit(i.launcher)})`,
    `(allow file-read* ${reads.map(sub).join(" ")} ${[...SYSTEM_READ_LITERALS, i.launcher].map(lit).join(" ")})`,
    `(allow file-read-metadata ${meta.map(lit).join(" ")})`,
    `(allow file-write* ${sub(i.codexHome)} ${lit("/dev/null")})`,
    '(allow network-outbound (remote tcp "*:443"))',
    `(allow network-outbound (remote unix-socket (path-literal ${sbplString(i.relaySocket)})))`,
    "(allow sysctl-read)",
    `(allow mach-lookup ${MACH_LOOKUPS.map((n) => `(global-name ${sbplString(n)})`).join(" ")})`,
    "",
  ].join("\n");
}
