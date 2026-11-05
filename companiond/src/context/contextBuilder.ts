// ContextBuilder (spec §4): delta since cursor → items → redact → clip → caps → preview → turn text.
// Redaction runs on whole fields before any clipping, so a cut never splits a secret out of its pattern.
// M3 detects failures; this file only formats them (ruling: spec §3 vs §14 resolved toward §14).
import { redact } from "../jail/redactor.ts";
import type { SubagentUpdate } from "../transcript/subagents.ts";
import type { TerminalFailure } from "../transcript/terminal.ts";
import type { TranscriptEvent } from "../transcript/parser.ts";

export interface ContextCaps { totalBytes: number; textChars: number; toolChars: number; maxItems: number }
export const DEFAULT_CAPS: ContextCaps = { totalBytes: 12 * 1024, textChars: 2000, toolChars: 1500, maxItems: 40 };

export type PreviewItemKind = "user" | "assistant" | "command" | "failure" | "file_edit" | "subagent" | "folder";
export interface PreviewItem { id: string; kind: PreviewItemKind; label: string; text: string; redactions: number }
export interface ContextPreview {
  items: PreviewItem[];
  notes: string[];
  omitted: number;
  /** Bytes of the notes and items exactly as composeTurnText emits them (after escaping). */
  bytes: number;
  cursorAfter: string | null;
  subagents: SubagentUpdate[];
}
export interface RepoLine { state: "bound" | "unavailable" | "none"; root: string | null; branch: string | null; detail: string | null }

export const CURSOR_RESET_NOTE = "Cursor reset: Claude's transcript was rewritten, so this context starts from the latest messages.";

/**
 * Bytes kept for what composeTurnText adds around the items: the wrapper tags, the session line, the
 * repository line, the repository note, and the "left out" note. Each of those is fitted to its share.
 */
const HEADER_BYTES = { title: 256, repo: 512, repoNote: 192 } as const;
const OMITTED_NOTE_BYTES = 96;
const OPEN_TAG = '<untrusted_data source="claude-session">';
const CLOSE_TAG = "</untrusted_data>";
const RESERVED_BYTES = OPEN_TAG.length + 1 + HEADER_BYTES.title + 1 + HEADER_BYTES.repo + 1 + HEADER_BYTES.repoNote + 1 + CLOSE_TAG.length + OMITTED_NOTE_BYTES;

type Cut = "head" | "tail";
/** One field before redaction. `max` is in characters; it is applied after redaction. */
interface Part { s: string; max: number; cut: Cut }
interface Draft { kind: PreviewItemKind; label: Part; text: Part[]; redacted: number }

const part = (s: string, max = Number.POSITIVE_INFINITY, cut: Cut = "head"): Part => ({ s, max, cut });
const MARKER = /\[REDACTED:[a-z-]+\]/g;

/** Keeps the head. A cut that would fall inside a [REDACTED:…] marker moves to the marker's start. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max - 1;
  for (const m of s.matchAll(MARKER)) {
    if (m.index >= cut) break;
    if (m.index + m[0].length > cut) {
      cut = m.index;
      break;
    }
  }
  return `${s.slice(0, cut)}…`;
}

/** Keeps the tail. A cut that would fall inside a marker moves to the marker's end. */
function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  let start = s.length - max + 1;
  for (const m of s.matchAll(MARKER)) {
    const end = m.index + m[0].length;
    if (m.index >= start) break;
    if (end > start) {
      start = end;
      break;
    }
  }
  return `…${s.slice(start)}`;
}

/**
 * M3 gives a rolling window (newest 2,000 events / ~8 MiB). `known` is bridge.hasUuid, which also covers
 * events that already left the window: then every event in the window is newer than the cursor.
 */
export function eventsSince(
  events: readonly TranscriptEvent[], cursor: string | null, known: (uuid: string) => boolean = () => false,
): { events: TranscriptEvent[]; cursorFound: boolean } {
  if (cursor === null) return { events: [...events], cursorFound: false };
  for (let k = events.length - 1; k >= 0; k--) {
    if (events[k]?.uuid === cursor) return { events: events.slice(k + 1), cursorFound: true };
  }
  return { events: [...events], cursorFound: known(cursor) };
}

