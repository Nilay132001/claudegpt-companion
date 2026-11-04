import path from "node:path";
import type { ReadFs } from "./readFs.ts";
import { readJsonFile } from "./readFs.ts";
import { isSafeId, toEpochMs } from "./paths.ts";

export interface DesktopRecord {
  /** Desktop session id (`local_…`). Stable for the life of the desktop session. */
  sessionId: string;
  /** Current CLI session id; names the transcript file. Null if absent or unsafe. */
  cliSessionId: string | null;
  cwd: string | null;
  branch: string | null;
  title: string;
  lastFocusedAt: number | null;
  lastActivityAt: number | null;
  isArchived: boolean;
  recordPath: string;
}

export interface DesktopRecordsResult {
  records: DesktopRecord[];
  /** Set when the records directory cannot be read at all (spec §6.2). */
  error: string | null;
  /** Record files that were not valid records. */
  skipped: number;
  /** Records dropped because another org/account folder had the same sessionId (latest activity kept). */
  duplicates: number;
}

export const DESKTOP_NOT_FOUND = "Claude Desktop sessions not found";

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function toDesktopRecord(raw: unknown, recordPath: string): DesktopRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sessionId = str(r.sessionId);
  if (sessionId === null) return null;
  return {
    sessionId,
    cliSessionId: isSafeId(r.cliSessionId) ? r.cliSessionId : null,
    cwd: str(r.cwd),
    branch: str(r.branch),
    title: str(r.title) ?? "Untitled session",
    lastFocusedAt: toEpochMs(r.lastFocusedAt),
    lastActivityAt: toEpochMs(r.lastActivityAt),
    isArchived: r.isArchived === true,
    recordPath,
  };
}

async function listDirs(fs: ReadFs, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await fs.readdir(dir)) {
    try {
      if ((await fs.stat(path.join(dir, name))).isDirectory()) out.push(name);
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

/** Reads `<dir>/<org>/<account>/local_*.json`. Read-only. */
export async function readDesktopRecords(fs: ReadFs, dir: string): Promise<DesktopRecordsResult> {
  let orgs: string[];
  try {
    orgs = await listDirs(fs, dir);
  } catch {
    return { records: [], error: DESKTOP_NOT_FOUND, skipped: 0, duplicates: 0 };
  }
  const byId = new Map<string, DesktopRecord>();
  let skipped = 0;
  let duplicates = 0;
  for (const org of orgs.sort()) {
    let accounts: string[] = [];
    try {
      accounts = await listDirs(fs, path.join(dir, org));
    } catch {
      continue;
    }
    for (const account of accounts) {
      const accDir = path.join(dir, org, account);
      let names: string[] = [];
      try {
        names = await fs.readdir(accDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/^local_[A-Za-z0-9_-]+\.json$/.test(name)) continue;
        const file = path.join(accDir, name);
        // A refused file (e.g. a link to a `*.key`) counts as skipped; the guard has already reported it.
        const rec = toDesktopRecord(await readJsonFile(fs, file).catch(() => null), file);
        if (!rec) {
          skipped++;
          continue;
        }
        const prev = byId.get(rec.sessionId);
        if (prev) {
          duplicates++;
          if ((rec.lastActivityAt ?? -Infinity) <= (prev.lastActivityAt ?? -Infinity)) continue;
        }
        byId.set(rec.sessionId, rec);
      }
    }
  }
  return { records: [...byId.values()], error: null, skipped, duplicates };
}
