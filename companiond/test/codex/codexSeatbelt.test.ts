import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppPaths } from "../../src/app/appPaths.ts";
import type { CodexInstall } from "../../src/codex/codexInstall.ts";
import { buildCodexLaunch, buildCodexProfile, buildOfflineCodexLaunch, sbplString } from "../../src/codex/codexSeatbelt.ts";
import { CODEX_PROTECTED_FILES } from "../../src/codex/config.ts";

const install: CodexInstall = {
  version: "0.166.0", vendorDir: "/v", binary: "/v/bin/codex", codeModeHost: "/v/bin/codex-code-mode-host", pathDir: "/v/codex-path", resourcesDir: "/v/codex-resources",
};
const paths: AppPaths = { supportDir: "/s", codexHome: "/s/codex-home", emptyCwd: "/s/empty-cwd", dbPath: "/s/companion.db" };
const relay = { binary: "/s/bin/cgc-relay", socket: "/s/run/relay.sock" };
const online = () => buildCodexProfile({ install, codexHome: paths.codexHome, emptyCwd: paths.emptyCwd, supportDir: paths.supportDir, home: "/h", relay, protectedFiles: CODEX_PROTECTED_FILES });
const networkLines = (p: string) => p.split("\n").filter((l) => l.startsWith("(allow network") || l.startsWith("(deny network"));

test("SBPL strings escape quotes and refuse control characters", () => {
  assert.equal(sbplString('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => sbplString("a\nb"));
});

test("online profile: exec of Codex, its code-mode host and the relay, nothing else", () => {
  const p = online();
  assert.match(p, /^\(version 1\)\n\(deny default\)\n/);
  assert.ok(p.includes('(allow process-exec (literal "/v/bin/codex") (literal "/v/bin/codex-code-mode-host") (literal "/s/bin/cgc-relay"))'));
  assert.equal(p.match(/process-exec/g)?.length, 1);
  assert.doesNotMatch(p, /sandbox-exec|\/usr\/bin\/false|codex-path/);
});

test("online profile: reads, metadata literals, and writes only CODEX_HOME minus the files companiond writes", () => {
  const p = online();
  for (const r of ["/v", "/s/codex-home", "/s/empty-cwd"]) assert.ok(p.includes(`(subpath "${r}")`), r);
  assert.ok(p.includes('(literal "/s/bin/cgc-relay")'));
  assert.ok(p.includes('(literal "/h/Library/Keychains/login.keychain-db")'));
  assert.doesNotMatch(p, /\(subpath "\/h/); // nothing under home as a whole tree
  assert.match(p, /\(allow file-read-metadata [^\n]*\(literal "\/h\/Library\/Keychains"\)/);
  assert.match(p, /\(allow file-read-metadata [^\n]*\(literal "\/s"\)/); // ancestors of CODEX_HOME and App Support
  assert.doesNotMatch(p, /\(allow file-read-metadata\)/);
  assert.ok(p.includes('(allow file-write* (subpath "/s/codex-home") (literal "/dev/null"))\n(deny file-write* (literal "/s/codex-home/config.toml") (literal "/s/codex-home/companion-models.json"))'));
});

test("online profile: TCP 443 but not loopback, the DNS socket, the one relay socket; no network*", () => {
  assert.deepEqual(networkLines(online()), [
    '(allow network-outbound (remote tcp "*:443"))',
    '(deny network-outbound (remote tcp "localhost:*"))',
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    '(allow network-outbound (remote unix-socket (path-literal "/s/run/relay.sock")))',
  ]);
});

test("offline profile: no network, no keychain, no relay", () => {
  const p = buildCodexProfile({ install, codexHome: "/t", emptyCwd: "/t", supportDir: "/t", home: "/t", relay: null, protectedFiles: [] });
  assert.deepEqual(networkLines(p), []);
  assert.doesNotMatch(p, /login\.keychain-db|"\/t\/Library\/Keychains"|cgc-relay|unix-socket|deny file-write/);
  assert.doesNotMatch(p, /SecurityServer|securityd|trustd/); // M-1: no keychain or trust services offline
  assert.ok(p.includes('(allow process-exec (literal "/v/bin/codex") (literal "/v/bin/codex-code-mode-host"))'));
});

test("the sign-in profile is the production profile plus the callback bind and inbound rules, nothing else (I-9)", () => {
  const login = buildCodexProfile({ install, codexHome: paths.codexHome, emptyCwd: paths.emptyCwd, supportDir: paths.supportDir, home: "/h", relay, protectedFiles: CODEX_PROTECTED_FILES, login: true });
  const extra = login.split("\n").filter((l) => !online().split("\n").includes(l));
  assert.deepEqual(extra, ['(allow network-bind (local tcp "localhost:1455"))', '(allow network-inbound (local tcp "localhost:1455"))']);
  assert.doesNotMatch(online(), /network-bind|network-inbound/);
  assert.throws(() => buildCodexProfile({ install, codexHome: "/t", emptyCwd: "/t", supportDir: "/t", home: "/t", relay: null, protectedFiles: [], login: true }));
  const l = buildCodexLaunch({ install, paths, home: "/h", sandboxed: true, relay, login: true });
  assert.ok(l.args[1]?.includes("network-bind"));
  assert.deepEqual(buildCodexLaunch({ install, paths, home: "/h", sandboxed: true, relay, subcommand: ["debug", "prompt-input"] }).args.slice(2), ["/v/bin/codex", "debug", "prompt-input"]);
});

test("an install without the code-mode host is refused", () => {
  assert.throws(() => buildCodexProfile({ install: { ...install, codeModeHost: null }, codexHome: "/t", emptyCwd: "/t", supportDir: "/t", home: "/t", relay: null, protectedFiles: [] }));
});

test("the launch has a fresh env and runs under sandbox-exec with the relay endpoint", () => {
  process.env.OPENAI_API_KEY = "SYNTHETIC-not-a-key";
  try {
    const l = buildCodexLaunch({ install, paths, home: "/h", sandboxed: true, relay });
    assert.equal(l.command, "/usr/bin/sandbox-exec");
    assert.equal(l.args[0], "-p");
    assert.ok(l.args[1]?.includes('(path-literal "/s/run/relay.sock")'));
    assert.deepEqual(l.args.slice(2), ["/v/bin/codex", "app-server"]);
    assert.equal(l.cwd, "/s/empty-cwd");
    assert.deepEqual(Object.keys(l.env).sort(), ["CODEX_HOME", "CODEX_MANAGED_BY_NPM", "HOME", "LANG", "PATH", "TMPDIR"]);
    assert.equal(l.env.CODEX_HOME, "/s/codex-home");
    assert.equal(l.env.TMPDIR, "/s/codex-home/tmp");
    assert.throws(() => buildCodexLaunch({ install, paths, home: "/h", sandboxed: true }), /relay/);
    const u = buildCodexLaunch({ install, paths, home: "/h", sandboxed: false });
    assert.deepEqual([u.command, ...u.args], ["/v/bin/codex", "app-server"]);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("the offline launch runs codex in a scratch home under the offline profile", () => {
  const l = buildOfflineCodexLaunch(install, "/t");
  assert.equal(l.command, "/usr/bin/sandbox-exec");
  assert.deepEqual(l.args.slice(2), ["/v/bin/codex"]);
  assert.deepEqual(networkLines(l.args[1] ?? ""), []);
  assert.deepEqual(l.env, { CODEX_HOME: "/t", HOME: "/t", TMPDIR: "/t/tmp", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" });
  assert.equal(l.cwd, "/t");
});
