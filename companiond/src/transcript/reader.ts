import type { ReadFs } from "../claude/readFs.ts";
import type { TranscriptEvent } from "./parser.ts";
import { TranscriptParser } from "./parser.ts";
import type { ResetReason, TailOptions } from "./tail.ts";
import { TranscriptTail } from "./tail.ts";

export interface SyncStats {
  records: number;
  /** Complete lines that were not a JSON object (spec §6.4 "skipped and counted"). */
  malformedLines: number;
  invalidUtf8Lines: number;
  oversizedLines: number;
  /** Records of a type the parser does not know (spec §16). */
  unknownRecords: number;
  /** Events that fell out of the front of the window since the file was (re)read. */
  droppedEvents: number;
}

export type ResetCause = "initial" | "truncated" | "replaced" | "session_id_changed";

export type TranscriptBatch =
  /** New events appended since the last batch (at most the window size; older ones were dropped). */
  | { kind: "append"; events: TranscriptEvent[] }
  /**
   * The current window, rebuilt. Restore cursors by `uuid` with hasUuid(); a uuid that is not known means
   * the cursor is gone (spec §6.4). `dropped` events came before the window and are not resent.
   */
  | { kind: "reset"; cause: ResetCause; events: TranscriptEvent[]; dropped: number }
  /** The file is gone or unreadable. Sent once per transition. */
  | { kind: "missing" };

export interface ReaderOptions extends TailOptions {
  /** Window size: newest events kept in memory (default 2,000). */
  maxEvents?: number;
  /** Window size by approximate text size (default 8 MiB). */
  maxEventBytes?: number;
}

export const MAX_WINDOW_EVENTS = 2_000;
export const MAX_WINDOW_BYTES = 8 * 1024 * 1024;

function approxSize(e: TranscriptEvent): number {
  let n = 64;
  for (const v of Object.values(e)) if (typeof v === "string") n += v.length;
  return n;
}

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Tail + parser + a rolling window of events for one transcript file. The uuid index covers every record
 * read since the last reset, including events that left the window.
 */
export class TranscriptReader {
  readonly path: string;
  readonly #tail: TranscriptTail;
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  #parser = new TranscriptParser();
  #events: TranscriptEvent[] = [];
  #sizes: number[] = [];
  #bytes = 0;
  #dropped = 0;
  #uuids = new Set<string>();
  #lastCwd: string | null = null;
  #lastBranch: string | null = null;
  #malformed = 0;
  #unknown = 0;
  #records = 0;
  #started = false;
  #missing = false;

  constructor(path: string, fs: ReadFs, opts: ReaderOptions = {}) {
    this.path = path;
    this.#tail = new TranscriptTail(path, fs, opts);
    this.#maxEvents = opts.maxEvents ?? MAX_WINDOW_EVENTS;
    this.#maxBytes = opts.maxEventBytes ?? MAX_WINDOW_BYTES;
  }

  /** The window: newest events, oldest first. */
  get events(): readonly TranscriptEvent[] {
    return this.#events;
  }

  hasUuid(uuid: string): boolean {
    return this.#uuids.has(uuid);
  }

  /** `cwd` of the latest main-chain (non-sidechain) record that has one (spec §6.3 candidate). */
  get latestCwd(): string | null {
    return this.#lastCwd;
  }

  get latestGitBranch(): string | null {
    return this.#lastBranch;
  }

  get stats(): SyncStats {
    return {
      records: this.#records,
      malformedLines: this.#malformed,
      unknownRecords: this.#unknown,
      droppedEvents: this.#dropped,
      ...this.#tail.stats,
    };
  }

  /** Reads everything new, one slice at a time, yielding between slices. Returns null when nothing changed. */
  async poll(): Promise<TranscriptBatch | null> {
    let r = await this.#tail.poll();
    if (r.kind === "missing") return this.#goneMissing();
    const wasMissing = this.#missing;
    this.#missing = false;
    let cause: ResetReason | null = r.reset ?? (wasMissing ? "replaced" : null);
    if (cause) this.#clear();
    let fresh = this.#ingest(r.lines);
    while (r.more) {
      await yieldNow();
      const before = this.#tail.offset;
      r = await this.#tail.poll();
      if (r.kind === "missing") return this.#goneMissing();
      if (r.reset) {
        this.#clear();
        cause = r.reset;
        fresh = [];
      }
      fresh = fresh.concat(this.#ingest(r.lines));
      // Belt and braces: a slice that made no progress ends the loop even if `more` says otherwise.
      if (r.lines.length === 0 && !r.reset && this.#tail.offset === before) break;
    }
    if (!this.#started) {
      this.#started = true;
      return { kind: "reset", cause: "initial", events: [...this.#events], dropped: this.#dropped };
    }
    if (cause) return { kind: "reset", cause, events: [...this.#events], dropped: this.#dropped };
    if (fresh.length === 0) return null;
    return { kind: "append", events: fresh.length > this.#events.length ? fresh.slice(-this.#events.length) : fresh };
  }

  #goneMissing(): TranscriptBatch | null {
    if (this.#missing) return null;
    this.#missing = true;
    return { kind: "missing" };
  }

  #clear(): void {
    this.#parser = new TranscriptParser();
    this.#events = [];
    this.#sizes = [];
    this.#bytes = 0;
    this.#dropped = 0;
    this.#uuids.clear();
    this.#lastCwd = null;
    this.#lastBranch = null;
    this.#malformed = 0;
    this.#unknown = 0;
    this.#records = 0;
  }

  #push(e: TranscriptEvent): void {
    const size = approxSize(e);
    this.#events.push(e);
    this.#sizes.push(size);
    this.#bytes += size;
  }

  #trimWindow(): void {
    let n = 0;
    let bytes = this.#bytes;
    while (this.#events.length - n > this.#maxEvents || (bytes > this.#maxBytes && this.#events.length - n > 1)) {
      bytes -= this.#sizes[n];
      n++;
    }
    if (n === 0) return;
    this.#events.splice(0, n);
    this.#sizes.splice(0, n);
    this.#bytes = bytes;
    this.#dropped += n;
  }

  #ingest(lines: string[]): TranscriptEvent[] {
    const fresh: TranscriptEvent[] = [];
    for (const line of lines) {
      const p = this.#parser.parseLine(line);
      if (!p.ok) {
        this.#malformed++;
        continue;
      }
      this.#records++;
      if (!p.known) this.#unknown++;
      if (p.uuid) this.#uuids.add(p.uuid);
      if (p.cwd && !p.isSidechain) {
        if (this.#lastCwd !== null && p.cwd !== this.#lastCwd) {
          fresh.push({ kind: "cwd_change", from: this.#lastCwd, to: p.cwd, uuid: p.uuid, timestamp: p.timestamp, isSidechain: false });
        }
        this.#lastCwd = p.cwd;
      }
      if (p.gitBranch && !p.isSidechain) this.#lastBranch = p.gitBranch;
      for (const e of p.events) fresh.push(e);
    }
    for (const e of fresh) this.#push(e);
    this.#trimWindow();
    return fresh;
  }
}
