import path from "node:path";

/** Base directories for Claude's data. Tests pass temp dirs; production passes defaultClaudePaths(os.homedir()). */
export interface ClaudePaths {
  /** `~/Library/Application Support/Claude/claude-code-sessions` — `<org>/<account>/local_<id>.json` */
  desktopSessionsDir: string;
  /** `~/.claude/projects` — `<encoded cwd>/<cliSessionId>.jsonl` */
  projectsDir: string;
  /** `~/.claude/sessions` — `<pid>.json` running files (and `*.key` files we never open) */
  runningDir: string;
}

export function defaultClaudePaths(home: string): ClaudePaths {
  return {
    desktopSessionsDir: path.join(home, "Library", "Application Support", "Claude", "claude-code-sessions"),
    projectsDir: path.join(home, ".claude", "projects"),
    runningDir: path.join(home, ".claude", "sessions"),
  };
}

/** Claude's folder name for a cwd: every non-alphanumeric character becomes "-" (lossy, spec §6.1). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Ids from Claude's files are data. Only these are ever used to build a path. */
export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** Accepts epoch ms, epoch seconds, a numeric string, or an ISO/date string. */
export function toEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return toEpochMs(n);
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
