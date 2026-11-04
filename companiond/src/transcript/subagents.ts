import path from "node:path";
import type { ReadFs } from "../claude/readFs.ts";
import { trimText } from "./parser.ts";
import { TranscriptReader } from "./reader.ts";

export interface SubagentUpdate {
  /** File name without `.jsonl`. */
  agentId: string;
  /** Latest assistant text of that subagent, trimmed. Only this enters context (spec §6.4). */
  summary: string;
  records: number;
}

export const SUBAGENT_SUMMARY_MAX = 2_000;

/** Window per subagent reader: only the latest assistant text is used, so a small window suffices. */
export const SUBAGENT_WINDOW = { maxEvents: 20, maxEventBytes: 256 * 1024 } as const;

/** `<transcript dir>/<cliSessionId>/subagents/` for a transcript path. */
export function subagentDir(transcriptPath: string): string {
  return path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"), "subagents");
}

/** Tails every `*.jsonl` under a session's subagents folder with the same reader as the main transcript. */
export class SubagentTails {
  readonly dir: string;
  readonly #fs: ReadFs;
  readonly #readers = new Map<string, TranscriptReader>();
  readonly #last = new Map<string, string>();

  constructor(transcriptPath: string, fs: ReadFs) {
    this.dir = subagentDir(transcriptPath);
    this.#fs = fs;
  }

  /** Number of subagent files currently tailed. */
  get size(): number {
    return this.#readers.size;
  }

  async poll(): Promise<SubagentUpdate[]> {
    let names: string[] = [];
    try {
      names = await this.#fs.readdir(this.dir);
    } catch {
      names = [];
    }
    const listed = names.filter((n) => /^[A-Za-z0-9_-]+\.jsonl$/.test(n)).sort();
    // Files no longer listed take their reader and last summary with them.
    const keep = new Set(listed);
    for (const n of [...this.#readers.keys()]) if (!keep.has(n)) this.#readers.delete(n);
    for (const n of [...this.#last.keys()]) if (!keep.has(n)) this.#last.delete(n);
    const updates: SubagentUpdate[] = [];
    for (const name of listed) {
      let reader = this.#readers.get(name);
      if (!reader) {
        reader = new TranscriptReader(path.join(this.dir, name), this.#fs, SUBAGENT_WINDOW);
        this.#readers.set(name, reader);
      }
      let batch;
      try {
        batch = await reader.poll();
      } catch {
        // Unreadable subagent file: drop its reader; the next poll starts it again.
        this.#readers.delete(name);
        continue;
      }
      if (batch === null || batch.kind === "missing") continue;
      const texts = reader.events.filter((e) => e.kind === "assistant_text");
      const latest = texts.length ? trimText(texts[texts.length - 1].text, SUBAGENT_SUMMARY_MAX) : "";
      if (latest === "" || this.#last.get(name) === latest) continue;
      this.#last.set(name, latest);
      updates.push({ agentId: name.slice(0, -6), summary: latest, records: reader.stats.records });
    }
    return updates;
  }
}
