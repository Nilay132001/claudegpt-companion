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
  const reads = nodeReadPaths(nodePath, loadedSharedObjects());
  return {
    nodePath,
    nodeReadDirs: reads.dirs,
    nodeReadFiles: reads.files,
    gitPath,
    developerDir,
    codeDir,
    serverEntry: path.join(codeDir, "src", "jail", "main.ts"),
  };
}
