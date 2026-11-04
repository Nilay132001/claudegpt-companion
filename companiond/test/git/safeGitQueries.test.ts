import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseGrepZ, parseStatusZ, SafeGit } from "../../src/git/safeGit.ts";
import { fixtureGit, makeRepo, makeWorktree, put, removeTempDirs, sentinelScript, tempDir, testGitPath } from "../helpers/fixtures.ts";

after(removeTempDirs);

const open = (root: string) => SafeGit.open({ root, gitPath: testGitPath() });

test("parseStatusZ", () => {
  assert.deepEqual(parseStatusZ("## main\0 M src/a.ts\0?? new file.txt\0"), {
    branch: "main",
    entries: [{ code: " M", path: "src/a.ts" }, { code: "??", path: "new file.txt" }],
  });
});

test("parseGrepZ accepts ':' or NUL after the line number", () => {
  assert.deepEqual(parseGrepZ("a.txt\x003:hello\nb c.txt\x0012\x00x:y\n"), [
    { path: "a.txt", line: 3, text: "hello" },
    { path: "b c.txt", line: 12, text: "x:y" },
  ]);
});

test("status lists modified and untracked files and leaves .git/index untouched", async () => {
  const repo = makeRepo({ "src/a.ts": "one\n" });
  put(repo, "src/a.ts", "two\n");
  put(repo, "notes/new.txt", "n\n");
  const index = path.join(repo, ".git", "index");
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(path.join(repo, "README.md"), future, future); // stat-dirty: git would like to refresh the index
  const before = fs.statSync(index).mtimeMs;
  const s = await (await open(repo)).status();
  assert.equal(fs.statSync(index).mtimeMs, before);
  assert.match(s.branch, /^main/);
  assert.deepEqual(
    s.entries.map((e) => `${e.code} ${e.path}`).sort(),
    [" M src/a.ts", "?? notes/new.txt"],
  );
});

test("diff covers working-tree changes and runs nothing for an empty path list", async () => {
  const repo = makeRepo({ "src/a.ts": "one\n" });
  put(repo, "src/a.ts", "two\n");
  const git = await open(repo);
  assert.deepEqual(await git.diffNames(), { names: ["src/a.ts"], truncated: false });
  assert.match((await git.diff(["src/a.ts"])).text, /\+two/);
  assert.deepEqual(await git.diff([]), { text: "", truncated: false });
});

test("diff works on a repo with no commits", async () => {
  const repo = tempDir("cgc-unborn-");
  fixtureGit(repo, ["init", "-q"]);
  put(repo, "a.txt", "first\n");
  fixtureGit(repo, ["add", "a.txt"]);
  const git = await open(repo);
  assert.deepEqual((await git.diffNames()).names, ["a.txt"]);
  assert.match((await git.diff(["a.txt"])).text, /\+first/);
});

test("output caps surface as truncated, for grep, diff and diffNames", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 20; i++) files[`src/some-long-file-name-number-${i}.ts`] = "one\n";
  const repo = makeRepo(files);
  for (const rel of Object.keys(files)) put(repo, rel, `${"CAP_MARKER line\n".repeat(50)}`);
  const git = await SafeGit.open({ root: repo, gitPath: testGitPath(), maxOutputBytes: 256 });
  assert.equal((await git.grep("CAP_MARKER")).truncated, true);
  assert.equal((await git.diff(Object.keys(files))).truncated, true);
  const names = await git.diffNames();
  assert.equal(names.truncated, true);
  for (const n of names.names) assert.ok(Object.hasOwn(files, n), n); // no partial name survives
});

