// The production wiring, without starting Codex: the relay is built with the toolchain's developer folder, the
// acceptor listens on its Unix socket, and the host is left stopped. No network listener, no Codex process.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ensureAppDirs, type AppPaths } from "../../src/app/appPaths.ts";
import { createCompanionCodex } from "../../src/codex/companionCodex.ts";
import { discoverToolchain } from "../../src/launch/toolchain.ts";
import { relayPaths, RelaySetupError } from "../../src/relay/relayPaths.ts";
import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);
const mac = process.platform !== "darwin" ? "macOS only (xcrun clang, Codex install)" : false;
/** Short paths: the relay socket must fit sun_path. */
function shortPaths(): AppPaths {
  const base = tempDir("cgc-cc-");
  return ensureAppDirs({ supportDir: base, codexHome: path.join(base, "h"), emptyCwd: path.join(base, "e"), dbPath: path.join(base, "db") });
}

test("createCompanionCodex builds the relay, starts the acceptor and leaves the host stopped", { skip: mac }, async () => {
  const paths = shortPaths();
  const cc = await createCompanionCodex({ paths });
  const rp = relayPaths(paths.supportDir);
  try {
    assert.equal(cc.host.state().state, "stopped");
    assert.equal(cc.acceptor.healthy(), true);
    assert.equal(fs.statSync(rp.binary).mode & 0o777, 0o500);
    assert.ok(fs.lstatSync(rp.socket).isSocket());
  } finally {
    await cc.close();
  }
  assert.equal(fs.existsSync(rp.socket), false, "close() removes the socket");
});

test("the relay is built with the toolchain's developer folder (a bad one fails the build)", { skip: mac }, async () => {
  const paths = shortPaths();
  const tc = { ...discoverToolchain(), developerDir: path.join(paths.supportDir, "no-developer-dir") };
  await assert.rejects(createCompanionCodex({ paths, toolchain: tc }), RelaySetupError);
  assert.equal(fs.existsSync(relayPaths(paths.supportDir).socket), false, "nothing listens after a failed build");
});
