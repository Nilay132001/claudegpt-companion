import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ApprovalRefusedError, Privacy, safeGitInspector, type RepoInspector } from "../../src/privacy/privacy.ts";
import { Store } from "../../src/store/store.ts";
import { fixtureGit, makeRepo, makeWorktree, removeTempDirs, tempDir, testGitPath } from "../helpers/fixtures.ts";

after(removeTempDirs);

const fakeInspector = (dirs: Record<string, { toplevel: string; gitDir: string; commonDir: string }>): RepoInspector => ({
  inspect: async (d) => {
    const hit = dirs[d];
    if (!hit) throw new Error("not a repo");
    return hit;
  },
});
const refusal = async (p: Promise<unknown>, reason: string) =>
  assert.rejects(p, (e: unknown) => e instanceof ApprovalRefusedError && e.reason === reason);

test("exact match only; worktrees only by common dir when asked", async () => {
  const home = tempDir();
  const main = makeRepo();
  const wt = makeWorktree(main, "feature-a");
  const p = new Privacy(Store.memory(), safeGitInspector(testGitPath()), home, () => 1);
  const a = await p.approve(main, false);
  assert.equal(a.root, main);
  assert.equal(p.isApproved(main, a.commonDir), true);
  assert.equal(p.isApproved(wt, a.commonDir), false);
  assert.equal(p.isApproved(path.join(main, "sub"), a.commonDir), false);
  await p.approve(main, true);
  assert.equal(p.isApproved(wt, a.commonDir), true);
  assert.equal(p.isApproved(makeRepo(), "/elsewhere/.git"), false);
  assert.equal(p.revoke(main), true);
  assert.equal(p.isApproved(main, a.commonDir), false);
});

test("approving a linked worktree with its worktrees covers the main checkout; a symlink stores the real path", async () => {
  const main = makeRepo();
  const wt = makeWorktree(main, "feature-b");
  const p = new Privacy(Store.memory(), safeGitInspector(testGitPath()), tempDir(), () => 1);
  const a = await p.approve(wt, true);
  assert.equal(a.root, wt);
  assert.equal(p.isApproved(wt, a.commonDir), true);
  assert.equal(p.isApproved(main, a.commonDir), true);
  const link = path.join(tempDir(), "link-to-repo");
  fs.symlinkSync(main, link);
  const b = await p.approve(link, false);
  assert.equal(b.root, main);
  assert.ok(p.approvals().some((x) => x.root === main));
  assert.ok(!p.approvals().some((x) => x.root === link));
});

test("a worktree at home, / or above home is not approved through its common dir", async () => {
  const home = tempDir();
  const repo = tempDir();
  const common = `${repo}/.git`;
  const p = new Privacy(Store.memory(), fakeInspector({ [repo]: { toplevel: repo, gitDir: common, commonDir: common } }), home);
  await p.approve(repo, true);
  assert.equal(p.isApproved(repo, common), true);
  assert.equal(p.isApproved(home, common), false);
  assert.equal(p.isApproved(path.dirname(home), common), false);
  assert.equal(p.isApproved("/", common), false);
});

test("home, /, folders above home, relative and missing paths are refused", async () => {
  const home = tempDir();
  const p = new Privacy(Store.memory(), fakeInspector({}), home);
  await refusal(p.approve(home, false), "home_or_root");
  await refusal(p.approve(path.dirname(home), false), "home_or_root");
  await refusal(p.approve("/", false), "home_or_root");
  await refusal(p.approve("relative/dir", false), "not_absolute");
  await refusal(p.approve(path.join(home, "missing"), false), "missing");
});

test("a sub-folder or a non-git folder is refused", async () => {
  const d = tempDir();
  fs.mkdirSync(path.join(d, "sub"));
  const p = new Privacy(Store.memory(), fakeInspector({ [path.join(d, "sub")]: { toplevel: d, gitDir: `${d}/.git`, commonDir: `${d}/.git` } }), tempDir());
  await refusal(p.approve(path.join(d, "sub"), false), "not_toplevel");
  await refusal(p.approve(d, false), "repo_refused");
});

test("a repo whose config can run programs is refused with SafeGit's reason", async () => {
  const r = makeRepo();
  fixtureGit(r, ["config", "--local", "core.pager", "cat"]);
  const p = new Privacy(Store.memory(), safeGitInspector(testGitPath()), tempDir());
  await assert.rejects(p.approve(r, false), (e: unknown) => e instanceof ApprovalRefusedError && e.reason === "repo_refused" && /core\.pager/.test(e.message));
  await refusal(p.approve(tempDir(), false), "repo_refused"); // not a git folder (LocateError not_git)
});

test("sharing mode defaults to ask and persists", () => {
  const store = Store.memory();
  const p = new Privacy(store, fakeInspector({}), tempDir());
  assert.equal(p.sharingMode(), "ask");
  p.setSharingMode("automatic");
  assert.equal(new Privacy(store, fakeInspector({}), tempDir()).sharingMode(), "automatic");
});
