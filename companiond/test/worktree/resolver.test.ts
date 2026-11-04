import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { IsApproved } from "../../src/worktree/resolver.ts";
import { describeChange, resolveWorktree } from "../../src/worktree/resolver.ts";
import { nodeReadFs } from "../../src/claude/readFs.ts";
import { fixtureGit, makeRepo, MARK, removeTempDirs, repoWithWorktree, tempDir, testGitPath } from "../helpers/fixtures.ts";

after(removeTempDirs);

const all: IsApproved = () => true;
const deps = (isApproved: IsApproved = all) => ({ fs: nodeReadFs, gitPath: testGitPath(), isApproved });

test("resolves a linked worktree exactly, with branch and common dir", async () => {
  const { main, worktree } = repoWithWorktree();
  const r = await resolveWorktree({ transcriptCwd: worktree, recordCwd: main }, deps());
  assert.equal(r.kind, "resolved");
  if (r.kind !== "resolved") return;
  assert.equal(r.root, worktree);
  assert.equal(r.isLinkedWorktree, true);
  assert.equal(r.gitCommonDir, path.join(main, ".git"));
  assert.equal(r.branch, "feature-a");
  assert.equal(r.candidateSource, "transcript");
});

test("the main checkout resolves as not a linked worktree", async () => {
  const { main } = repoWithWorktree();
  const r = await resolveWorktree({ transcriptCwd: null, recordCwd: main }, deps());
  assert.ok(r.kind === "resolved" && !r.isLinkedWorktree && r.candidateSource === "desktop_record");
});

test("§12.2 desktop/transcript cwd disagreement: the transcript's repo wins", async () => {
  const a = makeRepo();
  const b = makeRepo();
  const r = await resolveWorktree({ transcriptCwd: a, recordCwd: b }, deps());
  assert.ok(r.kind === "resolved" && r.candidateSource === "transcript" && r.root === a, JSON.stringify(r));
});

test("§12.2 unapproved root → Unavailable with no fallback", async () => {
  const { main, worktree } = repoWithWorktree();
  const onlyMain: IsApproved = (root) => root === main;
  const r = await resolveWorktree({ transcriptCwd: worktree, recordCwd: main }, deps(onlyMain));
  assert.ok(r.kind === "unavailable" && r.reason === "not_approved" && r.root === worktree);
});

test("a repo whose config can run programs is repo_refused, with no fallback", async () => {
  const main = makeRepo();
  fixtureGit(main, ["config", "core.sshCommand", "/bin/false"]);
  const r = await resolveWorktree({ transcriptCwd: main, recordCwd: null }, deps());
  assert.ok(r.kind === "unavailable" && r.reason === "repo_refused", JSON.stringify(r));
  assert.equal(r.kind === "unavailable" && r.root, null);
});

test("a subfolder of a repo is never widened to the repo (no parent fallback)", async () => {
  const main = makeRepo();
  const sub = path.join(main, "sub");
  fs.mkdirSync(sub);
  const r = await resolveWorktree({ transcriptCwd: sub, recordCwd: null }, deps());
  assert.ok(r.kind === "unavailable" && r.reason === "not_worktree_root" && r.root === main);
});

test("a worktree whose .git link was removed is not resolved to the main checkout", async () => {
  const { main, worktree } = repoWithWorktree();
  const nested = path.join(main, "nested-wt");
  fixtureGit(main, ["worktree", "add", "-q", "-b", "nested", nested]);
  fs.rmSync(path.join(nested, ".git"));
  const r = await resolveWorktree({ transcriptCwd: nested, recordCwd: worktree }, deps());
  assert.ok(r.kind === "unavailable" && r.reason === "not_worktree_root" && r.root === main, JSON.stringify(r));
});

