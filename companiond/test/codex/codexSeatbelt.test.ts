import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppPaths } from "../../src/app/appPaths.ts";
import type { CodexInstall } from "../../src/codex/codexInstall.ts";
import { buildCodexLaunch, buildCodexProfile, DEFAULT_CODEX_PROFILE_OPTIONS, sbplString } from "../../src/codex/codexSeatbelt.ts";

const install: CodexInstall = {
  version: "0.166.0", vendorDir: "/v", binary: "/v/bin/codex", codeModeHost: "/v/bin/codex-code-mode-host", pathDir: "/v/codex-path", resourcesDir: "/v/codex-resources",
};
const paths: AppPaths = { supportDir: "/s", codexHome: "/s/codex-home", emptyCwd: "/s/empty-cwd", dbPath: "/s/companion.db" };

test("SBPL strings escape quotes and refuse control characters", () => {
  assert.equal(sbplString('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => sbplString("a\nb"));
});

test("the spec profile: deny default, own files only, writes only CODEX_HOME, network on", () => {
  const p = buildCodexProfile({ install, codexHome: paths.codexHome, emptyCwd: paths.emptyCwd, home: "/h", options: DEFAULT_CODEX_PROFILE_OPTIONS });
  assert.match(p, /^\(version 1\)\n\(deny default\)/);
  assert.match(p, /\(allow process-exec \(literal "\/v\/bin\/codex"\) \(literal "\/v\/bin\/codex-code-mode-host"\) \(literal "\/usr\/bin\/sandbox-exec"\) \(literal "\/usr\/bin\/false"\) \(subpath "\/v\/codex-path"\)\)/);
  for (const r of ["/v", "/s/codex-home", "/s/empty-cwd"]) assert.ok(p.includes(`(subpath "${r}")`), r);
  assert.match(p, /\(allow file-write\* \(subpath "\/s\/codex-home"\) \(literal "\/dev\/null"\)\)/);
  assert.match(p, /\(allow network\*\)/);
  assert.doesNotMatch(p, /"\/h/); // nothing under home except what options add
  assert.doesNotMatch(p, /\(allow file-read-metadata\)/);
  const k = buildCodexProfile({ install, codexHome: paths.codexHome, emptyCwd: paths.emptyCwd, home: "/h", options: { ...DEFAULT_CODEX_PROFILE_OPTIONS, keychainFileReads: true } });
  assert.ok(k.includes('(subpath "/h/Library/Keychains")'));
});

test("the launch has a fresh env and runs under sandbox-exec", () => {
  process.env.OPENAI_API_KEY = "SYNTHETIC-not-a-key";
  try {
    const l = buildCodexLaunch({ install, paths, home: "/h", sandboxed: true, extraArgs: ["-c", "x=1"] });
    assert.equal(l.command, "/usr/bin/sandbox-exec");
    assert.equal(l.args[0], "-p");
    assert.deepEqual(l.args.slice(2), ["/v/bin/codex", "app-server", "-c", "x=1"]);
    assert.equal(l.cwd, "/s/empty-cwd");
    assert.deepEqual(Object.keys(l.env).sort(), ["CODEX_HOME", "CODEX_MANAGED_BY_NPM", "HOME", "LANG", "PATH", "TMPDIR"]);
    assert.equal(l.env.CODEX_HOME, "/s/codex-home");
    assert.equal(l.env.TMPDIR, "/s/codex-home/tmp");
    assert.equal(l.env.PATH, "/v/codex-path:/usr/bin:/bin");
    const u = buildCodexLaunch({ install, paths, home: "/h", sandboxed: false });
    assert.deepEqual([u.command, ...u.args], ["/v/bin/codex", "app-server"]);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});
