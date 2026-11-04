import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardReadFs, nodeReadFs, readJsonFile, RefusedPathError } from "../../src/claude/readFs.ts";
import { encodeCwd, isSafeId, toEpochMs } from "../../src/claude/paths.ts";
import { MARK, removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);

test("readRange returns the slice, fewer bytes at end of file, and the handle's identity", async () => {
  const dir = tempDir();
  const f = path.join(dir, "a.txt");
  fs.writeFileSync(f, `${MARK}-0123456789`);
  const off = MARK.length + 1;
  const r = await nodeReadFs.readRange(f, off, 4);
  assert.equal(r.buf.toString(), "0123");
  assert.equal(r.ino, fs.statSync(f).ino);
  assert.equal((await nodeReadFs.readRange(f, off + 8, 100)).buf.toString(), "89");
});

test("guardReadFs refuses .key files before touching them and reports the basename", async () => {
  const dir = tempDir();
  const key = path.join(dir, "123.key");
  fs.writeFileSync(key, MARK);
  const refused: string[] = [];
  const g = guardReadFs(nodeReadFs, (b) => refused.push(b));
  await assert.rejects(g.readRange(key, 0, 10), RefusedPathError);
  await assert.rejects(g.stat(path.join(dir, "X.KEY")), RefusedPathError);
  await assert.rejects(readJsonFile(g, key), RefusedPathError);
  assert.deepEqual(refused, ["123.key", "X.KEY", "123.key"]);
});

test("guardReadFs refuses a realpath that lands on a .key file", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "9.key"), MARK);
  fs.symlinkSync(path.join(dir, "9.key"), path.join(dir, "innocent.json"));
  await assert.rejects(guardReadFs(nodeReadFs).realpath(path.join(dir, "innocent.json")), RefusedPathError);
});

test("guarded stat and readRange on a symlink to a .key file are refused before the key is opened", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "9.key"), MARK);
  const link = path.join(dir, "9.json");
  fs.symlinkSync(path.join(dir, "9.key"), link);
  const opened: string[] = [];
  const statted: string[] = [];
  const spy = {
    ...nodeReadFs,
    stat: (p: string) => (statted.push(p), nodeReadFs.stat(p)),
    readRange: (p: string, pos: number, len: number) => (opened.push(p), nodeReadFs.readRange(p, pos, len)),
  };
  const refused: string[] = [];
  const g = guardReadFs(spy, (b) => refused.push(b));
  await assert.rejects(g.stat(link), RefusedPathError);
  await assert.rejects(g.readRange(link, 0, 10), RefusedPathError);
  await assert.rejects(readJsonFile(g, link), RefusedPathError);
  assert.deepEqual(opened, []);
  // stat opens nothing; it is called on the real target only, to tell a `.key` folder from a key file.
  assert.ok(statted.every((p) => p === path.join(fs.realpathSync(dir), "9.key")), statted.join(","));
  assert.deepEqual(refused, ["9.key", "9.key", "9.key"]);
});

test("a folder whose name ends in .key passes stat and realpath; readRange still refuses any .key name", async () => {
  const dir = tempDir();
  const folder = path.join(dir, "repo.key");
  fs.mkdirSync(folder);
  fs.symlinkSync(folder, path.join(dir, "link-to-folder"));
  const refused: string[] = [];
  const g = guardReadFs(nodeReadFs, (b) => refused.push(b));
  assert.ok((await g.stat(folder)).isDirectory());
  assert.equal(await g.realpath(folder), fs.realpathSync(folder));
  assert.ok((await g.stat(path.join(dir, "link-to-folder"))).isDirectory());
  await assert.rejects(g.readRange(folder, 0, 1), RefusedPathError);
  assert.deepEqual(refused, ["repo.key"]);
});

test("guarded stat and readRange follow an ordinary symlink and still report a missing file", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "real.json"), JSON.stringify({ m: MARK }));
  fs.symlinkSync(path.join(dir, "real.json"), path.join(dir, "link.json"));
  const g = guardReadFs(nodeReadFs);
  assert.ok((await g.stat(path.join(dir, "link.json"))).isFile());
  assert.deepEqual(await readJsonFile(g, path.join(dir, "link.json")), { m: MARK });
  await assert.rejects(g.stat(path.join(dir, "missing.json")), { code: "ENOENT" });
});

test("readJsonFile returns null for missing, non-JSON and oversized files", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "bad.json"), `{not json ${MARK}`);
  fs.writeFileSync(path.join(dir, "big.json"), JSON.stringify({ m: MARK, pad: "x".repeat(1024 * 1024) }));
  fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ m: MARK }));
  assert.equal(await readJsonFile(nodeReadFs, path.join(dir, "missing.json")), null);
  assert.equal(await readJsonFile(nodeReadFs, path.join(dir, "bad.json")), null);
  assert.equal(await readJsonFile(nodeReadFs, path.join(dir, "big.json")), null);
  assert.deepEqual(await readJsonFile(nodeReadFs, path.join(dir, "ok.json")), { m: MARK });
});

test("encodeCwd replaces every non-alphanumeric character", () => {
  assert.equal(encodeCwd("/tmp/a b/c.d_e"), "-tmp-a-b-c-d-e");
});

test("isSafeId accepts only plain ids", () => {
  assert.ok(isSafeId("cli-syn-1"));
  for (const bad of ["", "../x", "a/b", "a.b", 7, null, "x".repeat(129)]) assert.equal(isSafeId(bad), false);
});

test("toEpochMs reads ms, seconds, numeric strings and ISO strings", () => {
  assert.equal(toEpochMs(1793800000000), 1793800000000);
  assert.equal(toEpochMs(1793800000), 1793800000000);
  assert.equal(toEpochMs("1793800000000"), 1793800000000);
  assert.equal(toEpochMs("2026-11-04T10:00:00.000Z"), Date.UTC(2026, 10, 4, 10));
  assert.equal(toEpochMs("never"), null);
  assert.equal(toEpochMs(undefined), null);
});

test("lineBuffer.ts imports nothing", () => {
  const src = fileURLToPath(new URL("../../src/", import.meta.url));
  assert.doesNotMatch(fs.readFileSync(path.join(src, "lineBuffer.ts"), "utf8"), /^\s*import\s/m);
});
