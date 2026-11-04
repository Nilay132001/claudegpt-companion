// Runs in companiond (outside the jail): finds what the jail needs to exec and read.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Toolchain {
  nodePath: string;
  nodeReadDirs: string[];
  nodeReadFiles: string[];
  // Symlinks dyld steps through to reach Node's libraries (metadata-only literals in the profile).
  metadataPaths: string[];
  gitPath: string;
  developerDir: string | null;
  codeDir: string;
  serverEntry: string;
}

export interface NodeReads {
  dirs: string[];
  files: string[];
}

const SYSTEM_PREFIXES = ["/usr/lib/", "/System/"];
const NEVER_WHOLE = [
  "/", "/Users", "/Volumes", "/private", "/private/var", "/private/var/folders", "/private/tmp", "/var", "/tmp",
  "/opt", "/usr/local", "/opt/homebrew", "/opt/local", "/Library", "/Applications",
];

// A folder the jail must never be able to read as a whole.
export function isTooBroad(p: string): boolean {
  const norm = path.resolve(p);
  const home = os.homedir();
  return NEVER_WHOLE.includes(norm) || norm === home || home.startsWith(`${norm}/`);
}

// The Node prefix (…/bin/node → …) plus, for each loaded non-system library, its realpath's grandparent
// (Homebrew: …/Cellar/<formula>/<version>). A folder that is too broad (for example /usr/local for the
// official installer) becomes a literal rule for that one file instead. Missing libraries are skipped.
export function nodeReadPaths(nodePath: string, sharedObjects: readonly string[]): NodeReads {
  const dirs = new Set<string>();
  const files = new Set<string>();
  const add = (file: string) => {
    const dir = path.dirname(path.dirname(file));
    if (isTooBroad(dir)) files.add(file);
    else dirs.add(dir);
  };
  add(nodePath);
  for (const so of sharedObjects) {
    if (SYSTEM_PREFIXES.some((p) => so.startsWith(p)) || so === nodePath) continue;
    let real: string;
    try {
      real = fs.realpathSync.native(so);
    } catch {
      continue;
    }
    add(real);
  }
  return { dirs: [...dirs].sort(), files: [...files].sort() };
}

// Mach-O load commands that name another file dyld opens: LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB,
// LC_REEXPORT_DYLIB, LC_LAZY_LOAD_DYLIB, LC_LOAD_UPWARD_DYLIB, and LC_RPATH. All keep an lc_str offset at +8.
const PATH_LOAD_COMMANDS = new Set([0xc, 0x80000018, 0x8000001f, 0x20, 0x80000023, 0x8000001c]);
const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE: Record<string, number> = { arm64: 0x0100000c, x64: 0x01000007 };

function readAt(fd: number, offset: number, length: number): Buffer {
  const b = Buffer.alloc(length);
  const n = fs.readSync(fd, b, 0, length, offset);
  return b.subarray(0, n);
}