test("the parent's git environment is not inherited", async () => {
  const { script, sentinel } = sentinelScript();
  const repo = makeRepo({ "src/a.ts": "one\n" });
  put(repo, "src/a.ts", "two\n");
  const keys = ["GIT_EXTERNAL_DIFF", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_DIR"];
  const saved = keys.map((k) => process.env[k]);
  Object.assign(process.env, {
    GIT_EXTERNAL_DIFF: script,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: script,
    GIT_DIR: path.join(tempDir("cgc-elsewhere-"), ".git"),
  });
  try {
    const git = await open(repo);
    assert.deepEqual((await git.status()).entries.map((e) => e.path), ["src/a.ts"]);
    assert.match((await git.diff(["src/a.ts"])).text, /\+two/);
    await git.grep("two");
  } finally {
    keys.forEach((k, i) => {
      const v = saved[i];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  }
  assert.equal(fs.existsSync(sentinel), false);
});

test("parseGrepZ keeps a newline inside a file name in the path", () => {
  assert.deepEqual(parseGrepZ("evil\nreal.txt\x001\x00NEEDLE spoof\nok.txt\x002:fine\n"), [
    { path: "evil\nreal.txt", line: 1, text: "NEEDLE spoof" },
    { path: "ok.txt", line: 2, text: "fine" },
  ]);
});

test("grep reports a file whose name contains a newline under that name", async () => {
  const repo = makeRepo({ "real.txt": "x\n" });
  put(repo, "evil\nreal.txt", "NEEDLE spoof\n");
  const hits = (await (await open(repo)).grep("NEEDLE")).hits;
  assert.deepEqual(hits.map((h) => h.path), ["evil\nreal.txt"]);
});

test("a modified tracked denied file is absent from status, diffNames and diff", async () => {
  const repo = makeRepo({ "config/credentials.json": "old\n", "src/a.ts": "one\n" });
  put(repo, "config/credentials.json", "DENIED_DIFF_MARKER\n");
  put(repo, "src/a.ts", "two\n");
  const git = await open(repo);
  assert.deepEqual((await git.status()).entries.map((e) => e.path), ["src/a.ts"]);
  assert.deepEqual((await git.diffNames()).names, ["src/a.ts"]);
  const text = (await git.diff(["src/a.ts", "config/credentials.json"])).text;
  assert.match(text, /\+two/);
  assert.doesNotMatch(text, /DENIED_DIFF_MARKER/);
});

test("diff refuses an empty path", async () => {
  const repo = makeRepo({ "src/a.ts": "one\n" });
  await assert.rejects((await open(repo)).diff([""]), /empty/);
});

test("status and grep drop a possibly partial last item when truncated", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 20; i++) files[`src/some-long-file-name-number-${i}.ts`] = "one\n";
  const repo = makeRepo({});
  for (const [rel, body] of Object.entries(files)) put(repo, rel, `CAP_MARKER ${body}`);
  const git = await SafeGit.open({ root: repo, gitPath: testGitPath(), maxOutputBytes: 300 });
  const s = await git.status();
  assert.equal(s.truncated, true);
  for (const e of s.entries) assert.ok(Object.hasOwn(files, e.path), e.path);
  const g = await git.grep("CAP_MARKER");
  assert.equal(g.truncated, true);
  for (const h of g.hits) {
    assert.ok(Object.hasOwn(files, h.path), h.path);
    assert.equal(h.text, "CAP_MARKER one");
  }
});

// Proves: the parent's hooks (.git/hooks and a core.hooksPath the gate allows) never fire on these queries.
// It cannot prove `core.hooksPath=/dev/null` is load-bearing: status/diff/grep with GIT_OPTIONAL_LOCKS=0 fire
// no hook in any git config the gate accepts, so removing that one flag leaves this test green.
test("hooks never run during status, diff and grep on a stat-dirty repo", async () => {
  const { script, sentinel } = sentinelScript();
  const repo = makeRepo({ "src/a.ts": "one\n" });
  fixtureGit(repo, ["config", "--local", "core.hooksPath", ".husky"]);
  for (const dir of [path.join(repo, ".git", "hooks"), path.join(repo, ".husky")]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const h of ["post-index-change", "pre-commit", "post-checkout", "reference-transaction", "fsmonitor-watchman"]) {
      fs.copyFileSync(script, path.join(dir, h));
      fs.chmodSync(path.join(dir, h), 0o755);
    }
  }
  put(repo, "src/a.ts", "two\n");
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(path.join(repo, "README.md"), future, future);
  const git = await open(repo);
  await git.status();
  await git.diff((await git.diffNames()).names);
  await git.grep("two");
  assert.equal(fs.existsSync(sentinel), false);
});

test("status and diff never enter a submodule, whose config the gate never read", async () => {
  const { script, sentinel } = sentinelScript();
  const subSource = makeRepo({ "lib.ts": "one\n" });
  const repo = makeRepo();
  fixtureGit(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subSource, "sub"]);
  fixtureGit(repo, ["commit", "-q", "-m", "add submodule"]);
  const sub = path.join(repo, "sub");
  fixtureGit(sub, ["config", "--local", "core.pager", script]);
  fixtureGit(sub, ["config", "--local", "core.fsmonitor", script]);
  put(sub, "lib.ts", "changed inside the submodule\n");
  const git = await open(repo);
  const s = await git.status();
  assert.deepEqual(s.entries.filter((e) => e.path.startsWith("sub")), []);
  const names = await git.diffNames();
  assert.deepEqual(names.names.filter((n) => n.startsWith("sub")), []);
  await git.grep("changed");
  assert.equal(fs.existsSync(sentinel), false);
});

test("pathspec magic in a file name stays literal", async () => {
  const repo = makeRepo({ ":(glob)*.ts": "odd\n", "b.ts": "b\n" });
  put(repo, ":(glob)*.ts", "odder\n");
  put(repo, "b.ts", "bb\n");
  const text = (await (await open(repo)).diff([":(glob)*.ts"])).text;
  assert.match(text, /odder/);
  assert.doesNotMatch(text, /\+bb/);
});

test("grep finds untracked text and treats a leading dash as data", async () => {
  const { script, sentinel } = sentinelScript();
  const repo = makeRepo({ "flags.txt": "use --force here\n" });
  put(repo, "notes/new.txt", "UNTRACKED_MARKER\n");
  const git = await open(repo);
  assert.deepEqual((await git.grep("UNTRACKED_MARKER")).hits.map((h) => h.path), ["notes/new.txt"]);
  assert.deepEqual((await git.grep("--force")).hits.map((h) => h.path), ["flags.txt"]);
  assert.deepEqual((await git.grep(`--open-files-in-pager=${script}`)).hits, []);
  assert.equal(fs.existsSync(sentinel), false);
});

test("grep never reads denied files", async () => {
  const repo = makeRepo({ "config/credentials.json": "TRACKED_SECRET_MARKER\n" });
  put(repo, ".env", "ENV_ONLY_MARKER\n");
  put(repo, "sub/.ENV.local", "ENV_ONLY_MARKER\n");
  const git = await open(repo);
  assert.deepEqual((await git.grep("ENV_ONLY_MARKER")).hits, []);
  assert.deepEqual((await git.grep("TRACKED_SECRET_MARKER")).hits, []);
});

test("queries work in a linked worktree", async () => {
  const main = makeRepo({ "src/a.ts": "one\n" });
  const wt = makeWorktree(main);
  put(wt, "src/a.ts", "wt change\n");
  const git = await open(wt);
  assert.deepEqual((await git.status()).entries.map((e) => e.path), ["src/a.ts"]);
  assert.match((await git.diff(["src/a.ts"])).text, /wt change/);
});
