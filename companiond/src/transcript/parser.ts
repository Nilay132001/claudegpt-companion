import type { TerminalFailure } from "./terminal.ts";
import { detectFailure } from "./terminal.ts";

export interface EventBase {
  /** Record `uuid`; the cursor key (spec §6.4). Null for records without one. */
  uuid: string | null;
  timestamp: string | null;
  isSidechain: boolean;
}

export type TranscriptEvent =
  | (EventBase & { kind: "user_text"; text: string })
  | (EventBase & { kind: "assistant_text"; text: string })
  | (EventBase & { kind: "tool_call"; toolUseId: string; name: string; inputPreview: string; command: string | null })
  | (EventBase & {
      kind: "tool_result";
      toolUseId: string;
      toolName: string | null;
      command: string | null;
      isError: boolean;
      /** Trimmed (TOOL_OUTPUT_MAX). Empty for non-Bash tools. */
      stdout: string;
      stderr: string;
      exitCode: number | null;
      interrupted: boolean;
      /** Trimmed text content of the tool result block. */
      text: string;
      failure: TerminalFailure | null;
    })
  | (EventBase & { kind: "file_edit"; toolUseId: string; tool: string; filePath: string })
  | (EventBase & { kind: "subagent_summary"; toolUseId: string; text: string })
  | (EventBase & { kind: "cwd_change"; from: string; to: string });

export type ParsedLine =
  | {
      ok: true;
      type: string;
      known: boolean;
      uuid: string | null;
      cwd: string | null;
      gitBranch: string | null;
      /** Sidechain (subagent) records never move the worktree candidate (spec §6.3). */
      isSidechain: boolean;
      timestamp: string | null;
      events: TranscriptEvent[];
    }
  | { ok: false };

export const TEXT_MAX = 20_000;
export const TOOL_OUTPUT_MAX = 4_000;
export const INPUT_PREVIEW_MAX = 500;
/** Only this many trailing characters of stdout/stderr reach detectFailure; failure lines are at the end. */
const DETECT_TAIL_MAX = 65_536;

/** Record types seen on disk (findings §4) that carry nothing for the context. */
const KNOWN_SILENT = new Set([
  "attachment",
  "custom-title",
  "agent-name",
  "last-prompt",
  "file-history-snapshot",
  "queue-operation",
  "summary",
  "system",
  "atis-latch",
  "tools-used",
  "file-history-delta",
  "bridge-session",
  "pr-link",
  "relocated",
  "cost-state",
  "mode",
  "isolation-latch",
  "worktree-state",
]);

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Keeps the head (¼) and tail (¾) of long text, with a marker between. Never splits a surrogate pair. */
export function trimText(s: string, max: number): string {
  if (s.length <= max) return s;
  let head = Math.floor(max / 4);
  let tailStart = s.length - (max - head);
  if (head > 0 && isHigh(s.charCodeAt(head - 1))) head--;
  if (tailStart < s.length && isLow(s.charCodeAt(tailStart))) tailStart++;
  return `${s.slice(0, head)}\n… [${tailStart - head} characters trimmed] …\n${s.slice(tailStart)}`;
}

/** The last `max` characters, without starting on a lone low surrogate. */
function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  let start = s.length - max;
  if (isLow(s.charCodeAt(start))) start++;
  return s.slice(start);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter((t) => t !== "")
    .join("\n");
}

/**
 * Stateful: remembers tool_use ids → name/command so results can be labelled.
 * One parser per transcript file; make a new one when the file is re-read from 0.
 */
export class TranscriptParser {
  #tools = new Map<string, { name: string; command: string | null }>();
  static readonly MAX_TOOLS = 5_000;

