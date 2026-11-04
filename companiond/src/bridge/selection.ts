import type { LiveState } from "../claude/runningFiles.ts";

export type SessionStatus = "busy" | "idle" | "recent" | "inactive";

export interface SessionSummary {
  /** Stable key. Desktop `sessionId`, or `transcript:<cliSessionId>` when desktop records are unreadable. */
  sessionId: string;
  cliSessionId: string | null;
  title: string;
  status: SessionStatus;
  isArchived: boolean;
  lastFocusedAt: number | null;
  lastActivityAt: number | null;
  recordCwd: string | null;
  /** Branch as Claude's record last saw it. The live branch is in the worktree resolution. */
  recordBranch: string | null;
  /** Exact root once resolved (tailed sessions only); the picker shows it instead of recordCwd. */
  resolvedRoot: string | null;
  source: "desktop" | "transcript_only";
  transcriptPath: string | null;
  /** Why no transcript was accepted (spec §6.1), null when found. */
  transcriptMissing: "invalid_id" | "not_found" | "session_id_mismatch" | null;
}

export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FOCUS_LABEL = "Claude focus (from Claude's records)";

/** Spec §6.2. */
export function computeStatus(live: LiveState | null, lastActivityAt: number | null, now: number): SessionStatus {
  if (live) return live;
  if (lastActivityAt !== null && now - lastActivityAt <= RECENT_WINDOW_MS) return "recent";
  return "inactive";
}

/** Highest lastFocusedAt among non-archived; ties → latest lastActivityAt; then sessionId for determinism. */
export function focusedSessionId(sessions: readonly SessionSummary[]): string | null {
  let best: SessionSummary | null = null;
  for (const s of sessions) {
    if (s.isArchived || s.lastFocusedAt === null) continue;
    if (
      best === null ||
      s.lastFocusedAt > (best.lastFocusedAt ?? -Infinity) ||
      (s.lastFocusedAt === best.lastFocusedAt &&
        ((s.lastActivityAt ?? -Infinity) > (best.lastActivityAt ?? -Infinity) ||
          ((s.lastActivityAt ?? -Infinity) === (best.lastActivityAt ?? -Infinity) && s.sessionId < best.sessionId)))
    ) {
      best = s;
    }
  }
  return best?.sessionId ?? null;
}

export interface Pin {
  sessionId: string;
  /** Focused session when the pin was set; a different focus later shows the chip. */
  focusAtPin: string | null;
}

export interface Selection {
  sessionId: string | null;
  via: "pin" | "focus" | "none";
  focusedSessionId: string | null;
  focusLabel: typeof FOCUS_LABEL;
  /** While pinned: the session Claude's focus moved to ("Claude focus moved to X — switch?"). */
  focusMovedTo: string | null;
  /** The pinned session is no longer listed. Kept pinned, never swapped silently. */
  pinnedMissing: boolean;
}

export function select(sessions: readonly SessionSummary[], pin: Pin | null): Selection {
  const focused = focusedSessionId(sessions);
  if (pin) {
    const moved = focused !== null && focused !== pin.focusAtPin && focused !== pin.sessionId ? focused : null;
    return {
      sessionId: pin.sessionId,
      via: "pin",
      focusedSessionId: focused,
      focusLabel: FOCUS_LABEL,
      focusMovedTo: moved,
      pinnedMissing: !sessions.some((s) => s.sessionId === pin.sessionId),
    };
  }
  return {
    sessionId: focused,
    via: focused ? "focus" : "none",
    focusedSessionId: focused,
    focusLabel: FOCUS_LABEL,
    focusMovedTo: null,
    pinnedMissing: false,
  };
}

export interface PickerGroups {
  busy: SessionSummary[];
  idle: SessionSummary[];
  recent: SessionSummary[];
  /** Inactive sessions, shown when searching. */
  older: SessionSummary[];
}

export interface PickerOptions {
  includeArchived?: boolean;
  /** Case-insensitive match on title, resolved root, cwd or branch. */
  query?: string;
}

/** Spec §6.2 manual picker: Busy / Idle / Recent, archived hidden by default, searchable. */
export function pickerGroups(sessions: readonly SessionSummary[], opts: PickerOptions = {}): PickerGroups {
  const q = opts.query?.trim().toLowerCase() ?? "";
  const groups: PickerGroups = { busy: [], idle: [], recent: [], older: [] };
  const byActivity = [...sessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  for (const s of byActivity) {
    if (s.isArchived && !opts.includeArchived) continue;
    if (q && ![s.title, s.resolvedRoot ?? "", s.recordCwd ?? "", s.recordBranch ?? ""].some((v) => v.toLowerCase().includes(q))) continue;
    if (s.status === "busy") groups.busy.push(s);
    else if (s.status === "idle") groups.idle.push(s);
    else if (s.status === "recent") groups.recent.push(s);
    else if (q) groups.older.push(s);
  }
  return groups;
}
