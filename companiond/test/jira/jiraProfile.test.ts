import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJiraLaunch, buildJiraProfile, JIRA_MACH_LOOKUPS } from "../../src/jira/jiraProfile.ts";

const tc = {
  nodePath: "/opt/node/bin/node", nodeReadDirs: ["/opt/node/lib"], nodeReadFiles: ["/opt/node/bin/node"], metadataPaths: [],
  codeDir: "/opt/companion/companiond", gitPath: "/usr/bin/git", developerDir: null, serverEntry: "/opt/companion/companiond/src/jail/main.ts",
} as any;

test("profile: deny default, Node only, no fork, no writes, 443 minus loopback, DNS, no keychain", () => {
  const p = buildJiraProfile(tc);
  assert.ok(p.includes("(deny default)"));
  assert.ok(p.includes('(allow process-exec (literal "/opt/node/bin/node"))'));
  assert.ok(!p.includes("process-fork"));
  assert.ok(!/file-write\*/.test(p) && p.includes('(allow file-write-data (literal "/dev/null"))'));
  assert.ok(p.includes('(allow network-outbound (remote tcp "*:443"))'));
  assert.ok(p.indexOf('(deny network-outbound (remote tcp "localhost:*"))') > p.indexOf('(remote tcp "*:443")'), "the loopback deny comes after the allow");
  assert.ok(p.includes("/private/var/run/mDNSResponder"));
  assert.ok(!/network-bind|network-inbound/.test(p));
  assert.ok(!/SecurityServer|securityd|trustd|Keychains/.test(p));
  assert.ok(!p.includes("/opt/companion/companiond/../"));
  for (const m of JIRA_MACH_LOOKUPS) assert.ok(p.includes(`"${m}"`), m);
});

test("launch: sandbox-exec, the jira entry, a fixed env with no credential, and --check passes through", () => {
  const l = buildJiraLaunch(tc);
  assert.equal(l.command, "/usr/bin/sandbox-exec");
  assert.deepEqual(l.args.slice(2), ["/opt/node/bin/node", "--use-bundled-ca", "/opt/companion/companiond/src/jira/main.ts"]);
  assert.deepEqual(l.env, { PATH: "/usr/bin:/bin", OPENSSL_CONF: "/dev/null" });
  assert.equal(l.cwd, "/");
  assert.deepEqual(buildJiraLaunch(tc, ["--check"]).args.slice(-1), ["--check"]);
});
