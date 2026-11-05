// Method handlers and event wiring for the daemon API (M5 contract in protocol.ts and the M4b plan).
import type { BridgeEvent, SessionsSnapshot, SyncStatus } from "../bridge/sessionBridge.ts";
import { pickerGroups, type Selection } from "../bridge/selection.ts";
import { ChatError, type ChatBridge, type ChatHost, type ChatService, type Prepared } from "../chat/chatService.ts";
import { HostBusyError, HostNotReadyError, SecurityCheckError, TurnBusyError, type AuthState, type HostState, type JiraBinding } from "../codex/codexHost.ts";
import { RepoRefusedError } from "../git/safeGit.ts";
import { JiraInputError } from "../jira/credentials.ts";
import type { JiraService } from "../jira/jiraService.ts";
import { REDACTION_NOTICE } from "../jail/redactor.ts";
import { ApprovalRefusedError, type Privacy } from "../privacy/privacy.ts";
import { SHARING_MODES, StoreError, type SharingMode, type Store } from "../store/store.ts";
import type { WorktreeResolution } from "../worktree/resolver.ts";
import { DAEMON_PROTOCOL_VERSION, ErrorCodes, SECURITY_FAILED_PREFIX } from "./protocol.ts";
import { DaemonError, type MethodHandler } from "./server.ts";

export interface DaemonBridge extends ChatBridge {
  on(l: (e: BridgeEvent) => void): () => void;
  refresh(): Promise<SessionsSnapshot>;
  pin(sessionId: string | null): Selection;
  syncStatus(sessionId: string): SyncStatus;
  resolveNow(sessionId: string): Promise<WorktreeResolution | null>;
}
/** The CodexHost surface the daemon uses (M4a). clearSecurityStop is called only by host.acknowledgeSecurityStop. */
export interface DaemonHost extends ChatHost {
  start(): Promise<HostState>;
  stop(): Promise<void>;
  clearSecurityStop(): void;
  auth(): Promise<AuthState>;
  login(): Promise<{ authUrl: string }>;
  setJira(j: JiraBinding | null): void;
}
export interface DaemonDeps {
  host: DaemonHost; bridge: DaemonBridge; chat: ChatService; privacy: Privacy; store: Store; jira: JiraService; version: string; shutdown(): void;
  /** How long a thread bound to a revoked root may stay open before the host is restarted (default 30 s). */
  revokeDeadlineMs?: number;
  /** Short codes only (no messages, no paths); defaults to stderr. */
  log?: (code: string) => void;
}
const DEFAULT_REVOKE_DEADLINE_MS = 30_000;

export const ABANDONED_STATUS = "abandoned";
const ABANDONED_TEXT = "Codex restarted before this reply finished. Ask again.";

/** history.turns answers at most this much JSON; the oldest turns are left out until it fits. */
export const MAX_HISTORY_TURNS_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_LIMIT = 200;

/** Drops the oldest turns until the serialized response fits; one turn always fits under the store's field caps. */
export function capTurnsResponse<T extends { turns: unknown[] }>(r: T, maxBytes = MAX_HISTORY_TURNS_BYTES): T {
  let turns = r.turns;
  const size = (t: unknown[]) => Buffer.byteLength(JSON.stringify({ ...r, turns: t }), "utf8");
  if (size(turns) <= maxBytes) return r;
  // Per-turn sizes, then drop from the oldest end: one pass, no repeated serialization of the whole list.
  const base = size([]);
  const each = turns.map((t) => Buffer.byteLength(JSON.stringify(t), "utf8") + 1);
  let total = base + each.reduce((a, b) => a + b, 0);
  let start = 0;
  while (start < turns.length - 1 && total > maxBytes) total -= each[start++]!;
  turns = turns.slice(start);
  return { ...r, turns };
}

const invalid = (message: string) => new DaemonError(ErrorCodes.invalidParams, message);
function str(p: Record<string, unknown>, k: string, max = 4096): string {
  const v = p[k];
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw invalid(`${k} must be a non-empty string`);
  return v;
}
function strOrNull(p: Record<string, unknown>, k: string): string | null {
  if (p[k] === null) return null;
  return str(p, k);
}
function bool(p: Record<string, unknown>, k: string, fallback?: boolean): boolean {
  const v = p[k];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "boolean") throw invalid(`${k} must be true or false`);
  return v;
}
function strArray(p: Record<string, unknown>, k: string): string[] {
  const v = p[k] ?? [];
  if (!Array.isArray(v) || v.length > 200 || !v.every((x) => typeof x === "string")) throw invalid(`${k} must be a list of strings`);
  return v as string[];
}

