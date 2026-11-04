import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GitError, RepoRefusedError, SafeGit } from "../../src/git/safeGit.ts";
import {
  fixtureGit, makeRepo, makeWorktree, put, removeTempDirs, sentinelScript, tempDir, testGitPath,
} from "../helpers/fixtures.ts";

after(removeTempDirs);

const open = (root: string) => SafeGit.open({ root, gitPath: testGitPath() });

test("a clean repo opens and reports its dirs", async () => {
  const repo = makeRepo();
  const git = await open(repo);
  assert.equal(git.root, repo);
  const dirs = await git.repoDirs();
  assert.equal(dirs.toplevel, repo);
  assert.equal(dirs.gitDir, path.join(repo, ".git"));
  assert.equal(dirs.commonDir, path.join(repo, ".git"));
});

test("a linked worktree reports the main repo's common dir", async () => {
  const main = makeRepo();
  const wt = makeWorktree(main);
  const dirs = await (await open(wt)).repoDirs();
  assert.equal(dirs.toplevel, wt);
  assert.equal(dirs.commonDir, path.join(main, ".git"));
  assert.equal(dirs.gitDir, path.join(main, ".git", "worktrees", "wt"));
});

test("the config parser matches real git output", async () => {
  const repo = makeRepo();
  fixtureGit(repo, ["config", "--local", "core.pager", "cat"]);
  await assert.rejects(open(repo), (e: unknown) => e instanceof RepoRefusedError && e.reason.includes("core.pager"));
});

for (const [key, attr] of [
  ["core.fsmonitor", null],
  ["diff.external", null],
  ["diff.x.textconv", "*.txt diff=x"],
  ["filter.x.clean", "*.txt filter=x"],
  ["core.pager", null],
  ["pager.status", null],
  ["core.sshCommand", null],
] as const) {
  test(`a repo with local ${key} is refused and nothing runs`, async () => {
    const { script, sentinel } = sentinelScript();
    const repo = makeRepo();
    if (attr) put(repo, ".gitattributes", `${attr}\n`);
    fixtureGit(repo, ["config", "--local", key, script]);
    await assert.rejects(open(repo), (e: unknown) => e instanceof RepoRefusedError && e.reason.includes(key.toLowerCase()));
    assert.equal(fs.existsSync(sentinel), false);
  });
}

test("include.path is refused without following the include", async () => {
  const { script, sentinel } = sentinelScript();
  const repo = makeRepo();
  const inc = path.join(tempDir("cgc-inc-"), "extra.cfg");
  fs.writeFileSync(inc, `[core]\n\tpager = ${script}\n`);
  fixtureGit(repo, ["config", "--local", "include.path", inc]);
  await assert.rejects(open(repo), (e: unknown) => e instanceof RepoRefusedError && e.reason.includes("include.path"));
  assert.equal(fs.existsSync(sentinel), false);
});

test("a local core.hooksPath (husky) is not a reason to refuse", async () => {
  const repo = makeRepo();
  fixtureGit(repo, ["config", "--local", "core.hooksPath", ".husky"]);
  await (await open(repo)).repoDirs();
});

test("a timeout is a GitError, not a refusal", async () => {
  await assert.rejects(
    SafeGit.open({ root: makeRepo(), gitPath: testGitPath(), timeoutMs: 1 }),
    (e: unknown) => e instanceof GitError && e.code === null && /timed out/.test(e.message),
  );
});

test("a hostile .git file pointing at another repo is refused", async () => {
  const other = makeRepo();
  const root = tempDir("cgc-hostile-");
  fs.writeFileSync(path.join(root, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
  await assert.rejects(open(root), (e: unknown) => e instanceof RepoRefusedError && /outside/.test(e.reason));
});

test("a .git file pointing at another repo's worktree is refused", async () => {
  const other = makeRepo();
  makeWorktree(other);
  const root = tempDir("cgc-hostile-wt-");
  fs.writeFileSync(path.join(root, ".git"), `gitdir: ${path.join(other, ".git", "worktrees", "wt")}\n`);
  await assert.rejects(open(root), (e: unknown) => e instanceof RepoRefusedError && /point back/.test(e.reason));
});

test("the gate runs again before every git call", async () => {
  const repo = makeRepo();
  const git = await open(repo);
  fixtureGit(repo, ["config", "--local", "core.pager", "cat"]);
  await assert.rejects(git.repoDirs(), RepoRefusedError);
});

test("worktree config is gated too", async () => {
  const { script, sentinel } = sentinelScript();
  const main = makeRepo();
  const wt = makeWorktree(main);
  fixtureGit(main, ["config", "--local", "extensions.worktreeConfig", "true"]);
  fixtureGit(wt, ["config", "--worktree", "core.pager", script]);
  await assert.rejects(open(wt), (e: unknown) => e instanceof RepoRefusedError && e.reason.includes("core.pager"));
  await open(main);
  assert.equal(fs.existsSync(sentinel), false);
});

test("a sub-folder, a non-repo and a missing folder are refused", async () => {
  const repo = makeRepo({ "sub/x.txt": "x" });
  await assert.rejects(open(path.join(repo, "sub")), RepoRefusedError);
  await assert.rejects(open(tempDir("cgc-plain-")), RepoRefusedError);
  await assert.rejects(open(path.join(repo, "missing")), RepoRefusedError);
});

test("a relative git path is rejected", async () => {
  await assert.rejects(SafeGit.open({ root: makeRepo(), gitPath: "git" }), /absolute/);
});
