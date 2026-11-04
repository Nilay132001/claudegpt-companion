// Dev tool (M2 ruling 4/5): run the probe under each profile variant; one JSON line per run.
// Usage: cd companiond && node scripts/measure-profile.ts
import { DEFAULT_PROFILE_OPTIONS, type ProfileOptions } from "../src/launch/seatbelt.ts";
import { discoverToolchain } from "../src/launch/toolchain.ts";
import { removeTempDirs } from "../test/helpers/fixtures.ts";
import { makeProbeSetup, probeFailures, runProbe, type ProbeKind } from "../test/launch/probe.ts";

const variants: ProfileOptions[] = [
  { nodeReads: "exact", metadata: "narrow", denyNames: true, opensslConf: "devnull" },
  { nodeReads: "exact", metadata: "narrow", denyNames: true, opensslConf: "default" },
  { nodeReads: "exact", metadata: "narrow", denyNames: false, opensslConf: "devnull" },
  { nodeReads: "exact", metadata: "all", denyNames: false, opensslConf: "devnull" },
  // Rule 4 needs a row with deny names on top of open metadata, in case narrow metadata fails.
  { nodeReads: "exact", metadata: "all", denyNames: true, opensslConf: "devnull" },
  // Broad Homebrew reads are the fallback only. They are tried with the same narrow options as the first
  // rows, so a fallback never silently loosens metadata, deny rules or OpenSSL as well.
  { nodeReads: "homebrew-broad", metadata: "narrow", denyNames: true, opensslConf: "devnull" },
  { nodeReads: "homebrew-broad", metadata: "narrow", denyNames: true, opensslConf: "default" },
  { nodeReads: "homebrew-broad", metadata: "narrow", denyNames: false, opensslConf: "default" },
  { nodeReads: "homebrew-broad", metadata: "all", denyNames: false, opensslConf: "default" },
];

const tc = discoverToolchain();
console.log(
  JSON.stringify({
    node: process.version,
    nodeUnderHomebrew: tc.nodePath.startsWith("/opt/homebrew/"),
    nodeReadDirs: tc.nodeReadDirs.length,
    nodeReadFiles: tc.nodeReadFiles.length,
    metadataPaths: tc.metadataPaths.length,
    default: DEFAULT_PROFILE_OPTIONS,
  }),
);
// Control row: the default without the symlink metadata rules (the first Task 8 measurement's failure).
const runs: { v: ProfileOptions; symlinkMetadata: boolean }[] = [
  { v: DEFAULT_PROFILE_OPTIONS, symlinkMetadata: false },
  ...variants.map((v) => ({ v, symlinkMetadata: true })),
];
try {
  for (const { v, symlinkMetadata } of runs) {
    for (const kind of ["main", "worktree"] as ProbeKind[]) {
      const run = runProbe(symlinkMetadata ? tc : { ...tc, metadataPaths: [] }, await makeProbeSetup(kind), v);
      const failures = run.result ? probeFailures(run.result, v, kind) : [`node did not start (exit ${run.exit})`];
      const info = run.result ? Object.fromEntries(Object.entries(run.result).filter(([k]) => k.startsWith("info:"))) : {};
      console.log(JSON.stringify({ variant: v, symlinkMetadata, kind, pass: failures.length === 0, failures, info }));
    }
  }
} finally {
  removeTempDirs();
}
