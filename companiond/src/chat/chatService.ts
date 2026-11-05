// Asking a question (spec §4): prepare (preview per sharing mode) → send → cursor advances on turn completed.
// Each send opens (or resumes) the session's thread with the root resolved and approved now, so a thread that
// CodexHost dropped (sign-in replaced every process, a failure, an eviction) is reopened at the next message (M4a
// "Interfaces for M4b"). A resume Codex refuses (for example the stale writer lock, spec §2) starts a new thread and
// the app is told (threadReplaced): GPT loses the old thread's history.
import { randomUUID } from "node:crypto";
import type { SessionsSnapshot } from "../bridge/sessionBridge.ts";
import type { HostEvent, HostState, RootBinding } from "../codex/codexHost.ts";
import { HostBusyError, HostNotReadyError, TurnBusyError } from "../codex/codexHost.ts";
import { RpcError } from "../codex/rpc.ts";
import { RepoRefusedError } from "../git/safeGit.ts";
import { redact } from "../jail/redactor.ts";
import type { LaunchSpec } from "../launch/seatbelt.ts";
import type { SharingMode, Store } from "../store/store.ts";
import type { SubagentUpdate } from "../transcript/subagents.ts";
import type { TranscriptEvent } from "../transcript/parser.ts";
import type { IsApproved, WorktreeResolution } from "../worktree/resolver.ts";
import {
  buildPreview, composeTurnText, eventsSince, SubagentTracker, type ContextCaps, type ContextPreview, type RepoLine,
} from "../context/contextBuilder.ts";

/** The CodexHost methods ChatService uses (M4a). */
export interface ChatHost {
  state(): HostState;
  openThread(threadId: string | null, binding: RootBinding | null): Promise<string>;
  closeThread(threadId: string): Promise<void>;
  startTurn(threadId: string, text: string): Promise<{ turnId: string }>;
  interrupt(threadId: string): Promise<void>;
  activeTurn(threadId: string): string | null;
  on(l: (e: HostEvent) => void): () => void;
}
/** The SessionBridge methods ChatService uses (M3). */
export interface ChatBridge {
  snapshot(): SessionsSnapshot;
  worktree(sessionId: string): WorktreeResolution | null;
  events(sessionId: string): readonly TranscriptEvent[];
  hasUuid(sessionId: string, uuid: string): boolean;
  liveBranch(sessionId: string): Promise<string | null>;
}
export interface Prepared {
  prepareId: string; sessionId: string; mode: SharingMode; preview: ContextPreview | null; needsConfirm: boolean; repo: RepoLine; repoNote: string | null;
  /** The session title exactly as it will be sent (redacted); null in Off, which sends no title. */
  sessionTitle: string | null;
}
export interface SentRecord { sessionId: string; threadId: string; turnId: string; contextBlock: string; question: string; sentAt: number }
/** A turn that ended without turn/completed (its process was replaced or failed). The cursor did not move. */
export interface AbandonedTurn { sessionId: string; threadId: string; turnId: string }
/** Codex refused to resume the stored thread; the conversation continues in a new one without the old history. */
export type ChatEvent = { type: "threadReplaced"; sessionId: string; threadId: string; reason: "resume_refused" };
export type ChatErrorReason = "unknown_session" | "empty_question" | "prepare_expired" | "prepare_stale" | "host_not_ready";

export class ChatError extends Error {
  readonly reason: ChatErrorReason;
  constructor(reason: ChatErrorReason, message: string) {
    super(message);
    this.name = "ChatError";
    this.reason = reason;
  }
}

export interface ChatServiceDeps {
  host: ChatHost;
  bridge: ChatBridge;
  store: Store;
  sharingMode: () => SharingMode;
  /** Privacy.isApproved: checked at bind time, because the bridge's resolution can be older than a revoke. */
  isApproved: IsApproved;
  launchFor: (root: string) => Promise<LaunchSpec>;
  now?: () => number;
  caps?: ContextCaps;
  prepareTtlMs?: number;
  newId?: () => string;
}

