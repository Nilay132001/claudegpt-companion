import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AppDirError, appPaths, ensureAppDirs } from "../../src/app/appPaths.ts";
import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);

test("everything lives under Application Support/ClaudeGPTCompanion", () => {
  const p = appPaths("/h");
  const base = "/h/Library/Application Support/ClaudeGPTCompanion";
  assert.deepEqual(p, {
    supportDir: base,
    codexHome: `${base}/codex-home`,
    emptyCwd: `${base}/empty-cwd`,
    dbPath: `${base}/companion.db`,
  });
});

test("ensureAppDirs makes 0700 folders and returns real paths", () => {
  const p = ensureAppDirs(appPaths(tempDir()));
  for (const d of [p.supportDir, p.codexHome, p.emptyCwd, path.join(p.codexHome, "tmp")]) {
    assert.equal(fs.statSync(d).mode & 0o777, 0o700, d);
    assert.equal(fs.realpathSync.native(d), d);
  }
  assert.equal(path.dirname(p.dbPath), p.supportDir);
  assert.deepEqual(ensureAppDirs(p), p); // idempotent
});

test("a non-empty companion folder is a security failure", () => {
  const p = ensureAppDirs(appPaths(tempDir()));
  fs.writeFileSync(path.join(p.emptyCwd, "AGENTS.md"), "SYNTHETIC FIXTURE\n");
  assert.throws(() => ensureAppDirs(p), AppDirError);
});
