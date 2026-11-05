// M6 measurement: the companion-jira profile allows HTTPS to a public host and nothing else that matters.
// Opt-in: COMPANION_ITEST=1 (real network, to example.com only; never a Jira site).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildJiraProfile } from "../src/jira/jiraProfile.ts";
import { discoverToolchain } from "../src/launch/toolchain.ts";

const on = process.env.COMPANION_ITEST === "1" && process.platform === "darwin";

test("companion-jira profile: https to a public host works; port 80, loopback, home reads and writes fail", { skip: !on }, () => {
  const tc = discoverToolchain();
  const probe = fileURLToPath(new URL("./fixtures/netProbe.ts", import.meta.url));
  // The probe lives under companiond/itest, inside the profile's code read rule (codeDir).
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", buildJiraProfile(tc), tc.nodePath, "--use-bundled-ca", probe], { env: { PATH: "/usr/bin:/bin", OPENSSL_CONF: "/dev/null" }, encoding: "utf8", timeout: 30_000 });
  const out = JSON.parse(r.stdout.trim());
  assert.match(out.https, /^status [23]\d\d$/, JSON.stringify(out));
  assert.notEqual(out.port80, "ok");
  assert.notEqual(out.loopback443, "ok");
  assert.notEqual(out.readHome, "ok");
  assert.notEqual(out.writeTmp, "ok");
});