interface PreparedInternal extends Prepared { question: string; title: string; expiresAt: number }
interface Pending { sessionId: string; threadId: string; cursor: string | null; subagents: SubagentUpdate[]; repoNote: string | null }
interface Open { threadId: string; root: string | null }

const MAX_QUESTION = 20_000;
const MAX_SENT = 50;
const MAX_EARLY = 32;
const TRACKER_LABEL = "Subagent summary";

/** Failures that happen before a turn starts and leave the prepare reusable until it expires. */
const retryable = (e: unknown) =>
  e instanceof HostBusyError || e instanceof TurnBusyError || e instanceof HostNotReadyError || (e instanceof ChatError && e.reason === "host_not_ready");

/** The tracker's subagent updates whose preview item was sent: not removed by the user, not left out by the caps.
 * Tracker items come last, in `preview.subagents` order; each is matched by rendering that update alone. */
export function sentSubagents(preview: ContextPreview, removeIds: ReadonlySet<string>, caps?: ContextCaps): SubagentUpdate[] {
  const out: SubagentUpdate[] = [];
  let j = 0;
  for (const it of preview.items) {
    if (it.kind !== "subagent" || it.label !== TRACKER_LABEL) continue;
    while (j < preview.subagents.length) {
      const u = preview.subagents[j++];
      if (!u) continue;
      const alone = buildPreview({ events: [], hadCursor: false, cursorFound: false, subagents: [u], caps }).items[0];
      if (alone?.text === it.text) {
        if (!removeIds.has(it.id)) out.push(u);
        break;
      }
    }
  }
  return out;
}

export class ChatService {
  #d: ChatServiceDeps;
  #now: () => number;
  #prepared = new Map<string, PreparedInternal>();
  /** Prepares whose send is running: a second send of the same id is refused, a failed one can be retried. */
  #inFlight = new Set<string>();
  #pending = new Map<string, Pending>();
  /** turn/completed that arrived before turn/start answered (CodexHost emits it as it comes). */
  #early = new Map<string, string>();
  #repoNotes = new Map<string, string>();
  #subagents = new Map<string, SubagentTracker>();
  #sent = new Map<string, SentRecord[]>();
  #open = new Map<string, Open>();
  #closeAfterTurn = new Set<string>();
  /** One send at a time per session, so two first sends cannot open two threads. */
  #queues = new Map<string, Promise<unknown>>();
  #sending = new Set<string>();
  /** Stop pressed while turn/start was pending (CodexHost cannot interrupt then): sent right after it answers. */
  #interruptAfterStart = new Set<string>();
  /** Bumped by every approval revoke; a send that opened its thread across a revoke is aborted. */
  #revokeGen = 0;
  #listeners = new Set<(e: ChatEvent) => void>();

  constructor(d: ChatServiceDeps) {
    this.#d = d;
    this.#now = d.now ?? Date.now;
    d.host.on((e) => {
      if (e.type === "turnCompleted") this.#onTurnCompleted(e.threadId, e.turnId, e.status);
    });
  }

  on(l: (e: ChatEvent) => void): () => void {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  }

  noteRepoChange(sessionId: string, note: string): void {
    this.#repoNotes.set(sessionId, note);
  }

  noteSubagent(sessionId: string, u: SubagentUpdate): void {
    this.#tracker(sessionId).update(u);
  }

  /** Called first thing by privacy.revoke, before the bridge re-resolves and bound threads are closed. */
  noteRevoke(): void {
    this.#revokeGen++;
  }

