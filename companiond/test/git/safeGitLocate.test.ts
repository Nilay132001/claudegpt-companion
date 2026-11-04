import { after, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { LocateError, SafeGit } from "../../src/git/safeGit.ts";
import { fixtureGit, makeRepo, makeWorktree, removeTempDirs, slowGitPath, tempDir, testGitPath } from "../helpers/fixtures.ts";

after(removeTempDirs);

const locate = (cwd: string) => SafeGit.locate({ gitPath: testGitPath(), cwd });
const kindOf = (kind: string) => (e: unknown) => e instanceof LocateError && e.kind === kind;

test("a sub-folder locates its toplevel", async () => {
  const repo = makeRepo({ "src/deep/a.ts": "x\n" });
  const dirs = await locate(path.join(repo, "src", "deep"));
  assert.deepEqual(dirs, { toplevel: repo, gitDir: path.join(repo, ".git"), commonDir: path.join(repo, ".git") });
});

test("a sub-folder of a linked worktree locates the worktree", async () => {
  const main = makeRepo({ "src/a.ts": "x\n" });
  const wt = makeWorktree(main);
  const dirs = await locate(path.join(wt, "src"));
  assert.equal(dirs.toplevel, wt);
  assert.equal(dirs.commonDir, path.join(main, ".git"));
});

test("not a repo, a missing folder, program-valued config", async () => {
  await assert.rejects(locate(tempDir("cgc-plain-")), kindOf("not_git"));
  await assert.rejects(locate(path.join(tempDir("cgc-plain-"), "missing")), kindOf("not_git"));
  const repo = makeRepo({ "sub/x.txt": "x\n" });
  fixtureGit(repo, ["config", "--local", "core.pager", "cat"]);
  await assert.rejects(
    locate(path.join(repo, "sub")),
    (e: unknown) => e instanceof LocateError && e.kind === "refused" && e.reason.includes("core.pager"),
  );
});

test("a timeout is git_failed", async () => {
  await assert.rejects(SafeGit.locate({ gitPath: slowGitPath(), cwd: makeRepo(), timeoutMs: 200 }), kindOf("git_failed"));
});

test("branch: named, detached, and no commits", async () => {
  const repo = makeRepo();
  const git = await SafeGit.open({ root: repo, gitPath: testGitPath() });
  assert.equal(await git.branch(), "main");
  fixtureGit(repo, ["checkout", "-q", "--detach"]);
  assert.match((await git.branch()) ?? "", /^detached@[0-9a-f]{7,}$/);
  const empty = tempDir("cgc-empty-");
  fixtureGit(empty, ["init", "-q"]);
  assert.equal(await (await SafeGit.open({ root: empty, gitPath: testGitPath() })).branch(), null);
  const wt = makeWorktree(repo, "feature");
  assert.equal(await (await SafeGit.open({ root: wt, gitPath: testGitPath() })).branch(), "feature");
});
