import { test } from "node:test";
import assert from "node:assert/strict";
import { describeKeys, isProgramKey, parseConfigList, programKeys } from "../../src/git/configGate.ts";

test("parses --null --show-scope output, including keys without a value", () => {
  const out = "local\0core.bare\nfalse\0local\0Filter.X.clean\nrun\0worktree\0core.pager\nless\0local\0flagonly\0";
  assert.deepEqual(parseConfigList(out), [
    { scope: "local", key: "core.bare" },
    { scope: "local", key: "filter.x.clean" },
    { scope: "worktree", key: "core.pager" },
    { scope: "local", key: "flagonly" },
  ]);
});

test("program-valued keys", () => {
  const yes = [
    "filter.lfs.clean", "filter.x.smudge", "diff.x.textconv", "diff.x.command", "diff.external",
    "core.fsmonitor", "core.pager", "core.sshcommand", "core.askpass", "core.gitproxy", "core.editor",
    "sequence.editor", "include.path", "includeif.gitdir:/x.path", "pager.status", "difftool.x.cmd",
    "gpg.program", "gpg.ssh.program", "credential.helper", "merge.x.driver",
  ];
  const no = ["core.bare", "core.hookspath", "core.autocrlf", "remote.origin.url", "user.name", "extensions.worktreeconfig"];
  for (const k of yes) assert.equal(isProgramKey(k), true, k);
  for (const k of no) assert.equal(isProgramKey(k), false, k);
});

test("programKeys returns the offending keys", () => {
  assert.deepEqual(
    programKeys([{ scope: "local", key: "core.bare" }, { scope: "worktree", key: "core.pager" }]),
    ["core.pager"],
  );
});

test("describeKeys caps the reason at 3 keys and 80 characters and hides URLs", () => {
  assert.equal(describeKeys(["a.b.command", "c.d.cmd", "e.textconv", "f.helper"]), "a.b.command, c.d.cmd, e.textconv and 1 more");
  assert.equal(describeKeys(["core.pager", "core.pager"]), "core.pager");
  assert.equal(
    describeKeys(["includeif.hasconfig:remote.*.url:https://host.example/org/**.path"]),
    "includeif.hasconfig:remote.*.url:<url>",
  );
  const long = describeKeys([`filter.${"x".repeat(200)}.clean`]);
  assert.ok(long.length <= 80, String(long.length));
  assert.ok(long.endsWith("…"));
});
