import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GitError, RepoRefusedError, SafeGit, validateRepoDirs } from "../../src/git/safeGit.ts";
import {
  fixtureGit, makeRepo, makeWorktree, put, removeTempDirs, sentinelScript, slowGitPath, tempDir, testGitPath,
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
    SafeGit.open({ root: makeRepo(), gitPath: slowGitPath(), timeoutMs: 200 }),
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

test("a worktree added with relative paths opens", async () => {
  const main = makeRepo();
  const dir = path.join(tempDir("cgc-relwt-"), "rel");
  fixtureGit(main, ["worktree", "add", "-q", "--relative-paths", "-b", "rel", dir]);
  const wt = fs.realpathSync.native(dir);
  const back = fs.readFileSync(path.join(main, ".git", "worktrees", "rel", "gitdir"), "utf8").trim();
  assert.equal(path.isAbsolute(back), false, back); // the fixture really is relative
  const dirs = await (await open(wt)).repoDirs();
  assert.equal(dirs.gitDir, path.join(main, ".git", "worktrees", "rel"));
});

test("a worktree whose common dir is not named .git is refused", async () => {
  const main = makeRepo();
  const wt = makeWorktree(main);
  const store = path.join(main, "store");
  fs.renameSync(path.join(main, ".git"), store);
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(store, "worktrees", "wt")}\n`);
  await assert.rejects(open(wt), (e: unknown) => e instanceof RepoRefusedError && /outside/.test(e.reason));
});

test("a worktree gitdir file reading `.git` does not point back, even when cwd is the root", async () => {
  const main = makeRepo();
  const wt = makeWorktree(main);
  fs.writeFileSync(path.join(main, ".git", "worktrees", "wt", "gitdir"), ".git\n");
  const cwd = process.cwd();
  process.chdir(wt);
  try {
    await assert.rejects(open(wt), RepoRefusedError);
  } finally {
    process.chdir(cwd);
  }
});

test("a gitDir nested deeper than <commonDir>/worktrees/<name> is refused", () => {
  const main = makeRepo();
  const dotGit = path.join(main, ".git");
  const deep = path.join(dotGit, "worktrees", "a", "b");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "gitdir"), `${path.join(main, ".git")}\n`);
  assert.throws(
    () => validateRepoDirs({ toplevel: main, gitDir: deep, commonDir: dotGit }),
    (e: unknown) => e instanceof RepoRefusedError && /outside/.test(e.reason),
  );
});

test("a git binary that cannot start is a GitError, not 'not a git repository'", async () => {
  const missing = path.join(tempDir("cgc-nogit-"), "no-such-git");
  await assert.rejects(
    SafeGit.open({ root: makeRepo(), gitPath: missing }),
    (e: unknown) => e instanceof GitError && !(e instanceof RepoRefusedError) && /could not start/.test(e.message),
  );
});

test("the gate runs again before every git call", async () => {
  const repo = makeRepo();
  const git = await open(repo);
  fixtureGit(repo, ["config", "--local", "core.pager", "cat"]);
  await assert.rejects(git.repoDirs(), RepoRefusedError);
});

test("core.worktree is refused at open, in local and in worktree config", async () => {
  const elsewhere = makeRepo();
  const repo = makeRepo();
  fixtureGit(repo, ["config", "--local", "core.worktree", elsewhere]);
  await assert.rejects(open(repo), (e: unknown) => e instanceof RepoRefusedError && e.reason.includes("core.worktree"));
  const main = makeRepo();
  const wt = makeWorktree(main);
  fixtureGit(main, ["config", "--local", "extensions.worktreeConfig", "true"]);
  const git = await open(wt);
  fixtureGit(wt, ["config", "--worktree", "core.worktree", elsewhere]);
  await assert.rejects(git.status(), (e: unknown) => e instanceof RepoRefusedError && e.reason.includes("core.worktree"));
});

test("a .git swapped after open for a link to another repo is refused on the next call", async () => {
  const other = makeRepo({ "a.txt": "OTHER\n" });
  put(other, "a.txt", "OTHER_CHANGED\n");
  const repo = makeRepo();
  const git = await open(repo);
  fs.renameSync(path.join(repo, ".git"), path.join(repo, "moved-git"));
  fs.writeFileSync(path.join(repo, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
  await assert.rejects(git.status(), (e: unknown) => e instanceof RepoRefusedError && /changed after it was opened/.test(e.reason));
  await assert.rejects(git.diffNames(), RepoRefusedError);
  await assert.rejects(git.grep("OTHER"), RepoRefusedError);
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
