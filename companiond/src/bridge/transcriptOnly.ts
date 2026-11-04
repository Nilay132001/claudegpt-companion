import path from "node:path";
import type { FileStat, ReadFs } from "../claude/readFs.ts";
import { isSafeId } from "../claude/paths.ts";
import { transcriptHasSessionId } from "../claude/transcriptLocator.ts";

export interface TranscriptOnlyEntry {
  cliSessionId: string;
  path: string;
  mtimeMs: number;
}

export const TRANSCRIPT_ONLY_MAX = 200;

/**
 * Head-check results by path, so a tick re-reads no head of an unchanged file. A verified file keeps its
 * answer while it is the same file (dev:ino) and has not shrunk (appends never change the head's
 * sessionId); a rejected one is checked again once its size changes (its head may still be being written).
 */
export class TranscriptHeadCache {
  readonly #entries = new Map<string, { id: string; dev: number; ino: number; size: number; ok: boolean }>();

  get size(): number {
    return this.#entries.size;
  }

  async verified(fs: ReadFs, file: string, id: string, st: FileStat): Promise<boolean> {
    const c = this.#entries.get(file);
    if (c && c.id === id && c.dev === st.dev && c.ino === st.ino && (c.ok ? st.size >= c.size : st.size === c.size)) {
      c.size = st.size;
      return c.ok;
    }
    const ok = await transcriptHasSessionId(fs, file, id);
    this.#entries.set(file, { id, dev: st.dev, ino: st.ino, size: st.size, ok });
    return ok;
  }

  /** Forgets every path not in `keep`. */
  retain(keep: Set<string>): void {
    for (const p of [...this.#entries.keys()]) if (!keep.has(p)) this.#entries.delete(p);
  }
}

/**
 * Used when desktop records are unreadable (spec §6.2): the picker still lists transcripts. Newest first.
 * Pass a cache that lives across calls (SessionBridge does) so unchanged files are only stat'ed.
 */
export async function listTranscripts(
  fs: ReadFs,
  projectsDir: string,
  max = TRANSCRIPT_ONLY_MAX,
  cache: TranscriptHeadCache = new TranscriptHeadCache(),
): Promise<TranscriptOnlyEntry[]> {
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(projectsDir);
  } catch {
    cache.retain(new Set());
    return [];
  }
  const found: Array<TranscriptOnlyEntry & { st: FileStat }> = [];
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
        if (st.isFile()) found.push({ cliSessionId: id, path: file, mtimeMs: st.mtimeMs, st });
      } catch {
        // vanished
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: TranscriptOnlyEntry[] = [];
  const checked = new Set<string>();
  for (const e of found) {
    if (out.length >= max) break;
    checked.add(e.path);
    if (await cache.verified(fs, e.path, e.cliSessionId, e.st)) out.push({ cliSessionId: e.cliSessionId, path: e.path, mtimeMs: e.mtimeMs });
  }
  cache.retain(checked);
  return out;
}