/** `command` must already be redacted: it is clipped here. */
export function formatFailure(f: TerminalFailure, command: string | null, exitCode: number | null): string {
  const what = f.kind === "test_failure" ? "Tests failed" : f.kind === "build_failure" ? "Build failed" : "Command failed";
  return `${what}${command ? ` in \`${clip(command, 200)}\`` : ""}${exitCode !== null ? ` (exit ${exitCode})` : ""}: ${f.summary}`;
}

/** stdout/stderr when the parser split them; otherwise the result text minus its "Exit code N" line (M3 parser). */
function shellOutput(e: Extract<TranscriptEvent, { kind: "tool_result" }>, order: "err-first" | "out-first"): string {
  const parts = order === "err-first" ? [e.stderr, e.stdout] : [e.stdout, e.stderr];
  return parts.filter((s) => s.length > 0).join("\n") || e.text.replace(/^Exit code \d+\n?/, "");
}

function draft(e: TranscriptEvent, caps: ContextCaps): Draft | null {
  switch (e.kind) {
    case "user_text":
      return { kind: "user", label: part("Claude user message"), text: [part(e.text, caps.textChars)], redacted: 0 };
    case "assistant_text":
      return { kind: "assistant", label: part("Claude reply"), text: [part(e.text, caps.textChars)], redacted: 0 };
    case "tool_result": {
      if (e.failure) {
        const cmd = e.command === null ? null : redact(e.command);
        return {
          kind: "failure", label: part("Failure"), redacted: cmd?.count ?? 0,
          text: [part(formatFailure(e.failure, cmd?.text ?? null, e.exitCode)), part(shellOutput(e, "err-first"), caps.toolChars, "tail")],
        };
      }
      if (e.command) {
        return {
          kind: "command", label: part(`$ ${e.command}`, 122), redacted: 0,
          text: [part(`exit ${e.exitCode ?? "?"}`), part(shellOutput(e, "out-first"), caps.toolChars, "tail")],
        };
      }
      return null; // non-shell tool output is not sent: GPT reads the repo through the jail
    }
    case "file_edit":
      return { kind: "file_edit", label: part("Claude edited a file"), text: [part(e.filePath)], redacted: 0 };
    case "subagent_summary":
      return { kind: "subagent", label: part("Subagent result"), text: [part(e.text, caps.textChars)], redacted: 0 };
    case "cwd_change":
      return { kind: "folder", label: part("Claude changed folder"), text: [part(`${e.from} → ${e.to}`)], redacted: 0 };
    default:
      return null; // tool_call: its result carries the command
  }
}

/** Redact the whole field, then clip it. Returns the text and the number of redactions. */
function finish(p: Part): { text: string; count: number } {
  const r = redact(p.s);
  return { text: p.cut === "head" ? clip(r.text, p.max) : tail(r.text, p.max), count: r.count };
}

const itemBytes = (label: string, text: string) => Buffer.byteLength(`[${escapeData(label)}]\n${escapeData(text)}\n`, "utf8");
const noteBytes = (n: string) => Buffer.byteLength(`Note: ${escapeData(n)}\n`, "utf8");

export function buildPreview(input: {
  events: readonly TranscriptEvent[]; hadCursor: boolean; cursorFound: boolean; subagents?: readonly SubagentUpdate[]; caps?: ContextCaps;
}): ContextPreview {
  const caps = input.caps ?? DEFAULT_CAPS;
  const drafts: Array<{ kind: PreviewItemKind; label: string; text: string; redactions: number }> = [];
  const add = (d: Draft) => {
    const l = finish(d.label);
    const ts = d.text.map(finish);
    const text = ts.map((t) => t.text).filter((s) => s.length > 0).join("\n").trimEnd();
    drafts.push({ kind: d.kind, label: l.text, text, redactions: d.redacted + l.count + ts.reduce((n, t) => n + t.count, 0) });
  };
  for (const e of input.events) {
    if (e.isSidechain) continue;
    const d = draft(e, caps);
    if (d) add(d);
  }
  // Both a main-chain "Subagent result" (the final Task/Agent result) and a tracker "Subagent summary"
  // (progress read from the subagent's own file) can appear for one agent. They are kept on purpose:
  // M3 links neither to the other (toolUseId vs agentId), and they say different things.
  const subagents = [...(input.subagents ?? [])];
  for (const s of subagents) add({ kind: "subagent", label: part("Subagent summary"), text: [part(s.summary, caps.textChars)], redacted: 0 });

  const notes: string[] = [];
  if (input.hadCursor && !input.cursorFound) notes.push(CURSOR_RESET_NOTE);
  // The cap covers the whole block as sent (after escaping), so the header's share is reserved first.
  const budget = caps.totalBytes - RESERVED_BYTES - notes.reduce((n, s) => n + noteBytes(s), 0);
  const picked: typeof drafts = [];
  let bytes = 0;
  let omitted = 0;
  let stoppedBy: "items" | "bytes" | null = null;
  for (let i = drafts.length - 1; i >= 0; i--) {
    const d = drafts[i];
    if (!d) continue;
    const size = itemBytes(d.label, d.text);
    if (picked.length >= caps.maxItems || bytes + size > budget) {
      stoppedBy = picked.length >= caps.maxItems ? "items" : "bytes";
      omitted = i + 1;
      break;
    }
    picked.push(d);
    bytes += size;
  }
  picked.reverse();

  if (omitted > 0) {
    notes.push(stoppedBy === "items"
      ? `${omitted} older item(s) left out (${caps.maxItems}-item limit).`
      : `${omitted} older item(s) left out to stay under ${Math.round(caps.totalBytes / 1024)} KB.`);
  }
  bytes += notes.reduce((n, s) => n + noteBytes(s), 0);
  let cursorAfter: string | null = null;
  for (let k = input.events.length - 1; k >= 0 && cursorAfter === null; k--) cursorAfter = input.events[k]?.uuid ?? null;

  return {
    items: picked.map((d, n) => ({ id: `item-${n + 1}`, kind: d.kind, label: d.label, text: d.text, redactions: d.redactions })),
    notes,
    omitted,
    bytes,
    cursorAfter,
    subagents,
  };
}

export function escapeData(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

/** Fits an already-escaped line into `max` UTF-8 bytes without splitting a character, an entity or a marker. */
function fitBytes(line: string, max: number): string {
  if (Buffer.byteLength(line, "utf8") <= max) return line;
  let out = "";
  let used = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8");
    if (used + b > max - 3) break; // "…" is 3 bytes
    out += ch;
    used += b;
  }
  return `${out.replace(/&[a-z]{0,3}$/, "").replace(/\[REDACTED:[a-z-]*$/, "")}…`;
}

function repoText(r: RepoLine): string {
  if (r.state === "bound") return `Repository: ${r.root ?? "?"} (branch ${r.branch ?? "detached"}). Read it with the read-only repository tools.`;
  if (r.state === "unavailable") return `Repository: unavailable (${r.detail ?? "unknown reason"}). Repo tools are off.`;
  return "Repository: none for this session. Repo tools are off.";
}

/**
 * `preview: null` means sharing is Off: the block then carries only the repository line, so GPT can
 * use repo tools if the root is approved. Nothing from Claude's session, not even its title, is sent.
 */
export function composeTurnText(i: {
  sessionTitle: string; repo: RepoLine; repoNote: string | null; preview: ContextPreview | null; removeIds: ReadonlySet<string>; question: string;
}): { text: string; contextBlock: string } {
  const lines = [OPEN_TAG];
  if (i.preview) lines.push(fitBytes(`Claude session: ${escapeData(redact(i.sessionTitle).text)}`, HEADER_BYTES.title));
  lines.push(fitBytes(escapeData(repoText(i.repo)), HEADER_BYTES.repo));
  if (i.preview && i.repoNote) lines.push(fitBytes(`Note: ${escapeData(i.repoNote)}`, HEADER_BYTES.repoNote));
  for (const n of i.preview?.notes ?? []) lines.push(`Note: ${escapeData(n)}`);
  for (const it of i.preview?.items ?? []) {
    if (i.removeIds.has(it.id)) continue;
    lines.push(`[${escapeData(it.label)}]`, escapeData(it.text));
  }
  lines.push(CLOSE_TAG);
  const contextBlock = lines.join("\n");
  return { contextBlock, text: `${contextBlock}\n\nQuestion:\n${i.question}` };
}

export class SubagentTracker {
  #latest = new Map<string, SubagentUpdate>();
  #sent = new Map<string, number>();

  update(u: SubagentUpdate): void {
    this.#latest.set(u.agentId, u);
  }

  pending(): SubagentUpdate[] {
    return [...this.#latest.values()].filter((u) => this.#sent.get(u.agentId) !== u.records);
  }

  markSent(list: readonly SubagentUpdate[]): void {
    for (const u of list) this.#sent.set(u.agentId, u.records);
  }
}
