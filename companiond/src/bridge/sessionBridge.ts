import type { ClaudePaths } from "../claude/paths.ts";
import type { ReadFs } from "../claude/readFs.ts";
import { guardReadFs, nodeReadFs } from "../claude/readFs.ts";
import type { DesktopRecord } from "../claude/desktopRecords.ts";
import { readDesktopRecords } from "../claude/desktopRecords.ts";
import type { ProcessProbe } from "../claude/runningFiles.ts";
import { cacheStartTimes, liveStates, readRunningFiles } from "../claude/runningFiles.ts";
import { nodeProcessProbe } from "../claude/processProbe.ts";
import type { TranscriptLocation } from "../claude/transcriptLocator.ts";
import { locateTranscript } from "../claude/transcriptLocator.ts";
import type { TranscriptEvent } from "../transcript/parser.ts";
import type { SyncStats, TranscriptBatch } from "../transcript/reader.ts";
import { TranscriptReader } from "../transcript/reader.ts";
import type { SubagentUpdate } from "../transcript/subagents.ts";
import { SubagentTails } from "../transcript/subagents.ts";
import type { IsApproved, RepoChange, WorktreeResolution } from "../worktree/resolver.ts";
import { describeChange, resolveWorktree } from "../worktree/resolver.ts";
import { SafeGit } from "../git/safeGit.ts";
import type { Pin, Selection, SessionSummary } from "./selection.ts";
import { computeStatus, focusedSessionId, select } from "./selection.ts";
import { listTranscripts } from "./transcriptOnly.ts";
import type { WatchFactory, WatchHandle } from "./watcher.ts";
import { nodeWatchFactory } from "./watcher.ts";

export interface SessionsSnapshot {
  sessions: SessionSummary[];
  selection: Selection;
  /** "Claude Desktop sessions not found" when records are unreadable; sessions then come from transcripts. */
  desktopRecordsError: string | null;
  refreshedAt: number;
}

export type BridgeEvent =
  | { type: "sessions"; snapshot: SessionsSnapshot }
  | { type: "transcript"; sessionId: string; cliSessionId: string; batch: TranscriptBatch; stats: SyncStats }
  | { type: "subagent"; sessionId: string; update: SubagentUpdate }
  | { type: "worktree"; sessionId: string; resolution: WorktreeResolution; change: RepoChange | null }
  /** Never contains a path: a label and an error code only. */
  | { type: "sync_error"; message: string };

export type BridgeListener = (e: BridgeEvent) => void;

export interface SyncStatus {
  state: "live" | "missing" | "not_tracked";
  stats: SyncStats | null;
  lastPollAt: number | null;
}

export interface SessionBridgeOptions {
  paths: ClaudePaths;
  isApproved: IsApproved;
  /** Absolute git for SafeGit. M4 passes discoverToolchain().gitPath (M2); tests pass testGitPath(). */
  gitPath: string;
  fs?: ReadFs;
  probe?: ProcessProbe;
  now?: () => number;
  /** Stat fallback interval (spec §3: 2 s). */
  pollIntervalMs?: number;
  /** null disables watching (tests drive tick() directly). */
  watch?: WatchFactory | null;
  /** First delay before a failed watcher is re-created; doubles up to 60 s. Default: pollIntervalMs. */
  rewatchDelayMs?: number;
  /** Pin restored by M4's Store. */
  initialPin?: string | null;
  /** Called with the basename whenever the guard refuses a `.key` path. Should never fire. */
  onRefusedPath?: (basename: string) => void;
  /** Readers kept for sessions that stopped being tailed, so switching back does not re-read from 0. */
  parkedReaders?: number;
}

interface Tracked {
  cliSessionId: string;
  reader: TranscriptReader;
  subagents: SubagentTails;
  missing: boolean;
  lastPollAt: number | null;
}

interface WorktreeState {
  resolution: WorktreeResolution;
  candidate: string | null;
}

