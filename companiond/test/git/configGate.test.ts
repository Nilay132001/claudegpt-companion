import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeKeys, isProgramKey, isRepoShapeKey, parseConfigList, programKeys, repoShapeKeys,
} from "../../src/git/configGate.ts";

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
    // Program-valued keys whose last segment has no dot before the suffix.
    "core.alternaterefscommand", "gpg.ssh.defaultkeycommand", "uploadpack.packobjectshook", "sendemail.sendmailcmd",
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

test("describeKeys keeps only safe characters from attacker-chosen key text", () => {
  // Subsection names come from the repo's config: control chars, newlines, quotes, spaces, bidi marks.
  assert.equal(describeKeys(["filter.a\u0007b\u001b[31m.clean"]), "filter.a?b??31m.clean");
  assert.equal(describeKeys(["filter.line1\nline2\r.clean"]), "filter.line1?line2?.clean");
  assert.equal(describeKeys(["filter.‮\"x y\".clean"]), "filter.??x?y?.clean");
  // Astral-plane text: each code point becomes one "?", and the cap counts code points.
  const astral = describeKeys([`filter.${"\u{1F600}".repeat(200)}.clean`]);
  assert.equal(astral, `filter.${"?".repeat(72)}…`);
  assert.equal([...astral].length, 80);
  for (const s of [astral, describeKeys(["a\u0000b.helper"])]) assert.match(s, /^[\w.:*@/?<>, -]*…?$/);
});

test("core.worktree is a repo-shape key, not a program key", () => {
  assert.equal(isRepoShapeKey("core.worktree"), true);
  assert.equal(isRepoShapeKey("core.WorkTree"), true);
  assert.equal(isRepoShapeKey("extensions.worktreeconfig"), false);
  assert.deepEqual(repoShapeKeys([{ scope: "worktree", key: "core.worktree" }, { scope: "local", key: "core.bare" }]), ["core.worktree"]);
});
