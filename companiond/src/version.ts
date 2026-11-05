// The companion's version (M7): one source, companiond/package.json. The app's Info.plist must match it
// (test/version.test.ts and scripts/build-app.sh check this).
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
if (typeof pkg.version !== "string") throw new Error("companiond/package.json has no version.");

export const COMPANION_VERSION: string = pkg.version;