// The paths a Mach-O file asks dyld to load (install names and rpaths), as written in the file. These are
// the paths dyld walks, symlinks and all; `process.report` only gives the realpaths it ended up at.
// Anything unreadable or not a 64-bit Mach-O for this CPU gives [].
export function machOLoadPaths(file: string): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return [];
  }
  try {
    let base = 0;
    const head = readAt(fd, 0, 8);
    if (head.length < 8) return [];
    const fat = head.readUInt32BE(0);
    if (fat === 0xcafebabe || fat === 0xcafebabf) {
      const entry = fat === 0xcafebabe ? 20 : 32;
      const n = head.readUInt32BE(4);
      const table = readAt(fd, 8, n * entry);
      const want = CPU_TYPE[process.arch];
      let found = -1;
      for (let k = 0; k < n && (k + 1) * entry <= table.length; k++) {
        if (table.readUInt32BE(k * entry) !== want) continue;
        found = fat === 0xcafebabe ? table.readUInt32BE(k * entry + 8) : Number(table.readBigUInt64BE(k * entry + 8));
      }
      if (found < 0) return [];
      base = found;
    }
    const mh = readAt(fd, base, 32);
    if (mh.length < 32 || mh.readUInt32LE(0) !== MH_MAGIC_64) return [];
    const ncmds = mh.readUInt32LE(16);
    const cmds = readAt(fd, base + 32, mh.readUInt32LE(20));
    const out: string[] = [];
    let off = 0;
    for (let k = 0; k < ncmds && off + 8 <= cmds.length; k++) {
      const cmd = cmds.readUInt32LE(off);
      const size = cmds.readUInt32LE(off + 4);
      if (size < 8 || off + size > cmds.length) break;
      if (PATH_LOAD_COMMANDS.has(cmd) && size >= 12) {
        const str = cmds.subarray(off + cmds.readUInt32LE(off + 8), off + size);
        const end = str.indexOf(0);
        out.push(str.subarray(0, end < 0 ? str.length : end).toString("utf8"));
      }
      off += size;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

// Every symlink dyld steps through while resolving these absolute paths, followed hop by hop (a link to a
// link is recorded too). Only the symlinks themselves: the profile allows `file-read-metadata` on each as a
// literal, which lets dyld lstat/readlink it and nothing else. Folders too broad to name (for example
// /tmp → /private/tmp, /var) are left out: the profile already covers those system links. Missing paths stop
// the walk quietly.
export function symlinkMetadataPaths(paths: readonly string[]): string[] {
  const out = new Set<string>();
  const walk = (p: string, depth: number): void => {
    if (depth > 32 || !path.isAbsolute(p)) return;
    const parts = p.split("/").filter(Boolean);
    let cur = "/";
    for (let k = 0; k < parts.length; k++) {
      const next = path.join(cur, parts[k] as string);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(next);
      } catch {
        return;
      }
      if (st.isSymbolicLink()) {
        if (!isTooBroad(next)) out.add(next);
        let target: string;
        try {
          target = path.resolve(cur, fs.readlinkSync(next));
        } catch {
          return;
        }
        walk(path.join(target, ...parts.slice(k + 1)), depth + 1);
        return;
      }
      cur = next;
    }
  };
  for (const p of paths) walk(p, 0);
  return [...out].sort();
}

// The symlink hops on every absolute path dyld is told to load by Node and its non-system libraries.
export function nodeMetadataPaths(nodePath: string, sharedObjects: readonly string[]): string[] {
  const files = new Set([nodePath]);
  for (const so of sharedObjects) {
    if (SYSTEM_PREFIXES.some((p) => so.startsWith(p))) continue;
    try {
      files.add(fs.realpathSync.native(so));
    } catch {
      // skipped, as in nodeReadPaths
    }
  }
  const loads = [...files].flatMap(machOLoadPaths).filter((p) => p.startsWith("/") && !SYSTEM_PREFIXES.some((s) => p.startsWith(s)));
  return symlinkMetadataPaths(loads);
}

export function loadedSharedObjects(): string[] {
  const report = process.report.getReport() as unknown as { sharedObjects?: unknown };
  const list = report.sharedObjects;
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
}

export function discoverToolchain(): Toolchain {
  if (process.platform !== "darwin") throw new Error("companion-readonly runs under Seatbelt, which is macOS-only");
  const nodePath = fs.realpathSync.native(process.execPath);
  const developerDir = fs.realpathSync.native(execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" }).trim());
  const gitPath = fs.realpathSync.native(execFileSync("/usr/bin/xcrun", ["-f", "git"], { encoding: "utf8" }).trim());
  const codeDir = fs.realpathSync.native(fileURLToPath(new URL("../..", import.meta.url)));
  const shared = loadedSharedObjects();
  const reads = nodeReadPaths(nodePath, shared);
  return {
    nodePath,
    nodeReadDirs: reads.dirs,
    nodeReadFiles: reads.files,
    metadataPaths: nodeMetadataPaths(nodePath, shared),
    gitPath,
    developerDir,
    codeDir,
    serverEntry: path.join(codeDir, "src", "jail", "main.ts"),
  };
}
