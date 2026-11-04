import fs from "node:fs";
import path from "node:path";
import { GitError, RepoRefusedError, type SafeGit } from "../git/safeGit.ts";
import { lexicalResolve, NOT_AVAILABLE, openContained } from "./containedPath.ts";
import { isDeniedName } from "./denyList.ts";

export const LIMITS = Object.freeze({
  readBytes: 256 * 1024,
  rangeLines: 2000,
  searchHits: 500,
  hitChars: 500,
  listEntries: 1000,
  diffPaths: 2000,
});

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface JailContext {
  root: string;
  git: SafeGit;
  redact: (text: string) => string;
}

const ok = (text: string): ToolResult => ({ text, isError: false });
const err = (text: string): ToolResult => ({ text, isError: true });

function intArg(v: unknown, dflt: number): number | null {
  if (v === undefined) return dflt;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

function readCapped(fd: number, cap: number): { buf: Buffer; truncated: boolean } {
  const buf = Buffer.alloc(cap + 1);
  let n = 0;
  while (n < buf.length) {
    const got = fs.readSync(fd, buf, n, buf.length - n, null);
    if (got === 0) break;
    n += got;
  }
  return { buf: buf.subarray(0, Math.min(n, cap)), truncated: n > cap };
}

// git reads files by name, so a hit or diff path must pass the same contained open as read_file
// (no symlink, no hard link, real path inside root and allowed) before its text is shown.
function containedOpens(root: string, rel: string, kind: "file" | "dir"): boolean {
  const o = openContained(root, rel, kind);
  if (!o) return false;
  fs.closeSync(o.fd);
  return true;
}

export function listDir(ctx: JailContext, args: Record<string, unknown>): ToolResult {
  const o = openContained(ctx.root, args.path ?? ".", "dir");
  if (!o) return err(NOT_AVAILABLE);
  try {
    const entries = fs.readdirSync(o.real, { withFileTypes: true });
    const again = fs.lstatSync(o.real);
    if (again.dev !== o.stat.dev || again.ino !== o.stat.ino) return err(NOT_AVAILABLE);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Every entry goes through the same contained open as read_file / a nested list_dir would use,
    // so a name that read_file would refuse (symlink, hard link, wrong type) is not listed.
    const shown: string[] = [];
    let more = false;
    for (const e of entries) {
      if (isDeniedName(e.name)) continue;
      const isDir = e.isDirectory();
      if (!isDir && !e.isFile()) continue;
      if (!containedOpens(ctx.root, path.join(o.rel, e.name), isDir ? "dir" : "file")) continue;
      if (shown.length >= LIMITS.listEntries) {
        more = true;
        break;
      }
      shown.push(isDir ? `${e.name}/` : e.name);
    }
    let text = shown.join("\n") || "(empty)";
    if (more) text += "\n… more entries not shown";
    return ok(ctx.redact(text));
  } catch {
    return err(NOT_AVAILABLE);
  } finally {
    fs.closeSync(o.fd);
  }
}

export function readFile(ctx: JailContext, args: Record<string, unknown>): ToolResult {
  if (typeof args.path !== "string") return err("path must be a string.");
  const start = intArg(args.start_line, 1);
  const endReq = intArg(args.end_line, Number.MAX_SAFE_INTEGER);
  if (start === null || endReq === null || endReq < start) {
    return err("start_line and end_line must be whole numbers, 1 or more, with end_line ≥ start_line.");
  }
  const o = openContained(ctx.root, args.path, "file");
  if (!o) return err(NOT_AVAILABLE);
  try {
    const { buf, truncated } = readCapped(o.fd, LIMITS.readBytes);
    if (buf.subarray(0, 8000).includes(0)) return err("Binary file; not shown.");
    const lines = buf.toString("utf8").split("\n");
    if (truncated || lines.at(-1) === "") lines.pop();
    if (start > lines.length) return ok(`(the readable part of this file has ${lines.length} lines)`);
    const end = Math.min(endReq, start + LIMITS.rangeLines - 1, lines.length);
    let text = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join("\n");
    if (end < Math.min(endReq, lines.length)) {
      text += `\n… range capped at ${LIMITS.rangeLines} lines; ask again from line ${end + 1}`;
    }
    if (truncated) text += "\n… file is larger than 256 KB; only the first 256 KB is readable";
    return ok(ctx.redact(text));
  } catch {
    return err(NOT_AVAILABLE);
  } finally {
    fs.closeSync(o.fd);
  }
}

// A deleted file's diff comes from git's objects, not from the filesystem, so it may be shown.
function deletedInside(root: string, rel: string): boolean {
  const lex = lexicalResolve(root, rel);
  if (!lex) return false;
  try {
    fs.lstatSync(lex.abs);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function search(ctx: JailContext, args: Record<string, unknown>): Promise<ToolResult> {
  const q = args.query;
  if (typeof q !== "string" || q.length === 0 || q.length > 200 || /[\0\n\r]/.test(q)) {
    return err("query must be 1–200 characters on one line.");
  }
  const { hits, truncated } = await ctx.git.grep(q);
  const checked = new Map<string, boolean>();
  const allowed = hits.filter((h) => {
    let okPath = checked.get(h.path);
    if (okPath === undefined) {
      okPath = containedOpens(ctx.root, h.path, "file");
      checked.set(h.path, okPath);
    }
    return okPath;
  });
  const shown = allowed.slice(0, LIMITS.searchHits);
  if (shown.length === 0) return ok("(no matches)");
  let text = shown.map((h) => `${h.path}:${h.line}: ${h.text.slice(0, LIMITS.hitChars)}`).join("\n");
  if (allowed.length > shown.length || truncated) text += `\n… more matches not shown (cap ${LIMITS.searchHits})`;
  return ok(ctx.redact(text));
}

export async function gitStatus(ctx: JailContext): Promise<ToolResult> {
  const s = await ctx.git.status();
  const lines = s.entries.filter((e) => lexicalResolve(ctx.root, e.path) !== null).map((e) => `${e.code} ${e.path}`);
  let text = [`## ${s.branch}`, ...lines].join("\n");
  if (s.truncated) text += "\n… output truncated";
  return ok(ctx.redact(text));
}

export async function gitDiff(ctx: JailContext, args: Record<string, unknown>): Promise<ToolResult> {
  let prefix: string | null = null;
  if (args.path !== undefined) {
    const lex = lexicalResolve(ctx.root, args.path);
    if (!lex) return err(NOT_AVAILABLE);
    prefix = lex.rel;
  }
  const listed = await ctx.git.diffNames();
  const names = listed.names.filter(
    (n) =>
      (prefix === null || prefix === "" || n === prefix || n.startsWith(`${prefix}/`)) &&
      (containedOpens(ctx.root, n, "file") || deletedInside(ctx.root, n)),
  );
  if (names.length === 0) return ok(listed.truncated ? "(no changes shown; the changed-file list was truncated)" : "(no changes)");
  const paths = names.slice(0, LIMITS.diffPaths);
  const { text, truncated } = await ctx.git.diff(paths);
  let out = text.trimEnd();
  if (names.length > paths.length) out += `\n… ${names.length - paths.length} more changed files not shown`;
  if (listed.truncated) out += "\n… the changed-file list was truncated";
  if (truncated) out += "\n… diff truncated at 4 MB";
  return ok(ctx.redact(out));
}

export async function runTool(ctx: JailContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_dir":
        return listDir(ctx, args);
      case "read_file":
        return readFile(ctx, args);
      case "search":
        return await search(ctx, args);
      case "git_status":
        return await gitStatus(ctx);
      case "git_diff":
        return await gitDiff(ctx, args);
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof RepoRefusedError) return err(e.message);
    if (e instanceof GitError) return err(`git failed: ${e.message}`);
    return err("Tool failed.");
  }
}
