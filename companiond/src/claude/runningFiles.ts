import path from "node:path";
import type { ReadFs } from "./readFs.ts";
import { readJsonFile } from "./readFs.ts";
import { toEpochMs } from "./paths.ts";

export interface RunningFile {
  pid: number;
  /** Equals the desktop record's cliSessionId. */
  sessionId: string;
  status: string;
  entrypoint: string;
  /** Process start time from the file, in epoch ms; null if absent or unparseable. */
  procStartMs: number | null;
  file: string;
}

export interface ProcessProbe {
  isAlive(pid: number): boolean;
  /** Start time of a live process in epoch ms, or null if unknown. */
  startTimeMs(pid: number): Promise<number | null>;
}

export type LiveState = "busy" | "idle";
export type StaleReason = "bad_pid" | "dead_pid" | "start_unknown" | "start_mismatch" | "not_desktop";
export type RunningCheck = { live: true; state: LiveState } | { live: false; reason: StaleReason };

/** `ps -o lstart` has 1 s resolution and truncates. */
export const START_TOLERANCE_MS = 2000;

/** Only `<digits>.json`. `*.key` and every other name are never listed or opened (spec §6.1). */
const RUNNING_NAME = /^[0-9]{1,10}\.json$/;

export async function readRunningFiles(fs: ReadFs, dir: string): Promise<RunningFile[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: RunningFile[] = [];
  for (const name of names) {
    if (!RUNNING_NAME.test(name)) continue;
    const file = path.join(dir, name);
    const raw = await readJsonFile(fs, file);
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.sessionId !== "string") continue;
    const filePid = Number(name.slice(0, -5));
    // A body pid that disagrees with the file name is a corrupt or foreign file: skip it.
    if (r.pid !== undefined && r.pid !== filePid) continue;
    // Only the fields below are kept; the socket path field is never read (spec §6.1).
    out.push({
      pid: filePid,
      sessionId: r.sessionId,
      status: typeof r.status === "string" ? r.status : "",
      entrypoint: typeof r.entrypoint === "string" ? r.entrypoint : "",
      procStartMs: toEpochMs(r.procStart),
      file,
    });
  }
  return out;
}

/** Spec §6.2: live only if pid alive, start time matches procStart, and entrypoint is claude-desktop. */
export async function checkRunningFile(rf: RunningFile, probe: ProcessProbe): Promise<RunningCheck> {
  if (!Number.isSafeInteger(rf.pid) || rf.pid <= 1) return { live: false, reason: "bad_pid" };
  if (rf.entrypoint !== "claude-desktop") return { live: false, reason: "not_desktop" };
  if (!probe.isAlive(rf.pid)) return { live: false, reason: "dead_pid" };
  const actual = await probe.startTimeMs(rf.pid);
  if (actual === null || rf.procStartMs === null) return { live: false, reason: "start_unknown" };
  if (Math.abs(actual - rf.procStartMs) > START_TOLERANCE_MS) return { live: false, reason: "start_mismatch" };
  return { live: true, state: rf.status === "idle" ? "idle" : "busy" };
}

/**
 * Caches start times of live pids so `ps` runs once per process, not once per poll. An entry is dropped as
 * soon as its pid is seen dead, so pid reuse is caught unless the pid dies and is reused within one poll.
 */
export function cacheStartTimes(probe: ProcessProbe): ProcessProbe {
  const cache = new Map<number, number | null>();
  return {
    isAlive(pid) {
      const alive = probe.isAlive(pid);
      if (!alive) cache.delete(pid);
      return alive;
    },
    async startTimeMs(pid) {
      if (cache.has(pid)) return cache.get(pid) ?? null;
      const t = await probe.startTimeMs(pid);
      if (t !== null) cache.set(pid, t);
      return t;
    },
  };
}

/** cliSessionId → live state, from every running file that passes checkRunningFile. */
export async function liveStates(files: RunningFile[], probe: ProcessProbe): Promise<Map<string, LiveState>> {
  const out = new Map<string, LiveState>();
  for (const rf of files) {
    const c = await checkRunningFile(rf, probe);
    if (!c.live) continue;
    if (out.get(rf.sessionId) !== "busy") out.set(rf.sessionId, c.state);
  }
  return out;
}