test("missing folder, file instead of folder, non-git folder, no cwd", async () => {
  const dir = tempDir();
  const file = path.join(dir, "f.txt");
  fs.writeFileSync(file, MARK);
  const reason = async (t: string | null) => {
    const r = await resolveWorktree({ transcriptCwd: t, recordCwd: null }, deps());
    return r.kind === "unavailable" ? r.reason : "resolved";
  };
  assert.equal(await reason(path.join(dir, "gone")), "path_missing");
  assert.equal(await reason(file), "not_directory");
  assert.equal(await reason(dir), "not_git");
  assert.equal(await reason(null), "no_cwd");
});

test("§12.2 worktree switch mid-session and move into another repo are never silent", async () => {
  const a = repoWithWorktree();
  const b = repoWithWorktree();
  const r1 = await resolveWorktree({ transcriptCwd: a.main, recordCwd: null }, deps());
  const r2 = await resolveWorktree({ transcriptCwd: a.worktree, recordCwd: null }, deps());
  const r3 = await resolveWorktree({ transcriptCwd: b.main, recordCwd: null }, deps((root) => root !== b.main));
  const c12 = describeChange(r1, r2);
  assert.ok(c12);
  assert.equal(c12.banner, `Claude is now in ${a.worktree} (feature-a)`);
  assert.equal(c12.contextNote, `Repository changed from ${a.main} to ${a.worktree}`);
  const c23 = describeChange(r2, r3);
  assert.ok(c23 && r3.kind === "unavailable" && r3.reason === "not_approved");
  assert.match(c23.banner, /unavailable/);
  assert.equal(c23.contextNote, `Repository changed from ${a.worktree} to ${b.main} — unavailable: This repository is not approved yet`);
  assert.equal(describeChange(r2, r2), null);
  assert.equal(describeChange(null, r1), null);
});

test("the same root changing state (approved → refused) is a change too", async () => {
  const main = makeRepo();
  const ok = await resolveWorktree({ transcriptCwd: main, recordCwd: null }, deps());
  fixtureGit(main, ["config", "core.sshCommand", "/bin/false"]);
  const refused = await resolveWorktree({ transcriptCwd: main, recordCwd: null }, deps());
  const c = describeChange(ok, refused);
  assert.ok(c);
  assert.match(c.contextNote, /is now unavailable$/);
});

test("detached HEAD reports detached@<sha>", async () => {
  const main = makeRepo();
  fixtureGit(main, ["checkout", "-q", "--detach"]);
  const r = await resolveWorktree({ transcriptCwd: main, recordCwd: null }, deps());
  assert.ok(r.kind === "resolved");
  assert.match(r.branch ?? "", /^detached@[0-9a-f]+$/);
});

test("a relative cwd is unavailable (never resolved against the daemon's cwd)", async () => {
  const r = await resolveWorktree({ transcriptCwd: "some/relative/dir", recordCwd: null }, deps());
  assert.ok(r.kind === "unavailable" && r.reason === "path_missing" && r.detail === "Path is not absolute", JSON.stringify(r));
});

test("an empty transcript cwd is treated as absent", async () => {
  const main = makeRepo();
  const r = await resolveWorktree({ transcriptCwd: "", recordCwd: main }, deps());
  assert.ok(r.kind === "resolved" && r.candidateSource === "desktop_record" && r.root === main, JSON.stringify(r));
});

test("a move into a non-root folder names the folder, never the parent repo", async () => {
  const { main, worktree } = repoWithWorktree();
  const nested = path.join(main, "nested-wt");
  fixtureGit(main, ["worktree", "add", "-q", "-b", "nested2", nested]);
  fs.rmSync(path.join(nested, ".git"));
  const r1 = await resolveWorktree({ transcriptCwd: worktree, recordCwd: null }, deps());
  const r2 = await resolveWorktree({ transcriptCwd: nested, recordCwd: null }, deps());
  const c = describeChange(r1, r2);
  assert.ok(c);
  assert.equal(c.to, nested);
  assert.match(c.contextNote, new RegExp(`^Repository changed from ${worktree} to ${nested} — unavailable: `));
  assert.ok(!c.contextNote.includes(`to ${main} `));
});
