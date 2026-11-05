// The SwiftUI app ↔ companiond contract (M5): JSON-RPC 2.0, one JSON object per line, over the child's stdio.
export const DAEMON_PROTOCOL_VERSION = 1;

export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  securityCheckFailed: 1001,
  hostNotReady: 1002,
  repoRefused: 1003,
  prepareExpired: 1004,
  turnBusy: 1005,
  approvalRefused: 1006,
  unknownSession: 1007,
  emptyQuestion: 1008,
  hostBusy: 1009,
  prepareStale: 1010,
  confirmRequired: 1011,
} as const;

/** HostState.failed.detail starts with this when the app must show "Security check failed" and wait for the
 * owner's acknowledgement (host.acknowledgeSecurityStop) before Codex may start again. */
export const SECURITY_FAILED_PREFIX = "Security check failed";

export const METHODS = [
  "daemon.hello", "daemon.shutdown",
  "host.status", "host.restart", "host.acknowledgeSecurityStop",
  "auth.status", "auth.login",
  "sessions.snapshot", "sessions.refresh", "sessions.pin", "sessions.picker", "sessions.sync", "sessions.worktree",
  "privacy.get", "privacy.setSharingMode", "privacy.approve", "privacy.revoke",
  "chat.prepare", "chat.send", "chat.interrupt", "chat.sent",
  "settings.get", "settings.set",
  "jira.status", "jira.configure", "jira.clear", "jira.check",
] as const;

export const EVENTS = [
  "host.changed", "auth.changed",
  "sessions.changed", "session.transcript", "session.worktree", "session.syncError",
  "chat.delta", "chat.item", "chat.turnCompleted", "chat.threadReplaced",
  "security.alert",
] as const;
