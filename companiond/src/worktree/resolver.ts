import path from "node:path";
import type { ReadFs } from "../claude/readFs.ts";
import { LocateError, RepoRefusedError, SafeGit } from "../git/safeGit.ts";

export type CandidateSource = "transcript" | "desktop_record";

export type UnavailableReason =
  | "no_cwd"
  | "path_missing"
  | "not_directory"
  | "not_git"
  | "git_failed"
  /** SafeGit's config gate refused the repo (program-valued git config, spec §7.3). */
  | "repo_refused"
  /** cwd is inside a work tree but is not its top level; we never widen to the parent. */
  | "not_worktree_root"
  | "not_approved";

export type WorktreeResolution =
  | {
      kind: "resolved";
      /** The bound root: the git toplevel, real path. */
      root: string;
      gitDir: string;
      gitCommonDir: string;
      /** True for a linked worktree (gitDir differs from gitCommonDir). */
      isLinkedWorktree: boolean;
      branch: string | null;
      candidate: string;
      candidateSource: CandidateSource;
    }
  | {
      kind: "unavailable";
      reason: UnavailableReason;
      /** Plain-language reason for the UI. */
      detail: string;
      candidate: string | null;
      candidateSource: CandidateSource | null;
      /** Filled when git answered (not_worktree_root, not_approved) so the UI can offer approval. */
      root: string | null;
      gitCommonDir: string | null;
    };

/** Approval lives in M4's Store/privacy model; the resolver only asks. */
export type IsApproved = (root: string, gitCommonDir: string) => boolean;

export interface ResolveInput {
  /** `cwd` of the latest main-chain transcript record that has one. */
  transcriptCwd: string | null;
  /** The desktop record's `cwd`; used only before the transcript has any. */
  recordCwd: string | null;
}

export interface ResolveDeps {
  fs: ReadFs;
  /** Absolute git path: M4 passes discoverToolchain().gitPath (M2); tests pass testGitPath(). */
  gitPath: string;
  isApproved: IsApproved;
}

/**
 * Spec §6.3. stat/realpath through ReadFs → SafeGit.locate (config gate, then rev-parse) → the candidate's
 * real path must equal the toplevel → approved → SafeGit.open(toplevel) + branch(). Any failure is
 * Unavailable with a reason. Never falls back to another root. M3 never runs git itself.
 */
export async function resolveWorktree(input: ResolveInput, deps: ResolveDeps): Promise<WorktreeResolution> {
  const transcriptCwd = input.transcriptCwd === "" ? null : input.transcriptCwd;
  const recordCwd = input.recordCwd === "" ? null : input.recordCwd;
  const candidate = transcriptCwd ?? recordCwd;
  const candidateSource: CandidateSource | null = transcriptCwd !== null ? "transcript" : recordCwd !== null ? "desktop_record" : null;
  const unavailable = (reason: UnavailableReason, detail: string, root: string | null = null, gitCommonDir: string | null = null): WorktreeResolution => ({
    kind: "unavailable",
    reason,
    detail,
    candidate,
    candidateSource,
    root,
    gitCommonDir,
  });
  if (candidate === null || candidateSource === null) return unavailable("no_cwd", "Claude has not reported a working folder yet");
  // A relative path would be resolved against the daemon's own cwd and could bind an unrelated root.
  if (!path.isAbsolute(candidate)) return unavailable("path_missing", "Path is not absolute");
  let real: string;
  try {
    const st = await deps.fs.stat(candidate);
    if (!st.isDirectory()) return unavailable("not_directory", "Claude's working folder is not a folder");
    real = await deps.fs.realpath(candidate);
  } catch {
    return unavailable("path_missing", "Claude's working folder no longer exists");
  }
  let dirs;
  try {
    dirs = await SafeGit.locate({ gitPath: deps.gitPath, cwd: real });
  } catch (err) {
    if (err instanceof LocateError) {
      if (err.kind === "refused") return unavailable("repo_refused", `Repository refused: ${err.reason}`);
      if (err.kind === "not_git") return unavailable("not_git", "Claude's working folder is not a Git repository");
    }
    // Fixed text: an error message could contain the git path or the folder.
    return unavailable("git_failed", "git could not read this folder");
  }
  if (dirs.toplevel !== real) {
    return unavailable("not_worktree_root", "Claude's working folder is inside a repository but is not its top folder", dirs.toplevel, dirs.commonDir);
  }
  if (!deps.isApproved(dirs.toplevel, dirs.commonDir)) return unavailable("not_approved", "This repository is not approved yet", dirs.toplevel, dirs.commonDir);
  let branch: string | null;
  try {
    const git = await SafeGit.open({ root: dirs.toplevel, gitPath: deps.gitPath });
    branch = await git.branch();
  } catch (err) {
    if (err instanceof RepoRefusedError) return unavailable("repo_refused", `Repository refused: ${err.reason}`, dirs.toplevel, dirs.commonDir);
    // GitError, a spawn failure or anything else: fixed text, never the error message.
    return unavailable("git_failed", "git could not read this repository", dirs.toplevel, dirs.commonDir);
  }
  return {
    kind: "resolved",
    root: dirs.toplevel,
    gitDir: dirs.gitDir,
    gitCommonDir: dirs.commonDir,
    isLinkedWorktree: dirs.gitDir !== dirs.commonDir,
    branch,
    candidate,
    candidateSource,
  };
}

export interface RepoChange {
  from: string | null;
  to: string | null;
  /** Banner text (spec §6.3). */
  banner: string;
  /** Line for the next turn's context block (spec §6.3). */
  contextNote: string;
}

// For not_worktree_root, `root` is the parent repo; naming it would present the silent widening §6.3 forbids.
const where = (r: WorktreeResolution): string | null =>
  r.kind === "resolved" ? r.root : r.reason === "not_worktree_root" ? r.candidate : (r.root ?? r.candidate);
const state = (r: WorktreeResolution): string => (r.kind === "resolved" ? "resolved" : `unavailable:${r.reason}`);

/** Non-null when the session moved, or its repository changed state (e.g. became refused). Never silent (spec §6.3). */
export function describeChange(prev: WorktreeResolution | null, next: WorktreeResolution): RepoChange | null {
  if (prev === null) return null;
  const from = where(prev);
  const to = where(next);
  if (from === to && state(prev) === state(next)) return null;
  const label = next.kind === "resolved" ? `${next.root} (${next.branch ?? "unknown branch"})` : `${to ?? "an unknown folder"} — unavailable: ${next.detail}`;
  const contextNote =
    from === to
      ? `Repository ${to ?? "none"} is now ${next.kind === "resolved" ? "available" : "unavailable"}`
      : `Repository changed from ${from ?? "none"} to ${to ?? "none"}${next.kind === "unavailable" ? ` — unavailable: ${next.detail}` : ""}`;
  return { from, to, banner: `Claude is now in ${label}`, contextNote };
}