export function isSecurityFailure(s: HostState): boolean {
  return s.state === "failed" && s.detail.startsWith(SECURITY_FAILED_PREFIX);
}

/** What chat.prepare sends to the app: the preview without the raw subagent updates and the cursor (daemon-only). */
export function wirePrepared(p: Prepared): unknown {
  if (!p.preview) return p;
  const { items, notes, omitted, bytes } = p.preview;
  return { ...p, preview: { items, notes, omitted, bytes } };
}

export function toDaemonError(e: unknown): DaemonError {
  if (e instanceof DaemonError) return e;
  if (e instanceof SecurityCheckError) return new DaemonError(ErrorCodes.securityCheckFailed, e.message);
  if (e instanceof HostNotReadyError) return new DaemonError(ErrorCodes.hostNotReady, e.message);
  if (e instanceof HostBusyError) return new DaemonError(ErrorCodes.hostBusy, e.message); // capacity: try again later
  if (e instanceof TurnBusyError) return new DaemonError(ErrorCodes.turnBusy, e.message);
  if (e instanceof RepoRefusedError) return new DaemonError(ErrorCodes.repoRefused, e.message);
  if (e instanceof ApprovalRefusedError) return new DaemonError(ErrorCodes.approvalRefused, e.message, { reason: e.reason });
  if (e instanceof StoreError) return new DaemonError(ErrorCodes.invalidParams, e.message);
  if (e instanceof ChatError) {
    const code = {
      unknown_session: ErrorCodes.unknownSession, empty_question: ErrorCodes.emptyQuestion, prepare_expired: ErrorCodes.prepareExpired,
      prepare_stale: ErrorCodes.prepareStale, host_not_ready: ErrorCodes.hostNotReady,
    }[e.reason];
    return new DaemonError(code, e.message);
  }
  return new DaemonError(ErrorCodes.internal, "companiond: internal error");
}