interface WatchSlot {
  label: string;
  dir: string;
  onChange: () => void;
  handle: WatchHandle | null;
  gen: number;
  delay: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const errCode = (err: unknown): string =>
  typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : ((err as Error)?.name ?? "Error");

/**
 * Owns discovery, status, focus/pin, the tails of the selected and busy sessions, and their worktree
 * resolution. Read-only on all Claude data; the only place that wraps ReadFs in guardReadFs. Operations run
 * one at a time on a queue; at most one tick waits in it.
 */
export class SessionBridge {
  readonly #paths: ClaudePaths;
  readonly #fs: ReadFs;
  readonly #probe: ProcessProbe;
  readonly #gitPath: string;
  readonly #isApproved: IsApproved;
  readonly #now: () => number;
  readonly #interval: number;
  readonly #watch: WatchFactory | null;
  readonly #rewatchDelay: number;
  readonly #parkedMax: number;
  readonly #listeners = new Set<BridgeListener>();
  #queue: Promise<void> = Promise.resolve();
  #pendingTick: Promise<void> | null = null;
  #pendingTailPoll: Promise<void> | null = null;
  #sessions: SessionSummary[] = [];
  #records = new Map<string, DesktopRecord>();
  #locations = new Map<string, { cli: string; loc: TranscriptLocation }>();
  #tracked = new Map<string, Tracked>();
  #parked = new Map<string, Tracked>();
  /** Last cliSessionId a reader was made for, per session; survives untracking. */
  #lastCli = new Map<string, string>();
  #worktrees = new Map<string, WorktreeState>();
  /** Sessions polled in the last pass: listed and (selected or busy). */
  #active = new Set<string>();
  #pin: Pin | null = null;
  #pinRestored = false;
  #desktopError: string | null = null;
  #lastSnapshot = "";
  #refreshedAt = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #hintTimer: ReturnType<typeof setTimeout> | null = null;
  #watchSlots: WatchSlot[] = [];

  constructor(opts: SessionBridgeOptions) {
    this.#paths = opts.paths;
    this.#fs = guardReadFs(opts.fs ?? nodeReadFs, opts.onRefusedPath);
    this.#probe = cacheStartTimes(opts.probe ?? nodeProcessProbe);
    this.#gitPath = opts.gitPath;
    this.#isApproved = opts.isApproved;
    this.#now = opts.now ?? Date.now;
    this.#interval = opts.pollIntervalMs ?? 2000;
    this.#watch = opts.watch === undefined ? nodeWatchFactory : opts.watch;
    this.#rewatchDelay = opts.rewatchDelayMs ?? this.#interval;
    this.#parkedMax = opts.parkedReaders ?? 8;
    if (opts.initialPin) {
      this.#pin = { sessionId: opts.initialPin, focusAtPin: null };
      this.#pinRestored = true;
    }
  }

  /**
   * Adds a listener; returns the function that removes it. Listeners are called synchronously; an exception
   * thrown by a listener is caught and dropped (not reported), so guard your own listener if you need to know.
   */
  on(listener: BridgeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Full rescan (refresh button, ⌘R, wake, watcher error): forgets cached transcript locations. */
  refresh(): Promise<SessionsSnapshot> {
    return this.#enqueue(async () => {
      this.#locations.clear();
      await this.#scan(true);
    }).then(() => this.snapshot());
  }

