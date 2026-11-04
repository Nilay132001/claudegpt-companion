// Spec §7.2: no write, rename, delete or non-git spawn code in anything that runs inside the jail.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const files = [
  ...fs.readdirSync(path.join(src, "jail")).map((f) => path.join("jail", f)),
  ...fs.readdirSync(path.join(src, "git")).map((f) => path.join("git", f)),
  "lineBuffer.ts",
].filter((f) => f.endsWith(".ts"));

const WRITE_NAMES =
  "writeFile|appendFile|createWriteStream|rename|unlink|rm|rmdir|mkdir|mkdtemp|copyFile|cp|symlink|link|" +
  "truncate|ftruncate|chmod|fchmod|lchmod|chown|fchown|lchown|utimes|futimes|lutimes|write|writev";
const FORBIDDEN: Array<[string, RegExp]> = [
  ["fs write call", new RegExp(`\\bfs\\.(${WRITE_NAMES})(Sync)?\\s*\\(`)],
  ["named fs write import", new RegExp(`import\\s*\\{[^}]*\\b(${WRITE_NAMES})(Sync)?\\b[^}]*\\}\\s*from\\s*"node:fs"`)],
  ["fs promises", /node:fs\/promises|\bfs\.promises\b/],
  ["write open flag", /\bO_(WRONLY|RDWR|CREAT|TRUNC|APPEND|EXLOCK|SHLOCK)\b/],
  ["string open flag", /openSync\([^)]*,\s*["'`]/],
  ["network module", /from\s+"node:(net|http|https|http2|dgram|dns|tls|worker_threads|cluster|vm|inspector)"/],
  ["fetch or websocket", /\bfetch\s*\(|\bWebSocket\b/],
  ["dynamic code", /\beval\s*\(|new\s+Function\s*\(/],
];

test("the jail's files are scanned", () => {
  for (const f of ["jail/containedPath.ts", "jail/tools.ts", "git/safeGit.ts", "lineBuffer.ts"]) assert.ok(files.includes(f), f);
});

test("no write, network or dynamic-code calls inside the jail", () => {
  for (const f of files) {
    const text = fs.readFileSync(path.join(src, f), "utf8");
    for (const [what, re] of FORBIDDEN) assert.doesNotMatch(text, re, `${f}: ${what}`);
  }
});

test("only safeGit.ts spawns, and only git without a shell", () => {
  for (const f of files) {
    const text = fs.readFileSync(path.join(src, f), "utf8");
    if (f === path.join("git", "safeGit.ts")) {
      assert.match(text, /import \{ spawn \} from "node:child_process";/);
      assert.doesNotMatch(text, /\b(exec|execSync|execFile|execFileSync|fork|spawnSync)\s*\(/);
      assert.doesNotMatch(text, /shell:\s*true/);
      assert.equal(text.match(/\bspawn\s*\(/g)?.length, 1);
    } else {
      assert.doesNotMatch(text, /node:child_process/, f);
    }
  }
});
