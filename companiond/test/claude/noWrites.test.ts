// Spec §6.1, §7.7: M3 code reads Claude's files only. Allowlist scan (not a deny-list of write names, which
// aliasing, bracket access and destructuring get past; see test/jail/noWrites.test.ts) over every .ts file
// that exists under these folders at test time, so later tasks are covered automatically.
// Comments are not stripped: a banned word in a comment is a finding too (stripping is itself bypassable).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const M3_DIRS = ["claude", "transcript", "worktree", "bridge"];
const walk = (dir: string): string[] =>
  fs.existsSync(path.join(src, dir))
    ? fs.readdirSync(path.join(src, dir), { recursive: true, encoding: "utf8" }).map((f) => path.join(dir, f))
    : [];
const files = M3_DIRS.flatMap(walk).filter((f) => f.endsWith(".ts"));

/** Modules a file may import, by file (posix-style relative path under src/). Relative `.ts` imports are always fine. */
const ANYWHERE = new Set(["node:path"]);
const ONLY_IN: Record<string, { file: string; exact: string }> = {
  "node:fs/promises": { file: "claude/readFs.ts", exact: 'import * as fsp from "node:fs/promises"' },
  "node:fs": { file: "bridge/watcher.ts", exact: 'import { watch } from "node:fs"' },
  "node:child_process": { file: "claude/processProbe.ts", exact: 'import { execFile } from "node:child_process"' },
};
const FSP_MEMBERS = new Set(["open", "readdir", "stat", "realpath"]);