  parseLine(line: string): ParsedLine {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return { ok: false };
    }
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) return { ok: false };
    const r = rec as Record<string, unknown>;
    const type = str(r.type) ?? "";
    const base: EventBase = { uuid: str(r.uuid), timestamp: str(r.timestamp), isSidechain: r.isSidechain === true };
    const head = {
      ok: true as const,
      type,
      uuid: base.uuid,
      cwd: str(r.cwd),
      gitBranch: str(r.gitBranch),
      isSidechain: base.isSidechain,
      timestamp: base.timestamp,
    };
    if (type === "user") return { ...head, known: true, events: this.#user(r, base) };
    if (type === "assistant") return { ...head, known: true, events: this.#assistant(r, base) };
    return { ...head, known: KNOWN_SILENT.has(type) || type.startsWith("api-request"), events: [] };
  }

  #remember(id: string, name: string, command: string | null): void {
    if (this.#tools.size >= TranscriptParser.MAX_TOOLS) {
      const oldest = this.#tools.keys().next().value;
      if (oldest !== undefined) this.#tools.delete(oldest);
    }
    this.#tools.set(id, { name, command });
  }

  #assistant(r: Record<string, unknown>, base: EventBase): TranscriptEvent[] {
    const content = (r.message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") return content.trim() ? [{ ...base, kind: "assistant_text", text: trimText(content, TEXT_MAX) }] : [];
    if (!Array.isArray(content)) return [];
    const out: TranscriptEvent[] = [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({ ...base, kind: "assistant_text", text: trimText(b.text, TEXT_MAX) });
      } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
        const command = b.name === "Bash" ? str(input.command) : null;
        this.#remember(b.id, b.name, command);
        out.push({ ...base, kind: "tool_call", toolUseId: b.id, name: b.name, inputPreview: trimText(JSON.stringify(input), INPUT_PREVIEW_MAX), command });
        const filePath = str(input.file_path) ?? str(input.notebook_path);
        if (EDIT_TOOLS.has(b.name) && filePath) out.push({ ...base, kind: "file_edit", toolUseId: b.id, tool: b.name, filePath });
      }
      // "thinking" and unknown blocks are ignored on purpose.
    }
    return out;
  }

  #user(r: Record<string, unknown>, base: EventBase): TranscriptEvent[] {
    const content = (r.message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") {
      return content.trim() && r.isMeta !== true ? [{ ...base, kind: "user_text", text: trimText(content, TEXT_MAX) }] : [];
    }
    if (!Array.isArray(content)) return [];
    const out: TranscriptEvent[] = [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim() && r.isMeta !== true) {
        out.push({ ...base, kind: "user_text", text: trimText(b.text, TEXT_MAX) });
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        out.push(this.#toolResult(b, r.toolUseResult, base));
      }
    }
    return out;
  }

  #toolResult(b: Record<string, unknown>, tur: unknown, base: EventBase): TranscriptEvent {
    const id = b.tool_use_id as string;
    const tool = this.#tools.get(id) ?? null;
    const text = blockText(b.content);
    const isError = b.is_error === true;
    if (tool && SUBAGENT_TOOLS.has(tool.name)) {
      // Real results usually have no toolUseResult.content, so the block text is the fallback.
      const t = tur && typeof tur === "object" ? blockText((tur as { content?: unknown }).content) : "";
      return { ...base, kind: "subagent_summary", toolUseId: id, text: trimText(t || text, TOOL_OUTPUT_MAX) };
    }
    const res = (tur && typeof tur === "object" ? tur : {}) as Record<string, unknown>;
    const isBash = tool?.name === "Bash";
    const stdout = isBash ? (str(res.stdout) ?? "") : "";
    const stderr = isBash ? (str(res.stderr) ?? "") : "";
    // Real Bash results carry no exitCode key; the "Exit code N" text prefix is the source.
    let exitCode: number | null = typeof res.exitCode === "number" ? res.exitCode : null;
    if (exitCode === null && isBash) {
      const m = /^Exit code (\d+)/.exec(text);
      exitCode = m ? Number(m[1]) : isError ? null : 0;
    }
    const interrupted = res.interrupted === true;
    const failure = isBash
      ? detectFailure({
          exitCode,
          isError,
          stdout: tail(stdout, DETECT_TAIL_MAX),
          stderr: tail(stderr || (isError ? text : ""), DETECT_TAIL_MAX),
        })
      : null;
    return {
      ...base,
      kind: "tool_result",
      toolUseId: id,
      toolName: tool?.name ?? null,
      command: tool?.command ?? null,
      isError,
      stdout: trimText(stdout, TOOL_OUTPUT_MAX),
      stderr: trimText(stderr, TOOL_OUTPUT_MAX),
      exitCode,
      interrupted,
      text: trimText(text, TOOL_OUTPUT_MAX),
      failure,
    };
  }
}
