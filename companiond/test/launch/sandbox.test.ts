// Spec §12.1 "Seatbelt": under the profile, reading outside root, any write, network and non-git exec fail.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PROFILE_OPTIONS, SANDBOX_EXEC } from "../../src/launch/seatbelt.ts";
import { discoverToolchain } from "../../src/launch/toolchain.ts";
import { removeTempDirs } from "../helpers/fixtures.ts";
import { makeProbeSetup, probeFailures, runProbe } from "./probe.ts";

after(removeTempDirs);

// Skipped only off macOS. On macOS a missing sandbox-exec fails these tests; there is no opt-out.
const skip = process.platform !== "darwin" ? "Seatbelt is macOS-only" : false;

test("sandbox-exec is present (macOS must fail, not skip, without it)", { skip }, () => {
  assert.ok(fs.existsSync(SANDBOX_EXEC), `${SANDBOX_EXEC} is missing`);
});

for (const kind of ["main", "worktree"] as const) {
  test(`the default profile allows reads in root and git, and blocks everything else (${kind})`, { skip }, async () => {
    const tc = discoverToolchain();
    const s = await makeProbeSetup(kind);
    const run = runProbe(tc, s, DEFAULT_PROFILE_OPTIONS);
    assert.ok(run.result, `probe did not run (exit ${run.exit}): ${run.stderrTail}`);
    assert.deepEqual(probeFailures(run.result, DEFAULT_PROFILE_OPTIONS, kind), []);
    // Narrow metadata: stat of an existing file outside root and outside the toolchain is refused by Seatbelt.
    assert.match(run.result.statOutside ?? "missing", /^blocked:(EPERM|EACCES)$/);
    assert.equal(fs.existsSync(path.join(s.root, "PWNED.txt")), false);
    assert.equal(fs.existsSync(path.join(s.root, "pwned-dir")), false);
    assert.equal(fs.existsSync(path.join(s.root, "README.md")), true);
    assert.equal(fs.existsSync(path.join(path.dirname(s.outsideFile), "PWNED.txt")), false);
    assert.equal(fs.existsSync(path.join(s.tmpDir, "PWNED-cgc-probe.txt")), false);
    assert.equal(fs.existsSync(path.join(s.home, "PWNED-cgc-probe.txt")), false);
  });
}
