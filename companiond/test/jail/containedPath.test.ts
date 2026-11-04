import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { lexicalResolve, openContained, relInside, type RaceHooks } from "../../src/jail/containedPath.ts";
import { put, removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);

function setup() {
  const root = tempDir("cgc-root-");
  const outsideDir = tempDir("cgc-out-");
  put(root, "sub/a.txt", "inside");
  put(root, ".git/config", "[core]");
  put(root, ".env", "x");
  const outsideFile = put(outsideDir, "a.txt", "outside");
  return { root, outsideDir, outsideFile };
}

function readVia(root: string, input: unknown, hooks: RaceHooks = {}): string | null {
  const o = openContained(root, input, "file", hooks);
  if (!o) return null;
  try {
    return fs.readFileSync(o.fd, "utf8");
  } finally {
    fs.closeSync(o.fd);
  }
}

test("relInside", () => {
  assert.equal(relInside("/r", "/r"), "");
  assert.equal(relInside("/r", "/r/a/b"), "a/b");
  assert.equal(relInside("/r", "/r/..a"), "..a");
  assert.equal(relInside("/r", "/rx"), null);
  assert.equal(relInside("/r", "/"), null);
});

test("reads a plain file inside root", () => {
  const { root } = setup();
  assert.match(readVia(root, "sub/a.txt") ?? "", /inside/);
  assert.match(readVia(root, path.join(root, "sub/a.txt")) ?? "", /inside/);
});

test("traversal and malformed input are refused", () => {
  const { root, outsideFile } = setup();
  const bad: unknown[] = [
    "../x", "sub/../../x", outsideFile, "/etc/hosts", "a\0b", "~/.ssh/config", "%2e%2e/x",
    "..\\..\\etc\\hosts", "x".repeat(5000), 42, null, undefined, {},
  ];
  for (const b of bad) assert.equal(readVia(root, b), null, String(b));
  assert.equal(lexicalResolve(root, "../x"), null);
});

test("a backslash is a literal name character", () => {
  const { root } = setup();
  put(root, "sub\\b.txt", "backslash");
  assert.match(readVia(root, "sub\\b.txt") ?? "", /backslash/);
});

test("file, directory and chained symlinks out of root are refused", () => {
  const { root, outsideDir, outsideFile } = setup();
  fs.symlinkSync(outsideFile, path.join(root, "link.txt"));
  fs.symlinkSync(outsideDir, path.join(root, "outdir"));
  fs.symlinkSync(outsideFile, path.join(root, "l2"));
  fs.symlinkSync(path.join(root, "l2"), path.join(root, "l1"));
  assert.equal(readVia(root, "link.txt"), null);
  assert.equal(readVia(root, "outdir/a.txt"), null);
  assert.equal(readVia(root, "l1"), null);
});

test("symlinks to a denied file or folder inside root are refused", () => {
  const { root } = setup();
  fs.symlinkSync(".env", path.join(root, "notes.txt"));
  fs.symlinkSync(".git", path.join(root, "docs"));
  assert.equal(readVia(root, "notes.txt"), null);
  assert.equal(readVia(root, "docs/config"), null);
});

test("hard links are refused", () => {
  const { root, outsideFile } = setup();
  fs.linkSync(outsideFile, path.join(root, "hl.txt"));
  assert.equal(readVia(root, "hl.txt"), null);
});

test("denied names are refused in mixed case and look-alikes", () => {
  const { root } = setup();
  put(root, "a.key", "k");
  for (const n of [".env", ".ENV", "SUB/../.Env", ".git/config", ".GIT/CONFIG", "a.Key"]) {
    assert.equal(readVia(root, n), null, n);
  }
});

test("race: a parent folder swapped for a symlink before the open is refused", () => {
  const { root, outsideDir } = setup();
  const hooks: RaceHooks = {
    beforeOpen: () => {
      fs.renameSync(path.join(root, "sub"), path.join(root, "sub.orig"));
      fs.symlinkSync(outsideDir, path.join(root, "sub"));
    },
  };
  assert.equal(readVia(root, "sub/a.txt", hooks), null);
});

test("race: the file swapped for a symlink before the open is refused", () => {
  const { root, outsideFile } = setup();
  const hooks: RaceHooks = {
    beforeOpen: () => {
      fs.renameSync(path.join(root, "sub/a.txt"), path.join(root, "sub/b.txt"));
      fs.symlinkSync(outsideFile, path.join(root, "sub/a.txt"));
    },
  };
  assert.equal(readVia(root, "sub/a.txt", hooks), null);
});

test("race: the file replaced after the open is refused", () => {
  const { root } = setup();
  const hooks: RaceHooks = {
    afterOpen: () => {
      fs.renameSync(path.join(root, "sub/a.txt"), path.join(root, "sub/moved.txt"));
      put(root, "sub/a.txt", "replacement");
    },
  };
  assert.equal(readVia(root, "sub/a.txt", hooks), null);
});

test("dir kind opens folders only, and file kind files only", () => {
  const { root } = setup();
  const d = openContained(root, "sub", "dir");
  assert.ok(d);
  fs.closeSync(d.fd);
  const r = openContained(root, ".", "dir");
  assert.ok(r);
  assert.equal(r.rel, "");
  fs.closeSync(r.fd);
  assert.equal(openContained(root, "sub/a.txt", "dir"), null);
  assert.equal(openContained(root, "sub", "file"), null);
  assert.equal(openContained(root, ".git", "dir"), null);
});
