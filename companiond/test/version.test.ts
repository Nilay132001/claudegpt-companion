import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { COMPANION_VERSION } from "../src/version.ts";

test("one version: companiond/package.json and both Info.plist version keys (M7)", () => {
  assert.match(COMPANION_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(COMPANION_VERSION, "0.7.0");
  const plist = fs.readFileSync(new URL("../../app/bundle/Info.plist", import.meta.url), "utf8");
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
    const m = new RegExp(`<key>${key}</key><string>([^<]*)</string>`).exec(plist);
    assert.equal(m?.[1], COMPANION_VERSION, key);
  }
});
