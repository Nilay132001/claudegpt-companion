import fs from "node:fs";
import path from "node:path";
import { isDeniedRelPath } from "./denyList.ts";

// One message for denied, missing, outside, symlinked, hard-linked and wrong-type paths (spec §7.2).
export const NOT_AVAILABLE = "Not available.";

export interface Lexical {
  abs: string;
  rel: string;
}

export interface Opened {
  fd: number;
  real: string;
  rel: string;
  stat: fs.Stats;
}

// Test seam: lets the race tests swap files at the two points that matter.
export interface RaceHooks {
  beforeOpen?: () => void;
  afterOpen?: () => void;
}

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;

export function relInside(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (rel === "") return "";
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return null;
  return rel;
}

// No filesystem call: containment and the deny-list run on the name alone.
export function lexicalResolve(root: string, input: unknown): Lexical | null {
  if (typeof input !== "string" || input.length > 4096 || input.includes("\0")) return null;
  const abs = path.resolve(root, input === "" ? "." : input);
  const rel = relInside(root, abs);
  if (rel === null || isDeniedRelPath(rel)) return null;
  return { abs, rel };
}

// Replaces F_GETPATH (spec §7.2, M2 ruling 1). nlink == 1 means the file has one name; a matching
// dev + ino at the real path means that name is the real path, which must be inside root and allowed.
// O_NOFOLLOW stops only a symlinked final component; the real-path check covers symlinked parents.
export function openContained(root: string, input: unknown, kind: "file" | "dir", hooks: RaceHooks = {}): Opened | null {
  const lex = lexicalResolve(root, input);
  if (!lex) return null;
  hooks.beforeOpen?.();
  let fd: number;
  try {
    fd = fs.openSync(lex.abs, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | (kind === "dir" ? O_DIRECTORY : 0));
  } catch {
    return null;
  }
  try {
    hooks.afterOpen?.();
    const stat = fs.fstatSync(fd);
    if (kind === "file" && (!stat.isFile() || stat.nlink !== 1)) throw new Error("type");
    if (kind === "dir" && !stat.isDirectory()) throw new Error("type");
    const real = fs.realpathSync.native(lex.abs);
    const rel = relInside(root, real);
    if (rel === null || isDeniedRelPath(rel)) throw new Error("outside");
    const now = fs.lstatSync(real);
    if (now.dev !== stat.dev || now.ino !== stat.ino) throw new Error("moved");
    return { fd, real, rel, stat };
  } catch {
    fs.closeSync(fd);
    return null;
  }
}