  async prepare(sessionId: string, question: string): Promise<Prepared> {
    const q = question.trim();
    if (!q || q.length > MAX_QUESTION) throw new ChatError("empty_question", "Type a question first.");
    const s = this.#d.bridge.snapshot().sessions.find((x) => x.sessionId === sessionId);
    if (!s) throw new ChatError("unknown_session", "That Claude session is not available.");
    const mode = this.#d.sharingMode();
    const { line } = await this.#repo(sessionId);
    let preview: ContextPreview | null = null;
    if (mode !== "off") {
      const cursor = this.#d.store.getCursor(sessionId);
      const since = eventsSince(this.#d.bridge.events(sessionId), cursor, (uuid) => this.#d.bridge.hasUuid(sessionId, uuid));
      preview = buildPreview({ events: since.events, hadCursor: cursor !== null, cursorFound: since.cursorFound, subagents: this.#tracker(sessionId).pending(), caps: this.#d.caps });
    }
    // Off sends only the repository line (composeTurnText): the note waits for a mode that sends it.
    const repoNote = mode === "off" ? null : (this.#repoNotes.get(sessionId) ?? null);
    const sessionTitle = mode === "off" ? null : redact(s.title).text;
    const prepareId = (this.#d.newId ?? randomUUID)();
    const out: PreparedInternal = {
      prepareId, sessionId, mode, preview, repo: line, repoNote, sessionTitle, question: q, title: s.title,
      // Ask confirms every send that carries anything from the session; the title always does.
      needsConfirm: mode === "ask",
      expiresAt: this.#now() + (this.#d.prepareTtlMs ?? 10 * 60_000),
    };
    for (const [id, p] of this.#prepared) if (p.expiresAt < this.#now() && !this.#inFlight.has(id)) this.#prepared.delete(id);
    this.#prepared.set(prepareId, out);
    return { prepareId, sessionId, mode, preview, needsConfirm: out.needsConfirm, repo: line, repoNote, sessionTitle };
  }

  /** The prepare is used up only when the turn starts. After hostBusy, turnBusy or hostNotReady the same id can be
   * sent again until it expires; a changed sharing mode or approval makes it stale (prepare again). */
  async send(prepareId: string, removeItemIds: readonly string[]): Promise<{ threadId: string; turnId: string }> {
    const p = this.#prepared.get(prepareId);
    if (!p || p.expiresAt < this.#now()) {
      this.#prepared.delete(prepareId);
      throw new ChatError("prepare_expired", "That preview expired. Ask again.");
    }
    if (this.#inFlight.has(prepareId)) throw new TurnBusyError();
    if (this.#d.sharingMode() !== p.mode) {
      this.#prepared.delete(prepareId);
      throw new ChatError("prepare_stale", "Sharing changed. Ask again.");
    }
    if (this.#d.host.state().state !== "ready") throw new ChatError("host_not_ready", "Codex is not ready.");
    this.#inFlight.add(prepareId);
    try {
      const r = await this.#queued(p.sessionId, () => this.#send(p, new Set(removeItemIds)));
      this.#prepared.delete(prepareId);
      return r;
    } catch (e) {
      if (!retryable(e)) this.#prepared.delete(prepareId);
      throw e;
    } finally {
      this.#inFlight.delete(prepareId);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    if (this.#sending.has(sessionId)) this.#interruptAfterStart.add(sessionId);
    const threadId = this.#d.store.getThread(sessionId);
    if (threadId) await this.#d.host.interrupt(threadId);
  }

  sent(sessionId: string): SentRecord[] {
    return [...(this.#sent.get(sessionId) ?? [])];
  }

  /** Turns CodexHost no longer runs although no turn/completed came (sign-in replaced every process, the host
   * failed or stopped). They are dropped without moving the cursor; the daemon reports them to the app. */
  reconcile(): AbandonedTurn[] {
    const out: AbandonedTurn[] = [];
    for (const [turnId, p] of this.#pending) {
      if (this.#d.host.activeTurn(p.threadId) === turnId) continue;
      this.#pending.delete(turnId);
      this.#closeAfterTurn.delete(p.threadId);
      out.push({ sessionId: p.sessionId, threadId: p.threadId, turnId });
    }
    return out;
  }

  /** Thread end for a session that is gone (ruling I1: closeThread revokes its token). */
  async closeSession(sessionId: string): Promise<void> {
    const o = this.#open.get(sessionId);
    if (o) await this.#close(sessionId, o);
  }

  /** Closes every thread bound to a root (after an approval is revoked). They reopen with the next message. */
  async closeBound(): Promise<void> {
    const bound = [...this.#open].filter(([, o]) => o.root !== null);
    const results = await Promise.allSettled(bound.map(([sessionId, o]) => this.#close(sessionId, o)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) throw new AggregateError(failed.map((r) => r.reason), `${failed.length} of ${bound.length} threads did not close.`);
  }

  /** Root-bound threads still open (a deferred close waits for its turn to end). */
  boundThreadIds(): string[] {
    return [...this.#open.values()].filter((o) => o.root !== null).map((o) => o.threadId);
  }

  /** True while a thread this run opened is still open. */
  isOpen(threadId: string): boolean {
    for (const o of this.#open.values()) if (o.threadId === threadId) return true;
    return false;
  }

  /** Whether the prepare needs the owner's confirmation: null when the prepare is unknown (expired or never made). */
  needsConfirm(prepareId: string): boolean | null {
    return this.#prepared.get(prepareId)?.needsConfirm ?? null;
  }

  /** Sessions this run opened a thread for. */
  openSessions(): string[] {
    return [...this.#open.keys()];
  }

  async #send(p: PreparedInternal, removeIds: ReadonlySet<string>): Promise<{ threadId: string; turnId: string }> {
    const gen = this.#revokeGen;
    this.#sending.add(p.sessionId);
    try {
      const repo = await this.#repo(p.sessionId); // re-read: branch is live at each turn (spec §6.3)
      const { text, contextBlock } = composeTurnText({
        sessionTitle: p.title, repo: repo.line, repoNote: p.repoNote, preview: p.preview, removeIds, question: p.question,
      });
      const threadId = await this.#openThread(p.sessionId, repo.binding);
      // An approval was revoked, or the sharing mode changed, while this send waited, resolved or opened: the
      // binding may be for that root and the text was composed for the old mode. Nothing is sent.
      if (this.#revokeGen !== gen || this.#d.sharingMode() !== p.mode) {
        const o = this.#open.get(p.sessionId);
        if (o?.threadId === threadId) this.#open.delete(p.sessionId);
        await this.#d.host.closeThread(threadId).catch(() => undefined);
        throw new ChatError("prepare_stale", "Sharing or an approval changed. Ask again.");
      }
      const { turnId } = await this.#d.host.startTurn(threadId, text);
      const pending: Pending = {
        sessionId: p.sessionId, threadId, cursor: p.preview?.cursorAfter ?? null,
        subagents: p.preview ? sentSubagents(p.preview, removeIds, this.#d.caps) : [], repoNote: p.repoNote,
      };
      const list = this.#sent.get(p.sessionId) ?? [];
      list.push({ sessionId: p.sessionId, threadId, turnId, contextBlock, question: p.question, sentAt: this.#now() });
      this.#sent.set(p.sessionId, list.slice(-MAX_SENT));
      const early = this.#early.get(turnId);
      this.#pending.set(turnId, pending);
      if (early !== undefined) {
        this.#early.delete(turnId);
        this.#onTurnCompleted(threadId, turnId, early);
      }
      if (this.#interruptAfterStart.delete(p.sessionId)) void this.#d.host.interrupt(threadId).catch(() => undefined);
      return { threadId, turnId };
    } finally {
      this.#sending.delete(p.sessionId);
      this.#interruptAfterStart.delete(p.sessionId);
    }
  }

  #queued<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(sessionId) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.#queues.set(sessionId, tail);
    void tail.then(() => {
      if (this.#queues.get(sessionId) === tail) this.#queues.delete(sessionId);
    });
    return run;
  }

  async #close(sessionId: string, o: Open): Promise<void> {
    try {
      await this.#d.host.closeThread(o.threadId);
      if (this.#open.get(sessionId) === o) this.#open.delete(sessionId);
    } catch (e) {
      if (!(e instanceof TurnBusyError)) throw e;
      // A reply is running: stop it, then close when its turn/completed arrives.
      this.#closeAfterTurn.add(o.threadId);
      if (this.#sending.has(sessionId)) this.#interruptAfterStart.add(sessionId);
      await this.#d.host.interrupt(o.threadId);
    }
  }

  async #openThread(sessionId: string, binding: RootBinding | null): Promise<string> {
    const existing = this.#d.store.getThread(sessionId);
    let threadId: string;
    try {
      threadId = await this.#d.host.openThread(existing, binding);
    } catch (e) {
      // Only a JSON-RPC refusal of thread/resume starts a new thread (Codex lost it, or the stale writer lock of
      // spec §2: M4b keeps that gap and tells the app). Security failures, HostBusyError and TurnBusyError re-throw.
      if (!existing || !(e instanceof RpcError)) throw e;
      threadId = await this.#d.host.openThread(null, binding);
      this.#emit({ type: "threadReplaced", sessionId, threadId, reason: "resume_refused" });
    }
    if (threadId !== existing) this.#d.store.setThread(sessionId, threadId);
    this.#open.set(sessionId, { threadId, root: binding?.root ?? null });
    this.#closeAfterTurn.delete(threadId);
    return threadId;
  }

  async #repo(sessionId: string): Promise<{ line: RepoLine; binding: RootBinding | null }> {
    const r = this.#d.bridge.worktree(sessionId);
    if (!r) return { line: { state: "none", root: null, branch: null, detail: null }, binding: null };
    if (r.kind === "unavailable") return { line: { state: "unavailable", root: r.root, branch: null, detail: r.detail }, binding: null };
    // The bridge's resolution can predate a revoke: approval is checked again here, at bind time.
    if (!this.#d.isApproved(r.root, r.gitCommonDir)) {
      return { line: { state: "unavailable", root: r.root, branch: null, detail: "This repository is not approved." }, binding: null };
    }
    try {
      const launch = await this.#d.launchFor(r.root);
      const branch = await this.#d.bridge.liveBranch(sessionId);
      return { line: { state: "bound", root: r.root, branch, detail: null }, binding: { root: r.root, launch } };
    } catch (e) {
      const detail = e instanceof RepoRefusedError ? e.message : "Repository tools could not start.";
      return { line: { state: "unavailable", root: r.root, branch: null, detail }, binding: null };
    }
  }

  #tracker(sessionId: string): SubagentTracker {
    let t = this.#subagents.get(sessionId);
    if (!t) {
      t = new SubagentTracker();
      this.#subagents.set(sessionId, t);
    }
    return t;
  }

  /** True when `next` is at or before the stored cursor in the transcript: an older prepare must not move it back. */
  #behindCursor(sessionId: string, next: string): boolean {
    const cur = this.#d.store.getCursor(sessionId);
    if (!cur) return false;
    const evs = this.#d.bridge.events(sessionId);
    const ci = evs.findLastIndex((e) => e.uuid === cur);
    const ni = evs.findLastIndex((e) => e.uuid === next);
    return ci >= 0 && ni >= 0 && ni <= ci;
  }

  #emit(e: ChatEvent): void {
    for (const l of this.#listeners) {
      try {
        l(e);
      } catch {
        // a listener bug must not stop the others
      }
    }
  }

  #onTurnCompleted(threadId: string, turnId: string, status: string): void {
    if (this.#closeAfterTurn.delete(threadId)) {
      for (const [sessionId, o] of this.#open) {
        if (o.threadId === threadId) void this.#close(sessionId, o).catch(() => undefined);
      }
    }
    const p = this.#pending.get(turnId);
    if (!p) {
      this.#early.set(turnId, status);
      for (const k of this.#early.keys()) {
        if (this.#early.size <= MAX_EARLY) break;
        this.#early.delete(k);
      }
      return;
    }
    this.#pending.delete(turnId);
    if (status !== "completed") return; // spec §4.7: the cursor moves only when the turn completes
    if (p.cursor && !this.#behindCursor(p.sessionId, p.cursor)) this.#d.store.setCursor(p.sessionId, p.cursor);
    this.#tracker(p.sessionId).markSent(p.subagents);
    if (p.repoNote !== null && this.#repoNotes.get(p.sessionId) === p.repoNote) this.#repoNotes.delete(p.sessionId);
  }
}
