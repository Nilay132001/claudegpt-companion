import type { ReadFs } from "../claude/readFs.ts";
import { LineBuffer } from "../lineBuffer.ts";

export type ResetReason = "truncated" | "replaced";

export type TailRead =
  | { kind: "missing" }
  | {
      kind: "data";
      /** Set when the file shrank, was replaced, or came back after missing: `lines` start from the top. */
      reset: ResetReason | null;
      lines: string[];
      /** True when more bytes are waiting than one poll reads (maxReadBytes). Poll again. */
      more: boolean;
    };

export interface TailOptions {
  maxLineBytes?: number;
  /** Bytes read per poll at most. */
  maxReadBytes?: number;
}

const CHUNK = 256 * 1024;

/**
 * Per-file byte offset + partial-line buffer (spec §6.4). Polling only: callers decide when to poll
 * (fs.watch hint, 2 s timer, manual refresh). Bytes after the last "\n" are buffered, never returned.
 *
 * Detects: size < offset (truncated), a new dev:ino at stat or at read time (replaced), and the file
 * coming back after being missing (replaced). Known limit: an in-place rewrite (same inode) to the same
 * or a larger size is not detected; the reader then sees only the bytes past its old offset.
 */
export class TranscriptTail {
  readonly path: string;
  readonly #fs: ReadFs;
  readonly #opts: TailOptions;
  #offset = 0;
  #identity: string | null = null;
  #wasMissing = false;
  #lines: LineBuffer;

  constructor(path: string, fs: ReadFs, opts: TailOptions = {}) {
    this.path = path;
    this.#fs = fs;
    this.#opts = opts;
    this.#lines = new LineBuffer({ maxLineBytes: opts.maxLineBytes });
  }

  get offset(): number {
    return this.#offset;
  }

  /** Counts since the last reset (a reset re-reads the file, so counts start again). */
  get stats(): { invalidUtf8Lines: number; oversizedLines: number } {
    return { invalidUtf8Lines: this.#lines.invalidUtf8Lines, oversizedLines: this.#lines.oversizedLines };
  }

  #restart(): void {
    this.#offset = 0;
    this.#identity = null;
    this.#lines = new LineBuffer({ maxLineBytes: this.#opts.maxLineBytes });
  }

  async poll(): Promise<TailRead> {
    let st;
    try {
      st = await this.#fs.stat(this.path);
    } catch {
      st = null;
    }
    if (st === null || !st.isFile()) {
      if (this.#identity !== null || this.#offset > 0) this.#wasMissing = true;
      this.#restart();
      return { kind: "missing" };
    }
    const identity = `${st.dev}:${st.ino}`;
    let reset: ResetReason | null = null;
    if (this.#wasMissing || (this.#identity !== null && identity !== this.#identity)) reset = "replaced";
    else if (st.size < this.#offset) reset = "truncated";
    this.#wasMissing = false;
    if (reset) this.#restart();
    this.#identity = identity;
    const budget = this.#opts.maxReadBytes ?? 8 * 1024 * 1024;
    const lines: string[] = [];
    let read = 0;
    let stalled = false;
    while (this.#offset < st.size && read < budget) {
      const want = Math.min(CHUNK, st.size - this.#offset, budget - read);
      let r;
      try {
        r = await this.#fs.readRange(this.path, this.#offset, want);
      } catch {
        // Deleted or unreadable between stat and read: the same as missing.
        this.#restart();
        this.#wasMissing = true;
        return { kind: "missing" };
      }
      if (`${r.dev}:${r.ino}` !== identity) {
        // Replaced between stat and read: drop what we have and start over on the next poll.
        this.#restart();
        return { kind: "data", reset: "replaced", lines: [], more: true };
      }
      if (r.buf.length === 0) {
        // The file shrank after stat, or the filesystem lied. Never report `more` for this: a caller
        // looping on `more` would spin. The next poll re-stats and sorts it out.
        stalled = true;
        break;
      }
      this.#offset += r.buf.length;
      read += r.buf.length;
      for (const l of this.#lines.push(r.buf)) lines.push(l);
    }
    return { kind: "data", reset, lines, more: !stalled && this.#offset < st.size };
  }
}