const BANNED: Array<[string, RegExp]> = [
  ["require", /\brequire\s*\(/],
  ["dynamic import", /\bimport\s*\(/],
  ["createRequire", /\bcreateRequire\b/],
  ["process internals", /\bprocess\s*(\.\s*(binding|_linkedBinding|dlopen)\b|\[)/],
  ["_linkedBinding or dlopen", /\b(_linkedBinding|dlopen)\b/],
  ["globalThis", /\bglobalThis\b/],
  ["eval", /\beval\s*\(/],
  ["new Function", /\bnew\s+Function\s*\(/],
  ["fetch", /\bfetch\s*\(/],
  ["WebSocket", /\bWebSocket\b/],
];

function scanSource(file: string, text: string): string[] {
  const f = file.split(path.sep).join("/");
  const found: string[] = [];
  for (const [what, re] of BANNED) if (re.test(text)) found.push(what);

  // Imports: every `import ... from "x"`, `export ... from "x"` and bare `import "x"`.
  let rest = text;
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)) {
    const spec = m[1] ?? m[2] ?? "";
    const rule = ONLY_IN[spec];
    if (ANYWHERE.has(spec) || /^\.\.?\/[\w./-]+\.ts$/.test(spec)) continue;
    if (!rule) found.push(`module ${spec}`);
    else if (rule.file !== f) found.push(`module ${spec} outside ${rule.file}`);
    else if (m[0].trim() !== rule.exact) found.push(`${spec} imported another way`);
    else rest = rest.replace(m[0], "");
  }

  if (f === "claude/readFs.ts") {
    // The binding is reachable only as fsp.<member> with a read-only member; open only ever with "r".
    for (const m of rest.matchAll(/\bfsp\b/g)) {
      const member = rest.slice((m.index ?? 0) + 3).match(/^\s*\.\s*([A-Za-z_$][\w$]*)/);
      if (!member || !FSP_MEMBERS.has(member[1] ?? "")) found.push(`fsp used as ${rest.slice(m.index, (m.index ?? 0) + 24)}`);
    }
    const opens = rest.match(/\bfsp\s*\.\s*open\b/g)?.length ?? 0;
    const readOnlyOpens = rest.match(/\bfsp\.open\(\s*[\w.]+\s*,\s*"r"\s*\)/g)?.length ?? 0;
    if (opens !== readOnlyOpens) found.push("fsp.open other than open(path, \"r\")");
  }
  if (f === "claude/processProbe.ts") {
    // Only process.env and process.kill(pid, 0) (existence probe).
    for (const m of rest.matchAll(/\bprocess\b/g)) {
      const tail = rest.slice((m.index ?? 0) + 7);
      if (/^\s*\.\s*env\b/.test(tail)) continue;
      const kill = tail.match(/^\s*\.\s*kill\s*\(([^)]*)\)/);
      if (kill && /^[^,]+,\s*0\s*$/.test(kill[1] ?? "")) continue;
      found.push(`process used as ${rest.slice(m.index, (m.index ?? 0) + 24)}`);
    }
  }
  return found;
}

// Each shape below must be flagged: aliasing, destructuring, bracket access, wrong module or wrong file.
const BYPASSES: Array<[string, string, string]> = [
  ["fsp write member", "claude/readFs.ts", `import * as fsp from "node:fs/promises";\nfsp.writeFile("x", "y");\n`],
  ["fsp bracket access", "claude/readFs.ts", `import * as fsp from "node:fs/promises";\nfsp["write" + "File"]("x", "y");\n`],
  ["fsp aliasing", "claude/readFs.ts", `import * as fsp from "node:fs/promises";\nconst f = fsp;\nf.writeFile("x", "y");\n`],
  ["fsp passed along", "claude/readFs.ts", `import * as fsp from "node:fs/promises";\nuse(fsp);\n`],
  ["fsp destructured", "claude/readFs.ts", `import * as fsp from "node:fs/promises";\nconst { rm } = fsp;\n`],
  ["fsp.open aliased", "claude/readFs.ts", `import * as fsp from "node:fs/promises";\nconst o = fsp.open;\no("x", "w");\n`],
  ["fsp.open write flag", "claude/readFs.ts", `import * as fsp from "node:fs/promises";\nawait fsp.open(file, "w");\n`],
  ["fsp named import", "claude/readFs.ts", `import { open, writeFile as w } from "node:fs/promises";\n`],
  ["fsp default import", "claude/readFs.ts", `import fsp from "node:fs/promises";\n`],
  ["fs/promises in another file", "claude/paths.ts", `import * as fsp from "node:fs/promises";\nfsp.stat("x");\n`],
  ["node:fs in another file", "claude/readFs.ts", `import fs from "node:fs";\nfs.openSync("x", 0);\n`],
  ["bare fs specifier", "claude/paths.ts", `import fs from "fs";\n`],
  ["namespace import of node:fs", "bridge/index.ts", `import * as nfs from "node:fs";\n`],
  ["watcher imports more than watch", "bridge/watcher.ts", `import { watch, writeFileSync } from "node:fs";\n`],
  ["watcher default import", "bridge/watcher.ts", `import fs from "node:fs";\nfs.watch("x");\n`],
  ["child_process in another file", "claude/readFs.ts", `import { execFile } from "node:child_process";\n`],
  ["probe imports spawn", "claude/processProbe.ts", `import { spawn } from "node:child_process";\n`],
  ["probe imports exec as well", "claude/processProbe.ts", `import { execFile, exec } from "node:child_process";\n`],
  ["probe: real kill signal", "claude/processProbe.ts", `import { execFile } from "node:child_process";\nprocess.kill(pid, "SIGKILL");\n`],
  ["probe: kill without signal 0", "claude/processProbe.ts", `import { execFile } from "node:child_process";\nprocess.kill(pid);\n`],
  ["probe: process.exit", "claude/processProbe.ts", `import { execFile } from "node:child_process";\nprocess.exit(1);\n`],
  ["probe: aliasing process", "claude/processProbe.ts", `import { execFile } from "node:child_process";\nconst p = process;\n`],
  ["net", "bridge/x.ts", `import net from "node:net";\n`],
  ["http", "bridge/x.ts", `import http from "node:http";\n`],
  ["https", "bridge/x.ts", `import https from "node:https";\n`],
  ["http2", "bridge/x.ts", `import http2 from "node:http2";\n`],
  ["dgram", "bridge/x.ts", `import dgram from "node:dgram";\n`],
  ["dns", "bridge/x.ts", `import dns from "node:dns";\n`],
  ["tls", "bridge/x.ts", `import tls from "node:tls";\n`],
  ["worker_threads", "bridge/x.ts", `import { Worker } from "node:worker_threads";\n`],
  ["cluster", "bridge/x.ts", `import cluster from "node:cluster";\n`],
  ["vm", "bridge/x.ts", `import vm from "node:vm";\n`],
  ["inspector", "bridge/x.ts", `import inspector from "node:inspector";\n`],
  ["os (not allowlisted)", "bridge/x.ts", `import os from "node:os";\n`],
  ["bare import", "bridge/x.ts", `import "node:net";\n`],
  ["re-export from net", "bridge/x.ts", `export * from "node:net";\n`],
  ["require", "claude/paths.ts", `const f = require("node:fs");\n`],
  ["dynamic import", "claude/paths.ts", `const f = await import("node:fs");\n`],
  ["createRequire", "claude/paths.ts", `import { createRequire } from "node:module";\n`],
  ["process.binding", "claude/paths.ts", `const b = process.binding("fs");\n`],
  ["process._linkedBinding", "claude/paths.ts", `const b = process._linkedBinding("fs");\n`],
  ["process bracket access", "claude/paths.ts", `const b = process["binding"]("fs");\n`],
  ["process.dlopen", "claude/paths.ts", `process.dlopen(module, "x.node");\n`],
  ["globalThis", "claude/paths.ts", `const g = globalThis;\n`],
  ["eval", "claude/paths.ts", `eval("1");\n`],
  ["new Function", "claude/paths.ts", `new Function("return 1")();\n`],
  ["fetch", "claude/paths.ts", `await fetch("http://x");\n`],
  ["WebSocket", "claude/paths.ts", `new WebSocket("ws://x");\n`],
];

const CLEAN: Array<[string, string]> = [
  [
    "claude/readFs.ts",
    [
      `import * as fsp from "node:fs/promises";`,
      `import path from "node:path";`,
      `import { RefusedPathError } from "./other.ts";`,
      `const a = (d) => fsp.readdir(d);`,
      `const b = (p) => fsp.stat(p);`,
      `const c = (p) => fsp.realpath(p);`,
      `const fh = await fsp.open(file, "r");`,
      `await fh.read(buf, 0, 1, 0);`,
    ].join("\n"),
  ],
  ["bridge/watcher.ts", `import { watch } from "node:fs";\nimport path from "node:path";\nconst w = watch(dir);\n`],
  [
    "claude/processProbe.ts",
    `import { execFile } from "node:child_process";\nconst e = process.env;\nprocess.kill(pid, 0);\nexecFile("/bin/ps", []);\n`,
  ],
  ["transcript/x.ts", `import path from "node:path";\nimport type { ReadFs } from "../claude/readFs.ts";\nimport { SafeGit } from "../git/safeGit.ts";\n`],
];

test("the allowlist scan catches every bypass shape", () => {
  for (const [what, file, text] of BYPASSES) assert.notDeepEqual(scanSource(file, text), [], what);
});

test("the allowlist scan passes plain allowed code", () => {
  for (const [file, text] of CLEAN) assert.deepEqual(scanSource(file, text), [], file);
});

test("the M3 folders are scanned", () => {
  for (const f of ["claude/readFs.ts", "claude/paths.ts"]) assert.ok(files.includes(f), f);
});

test("M3 code imports only allowlisted modules and has no write, network, socket or dynamic-code use", () => {
  for (const f of files) assert.deepEqual(scanSource(f, fs.readFileSync(path.join(src, f), "utf8")), [], f);
});

test("M3 code never names messagingSocketPath", () => {
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(src, f), "utf8"), /messagingSocketPath/, f);
});