export function buildHandlers(d: DaemonDeps): Record<string, MethodHandler> {
  const reresolveAll = () => {
    for (const s of d.bridge.snapshot().sessions) void d.bridge.resolveNow(s.sessionId).catch(() => undefined);
  };
  const log = d.log ?? ((code: string) => { process.stderr.write(`companiond: ${code}\n`); });
  return {
    "daemon.hello": async (p) => {
      if (p.protocolVersion !== DAEMON_PROTOCOL_VERSION) throw new DaemonError(ErrorCodes.invalidRequest, `companiond speaks protocol ${DAEMON_PROTOCOL_VERSION}`);
      return { protocolVersion: DAEMON_PROTOCOL_VERSION, daemonVersion: d.version };
    },
    "daemon.shutdown": async () => {
      d.shutdown();
      return {};
    },
    "host.status": async () => d.host.state(),
    // Every "Security check failed" stop, latched or not, needs the owner's acknowledgement: a restart would re-run
    // the checks and could come back ready without it (spec §8). Latched stops are also refused by start() (M4a I-1).
    "host.restart": async () => {
      if (isSecurityFailure(d.host.state())) {
        throw new DaemonError(ErrorCodes.securityCheckFailed, "Acknowledge the security stop first.");
      }
      await d.host.stop();
      return d.host.start();
    },
    "host.acknowledgeSecurityStop": async () => {
      if (!isSecurityFailure(d.host.state())) throw new DaemonError(ErrorCodes.invalidRequest, "There is no security stop to acknowledge.");
      d.host.clearSecurityStop();
      return d.host.start();
    },
    "auth.status": async () => d.host.auth(),
    "auth.login": async () => d.host.login(),
    "sessions.snapshot": async () => d.bridge.snapshot(),
    "sessions.refresh": async () => d.bridge.refresh(),
    "sessions.pin": async (p) => {
      const id = strOrNull(p, "sessionId");
      const sel = d.bridge.pin(id);
      d.store.setPin(id);
      return sel;
    },
    "sessions.picker": async (p) => {
      const query = p.query === undefined ? undefined : str(p, "query", 200);
      return pickerGroups(d.bridge.snapshot().sessions, { query, includeArchived: bool(p, "includeArchived", false) });
    },
    "sessions.sync": async (p) => d.bridge.syncStatus(str(p, "sessionId")),
    "sessions.worktree": async (p) => d.bridge.worktree(str(p, "sessionId")),
    "privacy.get": async () => ({ sharingMode: d.privacy.sharingMode(), approvals: d.privacy.approvals(), redactionNotice: REDACTION_NOTICE }),
    "privacy.setSharingMode": async (p) => {
      const mode = str(p, "mode", 20) as SharingMode;
      if (!SHARING_MODES.includes(mode)) throw invalid("mode must be off, ask or automatic");
      d.privacy.setSharingMode(mode);
      return { sharingMode: mode };
    },
    "privacy.approve": async (p) => {
      const a = await d.privacy.approve(str(p, "root"), bool(p, "includeWorktrees"));
      reresolveAll();
      return a;
    },
    "privacy.revoke": async (p) => {
      // Order matters: from here on isApproved refuses the root at bind time; noteRevoke aborts a send already past
      // that check; the bridge re-resolves before the revoked root's threads close (they reopen with the next
      // message). A revoke that removed nothing changes nothing: no close, no timer.
      const revoked = d.privacy.revoke(str(p, "root"));
      if (!revoked) return { revoked, pendingClose: 0 };
      d.chat.noteRevoke();
      await Promise.all(d.bridge.snapshot().sessions.map((s) => d.bridge.resolveNow(s.sessionId).catch(() => null)));
      // Only threads whose root is no longer approved are closed; threads in other approved repos keep running.
      // closeRevoked tries every close and throws an AggregateError if any failed; its messages are not passed on.
      await d.chat.closeRevoked().catch(() => log("revoke_close_failed"));
      // The revoked threads that survived the close: only these are waited for (a thread opened later is not ours
      // to end, and a thread whose root is approved again by the deadline no longer needs ending).
      const stuck = d.chat.revokedThreadIds();
      const pendingClose = stuck.length;
      if (pendingClose > 0) {
        // A running reply keeps its thread (and relay grant) open until it ends. After the deadline the host is
        // restarted, the only public way to end a root's Codex process (CodexHost has no per-root stop).
        const timer = setTimeout(() => {
          const still = new Set(d.chat.revokedThreadIds());
          if (!stuck.some((id) => still.has(id))) return;
          // Do not race a host that is starting, or restart one that was stopped or failed on its own.
          if (d.host.state().state !== "ready") {
            log("revoke_restart_skipped");
            return;
          }
          log("revoke_forced_restart");
          void d.host.stop().then(() => d.host.start()).catch(() => log("revoke_restart_failed"));
        }, d.revokeDeadlineMs ?? DEFAULT_REVOKE_DEADLINE_MS);
        timer.unref();
      }
      return { revoked, pendingClose };
    },
    "chat.prepare": async (p) => wirePrepared(await d.chat.prepare(str(p, "sessionId"), str(p, "question", 20_000))),
    "chat.send": async (p) => {
      const prepareId = str(p, "prepareId", 200);
      const removeItemIds = strArray(p, "removeItemIds");
      const confirmed = bool(p, "confirmed", false);
      // Refused before ChatService sends, so the prepare stays usable for a confirmed send. Fails closed: the
      // answer comes from ChatService's own prepare record; if there is none, Ask mode still needs the flag.
      const needs = d.chat.needsConfirm(prepareId);
      if (!confirmed && (needs === true || (needs === null && d.privacy.sharingMode() === "ask"))) {
        throw new DaemonError(ErrorCodes.confirmRequired, "Confirm what will be shared before sending.");
      }
      return d.chat.send(prepareId, removeItemIds);
    },
    "chat.interrupt": async (p) => {
      await d.chat.interrupt(str(p, "sessionId"));
      return {};
    },
    "chat.sent": async (p) => d.chat.sent(str(p, "sessionId")),
    "chat.newChat": async (p) => {
      await d.chat.newChat(str(p, "sessionId"));
      return {};
    },
    "history.list": async () => {
      const currentThreads: Record<string, string> = {};
      for (const s of d.bridge.snapshot().sessions) {
        const t = d.store.getThread(s.sessionId);
        if (t) currentThreads[s.sessionId] = t;
      }
      return { chats: d.store.listChats(), currentThreads, enabled: d.store.historyEnabled() };
    },
    "history.turns": async (p) => {
      const hasThread = p.threadId !== undefined;
      const hasSession = p.sessionId !== undefined;
      if (hasThread === hasSession) throw invalid("give exactly one of threadId or sessionId");
      const limit = p.limit === undefined ? MAX_HISTORY_LIMIT : p.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
        throw invalid(`limit must be a whole number from 1 to ${MAX_HISTORY_LIMIT}`);
      }
      if (hasThread) {
        const threadId = str(p, "threadId");
        return capTurnsResponse({ threadId, turns: d.store.turnsForThread(threadId, limit) });
      }
      // The session's current chat: from memory when history is off, so "View what was sent" still works.
      return capTurnsResponse(d.chat.turns(str(p, "sessionId"), limit));
    },
    "history.clear": async (p) => {
      const threadId = strOrNull(p, "threadId");
      d.chat.forgetTurns(threadId);
      return { deleted: threadId === null ? d.store.deleteAllHistory() : d.store.deleteChat(threadId) };
    },
    "history.setEnabled": async (p) => {
      const enabled = bool(p, "enabled");
      d.store.setHistoryEnabled(enabled);
      return { enabled };
    },
    "jira.status": async () => d.jira.status(),
    "jira.configure": async (p) => {
      // Fixed messages only: the params hold the token.
      try {
        return d.jira.configure({ site: p.site, email: p.email, token: p.token });
      } catch (e) {
        if (e instanceof JiraInputError) throw invalid(e.message);
        throw new DaemonError(ErrorCodes.internal, "Jira could not be set up.");
      }
    },
    "jira.clear": async () => d.jira.clear(),
    "jira.check": async () => d.jira.check(),
    "settings.get": async (p) => ({ value: d.store.getUiSetting(str(p, "key", 80)) }),
    "settings.set": async (p) => {
      d.store.setUiSetting(str(p, "key", 80), typeof p.value === "string" ? p.value : "");
      return {};
    },
  };
}

