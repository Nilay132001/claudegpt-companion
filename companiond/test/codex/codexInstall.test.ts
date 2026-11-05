import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CodexInstallError, findCodex, PINNED_CODEX_VERSION, readVendorDir } from "../../src/codex/codexInstall.ts";
import { MARK, removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);

function vendor(meta: Record<string, unknown>, withBinary = true): string {
  const d = tempDir("cgc-vendor-");
  fs.writeFileSync(path.join(d, "codex-package.json"), JSON.stringify(meta));
  fs.mkdirSync(path.join(d, "bin"));
  fs.mkdirSync(path.join(d, "codex-path"));
  if (withBinary) fs.writeFileSync(path.join(d, "bin", "codex"), MARK);
  return d;
}

test("reads version, binary and folders from codex-package.json", () => {
  const d = vendor({ version: "0.166.0", entrypoint: "bin/codex", pathDir: "codex-path", resourcesDir: "codex-resources" });
  const i = readVendorDir(d);
  assert.equal(i.version, "0.166.0");
  assert.equal(i.binary, path.join(d, "bin", "codex"));
  assert.equal(i.pathDir, path.join(d, "codex-path"));
  assert.equal(i.resourcesDir, null); // missing folder
  assert.equal(i.codeModeHost, null);
});

test("refuses entrypoints outside the vendor folder and missing binaries", () => {
  assert.throws(() => readVendorDir(vendor({ version: "1", entrypoint: "../codex" })), CodexInstallError);
  assert.throws(() => readVendorDir(vendor({ version: "1", entrypoint: "bin/codex" }, false)), CodexInstallError);
  assert.throws(() => readVendorDir(vendor({ entrypoint: "bin/codex" })), CodexInstallError);
});

test("the installed Codex is the pinned version", { skip: process.platform !== "darwin" && "macOS only" }, () => {
  const i = findCodex();
  assert.equal(i.version, PINNED_CODEX_VERSION);
  assert.ok(fs.statSync(i.binary).isFile());
});

test("a symlink inside the vendor folder may not lead out of it (M-7)", () => {
  const d = vendor({ version: "0.166.0", entrypoint: "bin/codex" }, false);
  const outside = tempDir("cgc-outside-");
  fs.writeFileSync(path.join(outside, "codex"), MARK);
  fs.symlinkSync(path.join(outside, "codex"), path.join(d, "bin", "codex"));
  assert.throws(() => readVendorDir(d), CodexInstallError);
});

test("the code-mode host may not be a symlink that leads out of the vendor folder (M-7)", () => {
  const d = vendor({ version: "0.166.0", entrypoint: "bin/codex" });
  const outside = tempDir("cgc-outside-");
  fs.writeFileSync(path.join(outside, "codex-code-mode-host"), MARK);
  fs.symlinkSync(path.join(outside, "codex-code-mode-host"), path.join(d, "bin", "codex-code-mode-host"));
  assert.throws(() => readVendorDir(d), CodexInstallError);
  fs.rmSync(path.join(d, "bin", "codex-code-mode-host"));
  fs.writeFileSync(path.join(d, "bin", "codex-code-mode-host"), MARK);
  assert.equal(readVendorDir(d).codeModeHost, path.join(d, "bin", "codex-code-mode-host"));
});
