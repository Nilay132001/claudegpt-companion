import path from "node:path";
import type { ReadFs } from "./readFs.ts";
import { encodeCwd, isSafeId } from "./paths.ts";

export type TranscriptLocation =
  | { kind: "found"; path: string; via: "encoded_cwd" | "search" }
  | { kind: "missing"; reason: "invalid_id" | "not_found" | "session_id_mismatch" };

/** How much of a transcript's head is read to check `sessionId`. */
export const HEAD_BYTES = 64 * 1024;
/** A first line longer than HEAD_BYTES is read up to this size. */
export const HEAD_MAX_BYTES = 1024 * 1024;
export const HEAD_LINES = 30;

/**
 * True if one of the first lines is a record whose `sessionId` equals `id`. Reads 64 KB; if that holds no
 * newline, reads up to 1 MiB. A last line without a newline counts only when the read reached end of file.
 */
export async function transcriptHasSessionId(fs: ReadFs, file: string, id: string): Promise<boolean> {
  let head: Buffer;
  let requested = HEAD_BYTES;
  try {
    head = (await fs.readRange(file, 0, requested)).buf;
    if (head.length === requested && head.indexOf(0x0a) === -1) {
      requested = HEAD_MAX_BYTES;
      head = (await fs.readRange(file, 0, requested)).buf;
    }
  } catch {
    return false;
  }
  // A short read means end of file, even when the file is exactly `requested` bytes long.
  const atEof = head.length < requested;
  const end = atEof ? head.length : head.lastIndexOf(0x0a);
  if (end <= 0) return false;
  const lines = head.subarray(0, end).toString("utf8").split("\n").slice(0, HEAD_LINES);
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as { sessionId?: unknown };
      if (rec && rec.sessionId === id) return true;
    } catch {
      // malformed head line: keep looking
    }
  }
  return false;
}

async function isFile(fs: ReadFs, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Spec §6.1: try `<projectsDir>/<encoded cwd>/<id>.jsonl`, else any `<projectsDir>/<dir>/<id>.jsonl`.
 * A file is accepted only if records inside carry `sessionId == id` (the folder name is lossy).
 */
export async function locateTranscript(
  fs: ReadFs,
  projectsDir: string,
  cwd: string | null,
  cliSessionId: string | null,
): Promise<TranscriptLocation> {
  if (!isSafeId(cliSessionId)) return { kind: "missing", reason: "invalid_id" };
  const fileName = `${cliSessionId}.jsonl`;
  let sawMismatch = false;
  const tried = new Set<string>();
  if (cwd !== null) {
    const candidate = path.join(projectsDir, encodeCwd(cwd), fileName);
    tried.add(candidate);
    if (await isFile(fs, candidate)) {
      if (await transcriptHasSessionId(fs, candidate, cliSessionId)) return { kind: "found", path: candidate, via: "encoded_cwd" };
      sawMismatch = true;
    }
  }
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(projectsDir)).sort();
  } catch {
    return { kind: "missing", reason: "not_found" };
  }
  for (const d of dirs) {
    const candidate = path.join(projectsDir, d, fileName);
    if (tried.has(candidate) || !(await isFile(fs, candidate))) continue;
    if (await transcriptHasSessionId(fs, candidate, cliSessionId)) return { kind: "found", path: candidate, via: "search" };
    sawMismatch = true;
  }
  return { kind: "missing", reason: sawMismatch ? "session_id_mismatch" : "not_found" };
}