export function wireEvents(d: DaemonDeps, notify: (method: string, params: unknown) => void): () => void {
  const offBridge = d.bridge.on((e) => {
    switch (e.type) {
      case "sessions": {
        // Thread end for sessions that are no longer listed.
        const listed = new Set(e.snapshot.sessions.map((s) => s.sessionId));
        for (const id of d.chat.openSessions()) if (!listed.has(id)) void d.chat.closeSession(id).catch(() => undefined);
        notify("sessions.changed", e.snapshot);
        return;
      }
      case "transcript":
        notify("session.transcript", { sessionId: e.sessionId, kind: e.batch.kind, dropped: e.batch.kind === "reset" ? e.batch.dropped : 0, stats: e.stats });
        return;
      case "subagent":
        d.chat.noteSubagent(e.sessionId, e.update);
        return;
      case "worktree":
        if (e.change) d.chat.noteRepoChange(e.sessionId, e.change.contextNote);
        notify("session.worktree", { sessionId: e.sessionId, resolution: e.resolution, change: e.change });
        return;
      case "sync_error":
        notify("session.syncError", { message: e.message });
        return;
    }
  });
  // A failure, a stop or a sign-in (every Codex process replaced, M4a N-2) ends running turns without
  // turn/completed: the app hears about them here; the next send reopens the thread.
  const reportAbandoned = () => {
    for (const a of d.chat.reconcile()) {
      notify("chat.turnCompleted", { sessionId: a.sessionId, threadId: a.threadId, turnId: a.turnId, status: ABANDONED_STATUS, error: ABANDONED_TEXT });
    }
  };
  const offHost = d.host.on((e) => {
    const sessionId = "threadId" in e && e.threadId ? d.store.sessionForThread(e.threadId) : null;
    switch (e.type) {
      case "host":
        notify("host.changed", e.state);
        reportAbandoned();
        return;
      case "auth":
        notify("auth.changed", e.auth);
        reportAbandoned();
        return;
      case "delta":
        notify("chat.delta", { sessionId, threadId: e.threadId, turnId: e.turnId, itemId: e.itemId, text: e.text });
        return;
      case "item":
        notify("chat.item", { sessionId, threadId: e.threadId, turnId: e.turnId, phase: e.phase, item: e.item });
        return;
      case "turnCompleted":
        notify("chat.turnCompleted", { sessionId, threadId: e.threadId, turnId: e.turnId, status: e.status, error: e.error });
        return;
      case "alert":
        notify("security.alert", { sessionId, threadId: e.threadId, turnId: e.turnId, kind: e.kind, detail: e.detail });
        // A process alert can come with no host or auth event after it (a failed re-read after sign-in).
        if (e.kind === "process") reportAbandoned();
        return;
    }
  });
  const offChat = d.chat.on((e) => {
    if (e.type === "threadReplaced") notify("chat.threadReplaced", { sessionId: e.sessionId, threadId: e.threadId, reason: e.reason });
  });
  return () => {
    offBridge();
    offHost();
    offChat();
  };
}
