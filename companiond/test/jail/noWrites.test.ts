// Spec §7.2: no write, rename, delete or non-git spawn code in anything that runs inside the jail.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(src, dir), { recursive: true, encoding: "utf8" }).map((f) => path.join(dir, f));
const files = [...walk("jail"), ...walk("git"), "lineBuffer.ts"].filter((f) => f.endsWith(".ts"));

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

// Allowlist, not a deny-list of write names: fs is reachable only through the one import form and
// only these members. The word `fs` anywhere else (aliasing, bracket access, destructuring, passing it
// along, even a comment) is a finding.
const FS_IMPORT = /^import fs from "node:fs";$/gm;
const FS_MEMBERS = new Set([
  "openSync", "readSync", "fstatSync", "lstatSync", "realpathSync", "readdirSync", "readFileSync", "closeSync", "constants",
]);
const MODULES = new Set(["node:fs", "node:path", "node:stream", "node:child_process"]); // plus relative .ts files
const BANNED: Array<[string, RegExp]> = [
  ["require", /\brequire\s*\(/],
  ["dynamic import", /\bimport\s*\(/],
  ["createRequire", /\bcreateRequire\b/],
  ["process internals", /\bprocess\s*(\.\s*(binding|_linkedBinding|dlopen)\b|\[)/],
  ["globalThis", /\bglobalThis\b/],
];

function scanSource(text: string): string[] {
  const found = FORBIDDEN.filter(([, re]) => re.test(text)).map(([what]) => what);
  for (const [what, re] of BANNED) if (re.test(text)) found.push(what);
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)) {
    const spec = m[1] ?? m[2] ?? "";
    if (!MODULES.has(spec) && !/^\.\.?\/[\w./-]+\.ts$/.test(spec)) found.push(`module ${spec}`);
    if (spec === "node:fs" && m[0].trim() !== 'import fs from "node:fs"') found.push("node:fs imported another way");
  }
  const rest = text.replace(FS_IMPORT, "");
  for (const m of rest.matchAll(/\bfs\b/g)) {
    const member = rest.slice((m.index ?? 0) + 2).match(/^\s*\.\s*([A-Za-z_$][\w$]*)/);
    if (!member || !FS_MEMBERS.has(member[1] ?? "")) found.push(`fs used as ${rest.slice(m.index, (m.index ?? 0) + 24)}`);
  }
  return found;
}

// Each shape below gets around a deny-list of fs write names; the allowlist scan must catch every one.
const BYPASSES: Record<string, string> = {
  "fs member outside the allowlist": `import fs from "node:fs";\nfs.opendirSync("x");\n`,
  "bracket access on fs": `import fs from "node:fs";\nfs["write" + "FileSync"]("x", "y");\n`,
  "aliasing fs": `import fs from "node:fs";\nconst f = fs;\nf.writeFileSync("x", "y");\n`,
  "passing fs along": `import fs from "node:fs";\nuse(fs);\n`,
  "destructuring from fs": `import fs from "node:fs";\nconst { writeFileSync: w } = fs;\nw("x", "y");\n`,
  "named import from node:fs": `import { openSync, writeSync as ws } from "node:fs";\n`,
  "namespace import of node:fs": `import * as nfs from "node:fs";\nnfs.writeFileSync("x", "y");\n`,
  "bare fs specifier": `import fs from "fs";\nfs.openSync("x", 0);\n`,
  "require": `const f = require("node:fs");\n`,
  "dynamic import": `const f = await import("node:fs");\n`,
  "createRequire": `import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\n`,
  "process.binding": `const b = process.binding("fs");\n`,
  "process.dlopen": `process.dlopen(module, "x.node");\n`,
  "module outside the allowlist": `import os from "node:os";\nimport { Worker } from "node:worker_threads";\n`,
};

const CLEAN = [
  `import fs from "node:fs";`,
  `import path from "node:path";`,
  `import type { Readable } from "node:stream";`,
  `import { foldName } from "./fold.ts";`,
  `const fd = fs.openSync(p, fs.constants.O_RDONLY);`,
  `const real = fs.realpathSync.native(p);`,
  `fs.closeSync(fd);`,
  `const d = fs.readdirSync(p, { withFileTypes: true });`,
].join("\n");

test("the allowlist scan catches every bypass shape", () => {
  for (const [what, text] of Object.entries(BYPASSES)) assert.notDeepEqual(scanSource(text), [], what);
});

test("the allowlist scan passes plain allowed code", () => {
  assert.deepEqual(scanSource(CLEAN), []);
});

test("the jail's files are scanned", () => {
  for (const f of ["jail/containedPath.ts", "jail/tools.ts", "git/safeGit.ts", "lineBuffer.ts"]) assert.ok(files.includes(f), f);
});

test("no write, network or dynamic-code calls inside the jail", () => {
  for (const f of files) {
    const text = fs.readFileSync(path.join(src, f), "utf8");
    assert.deepEqual(scanSource(text), [], f);
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