  /** Incremental pass: re-read records and running files, poll the active tails. Coalesced. */
  tick(): Promise<void> {
    if (this.#pendingTick) return this.#pendingTick;
    const p = this.#enqueue(async () => {
      this.#pendingTick = null;
      await this.#scan(false);
    });
    this.#pendingTick = p;
    return p;
  }

  /** Resolves when every queued operation has finished. */
  idle(): Promise<void> {
    return this.#enqueue(async () => {});
  }

  /** Pin a session (also what the manual picker does); null unpins and focus takes over again. */
  pin(sessionId: string | null): Selection {
    this.#pin = sessionId === null ? null : { sessionId, focusAtPin: focusedSessionId(this.#sessions) };
    this.#pinRestored = false;
    this.#emitSnapshot();
    this.#background(this.tick());
    return this.snapshot().selection;
  }

  /** A copy; callers may keep or change it. */
  snapshot(): SessionsSnapshot {
    return structuredClone({
      sessions: this.#sessions,
      selection: select(this.#sessions, this.#pin),
      desktopRecordsError: this.#desktopError,
      refreshedAt: this.#refreshedAt,
    });
  }

  /** The current event window of a tailed session (newest TranscriptReader window), or [] if not tailed. */
  events(sessionId: string): readonly TranscriptEvent[] {
    return this.#tracked.get(sessionId)?.reader.events ?? [];
  }

  /** True if the session's transcript (since its last reset) contains a record with this uuid. */
  hasUuid(sessionId: string, uuid: string): boolean {
    return this.#tracked.get(sessionId)?.reader.hasUuid(uuid) ?? false;
  }

  /**
   * Resolution of a session polled in the last pass (selected or busy), else null. An untailed session's
   * stored resolution may be stale, and §6.3 forbids presenting a last-good root; the stored entry is kept
   * internally only so a move made while untailed is reported once the session is tailed again.
   */
  worktree(sessionId: string): WorktreeResolution | null {
    if (!this.#active.has(sessionId)) return null;
    return this.#worktrees.get(sessionId)?.resolution ?? null;
  }

  /** Live branch of the session's resolved root, read now through SafeGit (spec §6.3: read at each turn). */
  async liveBranch(sessionId: string): Promise<string | null> {
    const r = this.worktree(sessionId);
    if (r?.kind !== "resolved") return null;
    try {
      return await (await SafeGit.open({ root: r.root, gitPath: this.#gitPath })).branch();
    } catch {
      return null;
    }
  }

  /** Re-run resolution now, e.g. after the user approves a root (M4). Null (and no change) for an untailed or unlisted session. */
  resolveNow(sessionId: string): Promise<WorktreeResolution | null> {
    return this.#enqueue(async () => {
      if (!this.#active.has(sessionId)) return;
      await this.#resolve(sessionId, true);
      this.#emitSnapshot();
    }).then(() => this.worktree(sessionId));
  }

  syncStatus(sessionId: string): SyncStatus {
    const t = this.#tracked.get(sessionId);
    if (!t) return { state: "not_tracked", stats: null, lastPollAt: null };
    return { state: t.missing ? "missing" : "live", stats: t.reader.stats, lastPollAt: t.lastPollAt };
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#background(this.tick()), this.#interval);
    this.#timer.unref?.();
    this.#startWatchers();
    this.#background(this.refresh());
  }

  /**
   * Fire-and-forget calls go through here. A failed pass was already reported as sync_error by #enqueue;
   * this only stops the rejection from becoming an unhandled rejection that would end the daemon.
   */
  #background(p: Promise<unknown>): void {
    p.catch(() => {});
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#hintTimer) clearTimeout(this.#hintTimer);
    this.#hintTimer = null;
    for (const s of this.#watchSlots) {
      s.gen++;
      if (s.timer) clearTimeout(s.timer);
      s.handle?.close();
    }
    this.#watchSlots = [];
  }

  // ---- watching: hints only ----

  #startWatchers(): void {
    if (!this.#watch) return;
    const tickSoon = () => {
      if (this.#hintTimer) return;
      this.#hintTimer = setTimeout(() => {
        this.#hintTimer = null;
        this.#background(this.tick());
      }, 100);
      this.#hintTimer.unref?.();
    };
    const tailsSoon = () => this.#background(this.#pollTails());
    this.#watchSlots = [
      { label: "desktop records", dir: this.#paths.desktopSessionsDir, onChange: tickSoon },
      { label: "running files", dir: this.#paths.runningDir, onChange: tickSoon },
      { label: "transcripts", dir: this.#paths.projectsDir, onChange: tailsSoon },
    ].map((s) => ({ ...s, handle: null, gen: 0, delay: this.#rewatchDelay, timer: null }));
    for (const s of this.#watchSlots) this.#arm(s);
  }

  #arm(slot: WatchSlot): void {
    if (!this.#watch || !this.#timer) return;
    const gen = ++slot.gen;
    slot.handle = this.#watch(
      slot.dir,
      () => {
        if (gen !== slot.gen) return;
        slot.delay = this.#rewatchDelay;
        slot.onChange();
      },
      (err) => {
        if (gen === slot.gen) this.#onWatchError(slot, err);
      },
    );
  }

  #onWatchError(slot: WatchSlot, err: Error): void {
    slot.gen++;
    slot.handle?.close();
    slot.handle = null;
    const code = errCode(err);
    this.#emit({ type: "sync_error", message: `watcher failed (${slot.label}): ${code}` });
    // A missing folder is normal (Claude not installed yet): keep polling, no full rescan.
    if (code !== "ENOENT") this.#background(this.refresh());
    if (slot.timer || !this.#timer) return;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      this.#arm(slot);
    }, slot.delay);
    slot.timer.unref?.();
    slot.delay = Math.min(slot.delay * 2, 60_000);
  }

  // ---- queue ----

  #enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(op);
    this.#queue = run.catch((err: unknown) => this.#emit({ type: "sync_error", message: `bridge pass failed: ${errCode(err)}` }));
    return run;
  }

  #pollTails(): Promise<void> {
    if (this.#pendingTailPoll) return this.#pendingTailPoll;
    const p = this.#enqueue(async () => {
      this.#pendingTailPoll = null;
      for (const s of this.#sessions) if (this.#tracked.has(s.sessionId)) await this.#pollSession(s, false);
      this.#emitSnapshot();
    });
    this.#pendingTailPoll = p;
    return p;
  }

  /** A throwing listener is skipped: it must not reject the queue (which would freeze every later pass). */
  #emit(e: BridgeEvent): void {
    for (const l of this.#listeners) {
      try {
        l(e);
      } catch {
        // The listener's own bug; other listeners and the bridge carry on.
      }
    }
  }

  #emitSnapshot(): void {
    const snap = this.snapshot();
    const key = JSON.stringify({ s: snap.sessions, sel: snap.selection, e: snap.desktopRecordsError });
    if (key === this.#lastSnapshot) return;
    this.#lastSnapshot = key;
    this.#emit({ type: "sessions", snapshot: snap });
  }

  // ---- scan ----

  async #scan(full: boolean): Promise<void> {
    const now = this.#now();
    const live = await liveStates(await readRunningFiles(this.#fs, this.#paths.runningDir), this.#probe);
    const res = await readDesktopRecords(this.#fs, this.#paths.desktopSessionsDir);
    this.#desktopError = res.error;
    const sessions: SessionSummary[] = [];
    this.#records.clear();
    if (res.error === null) {
      for (const r of res.records) {
        this.#records.set(r.sessionId, r);
        const loc = await this.#location(r, full);
        sessions.push({
          sessionId: r.sessionId,
          cliSessionId: r.cliSessionId,
          title: r.title,
          status: computeStatus(r.cliSessionId ? (live.get(r.cliSessionId) ?? null) : null, r.lastActivityAt, now),
          isArchived: r.isArchived,
          lastFocusedAt: r.lastFocusedAt,
          lastActivityAt: r.lastActivityAt,
          recordCwd: r.cwd,
          recordBranch: r.branch,
          resolvedRoot: null,
          source: "desktop",
          transcriptPath: loc.kind === "found" ? loc.path : null,
          transcriptMissing: loc.kind === "missing" ? loc.reason : null,
        });
      }
    } else {
      for (const t of await listTranscripts(this.#fs, this.#paths.projectsDir)) {
        sessions.push({
          sessionId: `transcript:${t.cliSessionId}`,
          cliSessionId: t.cliSessionId,
          title: `Transcript ${t.cliSessionId.slice(0, 8)}`,
          status: computeStatus(live.get(t.cliSessionId) ?? null, t.mtimeMs, now),
          isArchived: false,
          lastFocusedAt: null,
          lastActivityAt: t.mtimeMs,
          recordCwd: null,
          recordBranch: null,
          resolvedRoot: null,
          source: "transcript_only",
          transcriptPath: t.path,
          transcriptMissing: null,
        });
      }
    }
    sessions.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
    this.#sessions = sessions;
    this.#refreshedAt = now;
    if (this.#pin && this.#pinRestored) {
      // A restored pin starts from the current focus, so the chip shows only a later move.
      this.#pin = { sessionId: this.#pin.sessionId, focusAtPin: focusedSessionId(sessions) };
      this.#pinRestored = false;
    }

    const selected = select(sessions, this.#pin).sessionId;
    const active = new Set(sessions.filter((s) => s.status === "busy").map((s) => s.sessionId));
    const listed = new Set(sessions.map((s) => s.sessionId));
    // A pinned session that vanished stays pinned (pinnedMissing) but is not tailed.
    if (selected && listed.has(selected)) active.add(selected);
    this.#active = active;
    for (const [id, t] of [...this.#tracked]) {
      if (active.has(id)) continue;
      this.#tracked.delete(id);
      if (listed.has(id)) this.#park(id, t);
    }
    // Sessions that left the list take their parked reader (and its subagent tails), cliSessionId memory,
    // cached location and worktree state with them. A session that is merely untailed keeps its last
    // resolution, so a repo move made while it was untailed is reported when it is tailed again (§6.3).
    for (const id of [...this.#parked.keys()]) if (!listed.has(id)) this.#parked.delete(id);
    for (const id of [...this.#lastCli.keys()]) if (!listed.has(id)) this.#lastCli.delete(id);
    for (const id of [...this.#locations.keys()]) if (!listed.has(id)) this.#locations.delete(id);
    for (const id of [...this.#worktrees.keys()]) if (!listed.has(id)) this.#worktrees.delete(id);
    for (const s of sessions) if (active.has(s.sessionId)) await this.#pollSession(s, full);
    this.#emitSnapshot();
  }

  #park(id: string, t: Tracked): void {
    this.#parked.delete(id);
    this.#parked.set(id, t);
    while (this.#parked.size > this.#parkedMax) {
      const oldest = this.#parked.keys().next().value;
      if (oldest === undefined) break;
      this.#parked.delete(oldest);
    }
  }

  async #location(r: DesktopRecord, force: boolean): Promise<TranscriptLocation> {
    const cached = this.#locations.get(r.sessionId);
    if (!force && cached && cached.cli === (r.cliSessionId ?? "")) return cached.loc;
    const loc = await locateTranscript(this.#fs, this.#paths.projectsDir, r.cwd, r.cliSessionId);
    this.#locations.set(r.sessionId, { cli: r.cliSessionId ?? "", loc });
    return loc;
  }

  async #pollSession(s: SessionSummary, full: boolean): Promise<void> {
    const rec = this.#records.get(s.sessionId);
    if (rec && s.transcriptPath === null && !full) {
      // Active session without a transcript yet: look again every pass (inactive ones wait for refresh).
      const loc = await this.#location(rec, true);
      if (loc.kind === "found") {
        s.transcriptPath = loc.path;
        s.transcriptMissing = null;
      }
    }
    let t = this.#tracked.get(s.sessionId);
    if (s.cliSessionId && s.transcriptPath) {
      if (!t || t.cliSessionId !== s.cliSessionId || t.reader.path !== s.transcriptPath) {
        const parked = this.#parked.get(s.sessionId);
        this.#parked.delete(s.sessionId);
        if (parked && parked.cliSessionId === s.cliSessionId && parked.reader.path === s.transcriptPath) {
          t = parked;
        } else {
          t = {
            cliSessionId: s.cliSessionId,
            reader: new TranscriptReader(s.transcriptPath, this.#fs),
            subagents: new SubagentTails(s.transcriptPath, this.#fs),
            missing: false,
            lastPollAt: null,
          };
        }
        this.#tracked.set(s.sessionId, t);
      }
      const prevCli = this.#lastCli.get(s.sessionId);
      this.#lastCli.set(s.sessionId, t.cliSessionId);
      let batch = await t.reader.poll();
      t.lastPollAt = this.#now();
      if (batch?.kind === "reset" && batch.cause === "initial" && prevCli !== undefined && prevCli !== t.cliSessionId) {
        batch = { ...batch, cause: "session_id_changed" };
      }
      if (batch) {
        t.missing = batch.kind === "missing";
        this.#emit({ type: "transcript", sessionId: s.sessionId, cliSessionId: t.cliSessionId, batch, stats: t.reader.stats });
      }
      for (const update of await t.subagents.poll()) this.#emit({ type: "subagent", sessionId: s.sessionId, update });
    } else if (t) {
      this.#tracked.delete(s.sessionId);
    }
    await this.#resolve(s.sessionId, full);
    const r = this.#worktrees.get(s.sessionId)?.resolution;
    s.resolvedRoot = r?.kind === "resolved" ? r.root : null;
  }

  async #resolve(sessionId: string, force: boolean): Promise<void> {
    const t = this.#tracked.get(sessionId);
    const recordCwd = this.#records.get(sessionId)?.cwd ?? null;
    const transcriptCwd = t?.reader.latestCwd ?? null;
    const candidate = transcriptCwd ?? recordCwd;
    const prev = this.#worktrees.get(sessionId) ?? null;
    if (!force && prev && prev.candidate === candidate) return;
    const resolution = await resolveWorktree({ transcriptCwd, recordCwd }, { fs: this.#fs, gitPath: this.#gitPath, isApproved: this.#isApproved });
    this.#worktrees.set(sessionId, { resolution, candidate });
    const s = this.#sessions.find((x) => x.sessionId === sessionId);
    if (s) s.resolvedRoot = resolution.kind === "resolved" ? resolution.root : null;
    if (prev && JSON.stringify(prev.resolution) === JSON.stringify(resolution)) return;
    this.#emit({ type: "worktree", sessionId, resolution, change: describeChange(prev?.resolution ?? null, resolution) });
  }
}
