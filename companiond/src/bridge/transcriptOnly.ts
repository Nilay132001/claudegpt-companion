import path from "node:path";
import type { ReadFs } from "../claude/readFs.ts";
import { isSafeId } from "../claude/paths.ts";
import { transcriptHasSessionId } from "../claude/transcriptLocator.ts";

export interface TranscriptOnlyEntry {
  cliSessionId: string;
  path: string;
  mtimeMs: number;
}

export const TRANSCRIPT_ONLY_MAX = 200;

/** Used when desktop records are unreadable (spec §6.2): the picker still lists transcripts. Newest first. */
export async function listTranscripts(fs: ReadFs, projectsDir: string, max = TRANSCRIPT_ONLY_MAX): Promise<TranscriptOnlyEntry[]> {
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(projectsDir);
  } catch {
    return [];
  }
  const found: TranscriptOnlyEntry[] = [];
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(projectsDir, d));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const id = n.slice(0, -6);
      if (!isSafeId(id)) continue;
      const file = path.join(projectsDir, d, n);
      try {
        const st = await fs.stat(file);
        if (st.isFile()) found.push({ cliSessionId: id, path: file, mtimeMs: st.mtimeMs });
      } catch {
        // vanished
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: TranscriptOnlyEntry[] = [];
  for (const e of found) {
    if (out.length >= max) break;
    if (await transcriptHasSessionId(fs, e.path, e.cliSessionId)) out.push(e);
  }
  return out;
}
