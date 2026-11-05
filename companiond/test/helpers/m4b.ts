// SYNTHETIC FIXTURE builders for M3 types used by M4b tests.
import type { SessionSummary } from "../../src/bridge/selection.ts";
import type { TranscriptEvent } from "../../src/transcript/parser.ts";
import type { WorktreeResolution } from "../../src/worktree/resolver.ts";

let n = 0;
const base = (uuid: string | null = `u-${++n}`) => ({ uuid, timestamp: null, isSidechain: false });

export const userText = (text: string, uuid?: string | null): TranscriptEvent => ({ ...base(uuid), kind: "user_text", text });
export const assistantText = (text: string, uuid?: string | null): TranscriptEvent => ({ ...base(uuid), kind: "assistant_text", text });
/** `text` alone (no stdout/stderr) is the shape M3's parser gives when toolUseResult has no stdout/stderr. */
export function bash(command: string, o: { stdout?: string; stderr?: string; text?: string; exitCode?: number; failure?: { kind: "test_failure" | "build_failure" | "command_failed"; summary: string } } = {}): TranscriptEvent {
  return {
    ...base(), kind: "tool_result", toolUseId: `t-${n}`, toolName: "Bash", command, isError: (o.exitCode ?? 0) !== 0,
    stdout: o.stdout ?? "", stderr: o.stderr ?? "", exitCode: o.exitCode ?? 0, interrupted: false, text: o.text ?? "", failure: o.failure ?? null,
  };
}
export const readResult = (): TranscriptEvent => ({
  ...base(), kind: "tool_result", toolUseId: `t-${n}`, toolName: "Read", command: null, isError: false,
  stdout: "", stderr: "", exitCode: null, interrupted: false, text: "SYNTHETIC FIXTURE file body", failure: null,
});
export const fileEdit = (filePath: string): TranscriptEvent => ({ ...base(), kind: "file_edit", toolUseId: `t-${n}`, tool: "Edit", filePath });

export function session(sessionId: string, title = "SYNTHETIC FIXTURE session"): SessionSummary {
  return {
    sessionId, cliSessionId: `cli-${sessionId}`, title, status: "idle", isArchived: false, lastFocusedAt: 1, lastActivityAt: 1,
    recordCwd: null, recordBranch: null, resolvedRoot: null, source: "desktop", transcriptPath: null, transcriptMissing: null,
  };
}

export function resolved(root: string): WorktreeResolution {
  return { kind: "resolved", root, gitDir: `${root}/.git`, gitCommonDir: `${root}/.git`, isLinkedWorktree: false, branch: "main", candidate: root, candidateSource: "transcript" };
}
