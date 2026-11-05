// Approved roots and sharing mode (spec §7.5). Provides M3's IsApproved.
import fs from "node:fs";
import path from "node:path";
import { LocateError, SafeGit, type RepoDirs } from "../git/safeGit.ts";
import type { ApprovedRoot, SharingMode, Store } from "../store/store.ts";
import type { IsApproved } from "../worktree/resolver.ts";

export interface RepoInspector { inspect(dir: string): Promise<RepoDirs> }
export type ApprovalRefusal = "not_absolute" | "missing" | "home_or_root" | "repo_refused" | "not_toplevel";

export class ApprovalRefusedError extends Error {
  readonly reason: ApprovalRefusal;
  constructor(reason: ApprovalRefusal, message: string) {
    super(message);
    this.name = "ApprovalRefusedError";
    this.reason = reason;
  }
}

/** SafeGit.locate runs the config gate and validates the dirs (M2); it throws LocateError otherwise. */
export function safeGitInspector(gitPath: string): RepoInspector {
  return { inspect: (dir) => SafeGit.locate({ gitPath, cwd: dir }) };
}

function refusalText(e: unknown): string {
  if (e instanceof LocateError) return e.kind === "refused" ? `Repository refused: ${e.reason}` : e.kind === "not_git" ? "That folder is not a Git repository." : "Git could not check that folder.";
  return e instanceof Error && e.message ? e.message : "That folder is not a Git repository.";
}

function real(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

export class Privacy {
  #store: Store;
  #inspector: RepoInspector;
  #home: string;
  #now: () => number;
  #cache: ApprovedRoot[];

  constructor(store: Store, inspector: RepoInspector, home: string, now: () => number = Date.now) {
    this.#store = store;
    this.#inspector = inspector;
    this.#home = real(home) ?? home;
    this.#now = now;
    this.#cache = store.listApprovals();
  }

  readonly isApproved: IsApproved = (root, gitCommonDir) => {
    const r = real(root) ?? root;
    const c = real(gitCommonDir) ?? gitCommonDir;
    if (this.#homeOrRoot(r)) return false; // a worktree at $HOME, / or above $HOME is never approved
    return this.#cache.some((a) => a.root === r || (a.includeWorktrees && a.commonDir === c));
  };

  approvals(): ApprovedRoot[] {
    return [...this.#cache];
  }

  async approve(dir: string, includeWorktrees: boolean): Promise<ApprovedRoot> {
    if (!path.isAbsolute(dir)) throw new ApprovalRefusedError("not_absolute", "Choose a full folder path.");
    const r = real(dir);
    if (!r) throw new ApprovalRefusedError("missing", "That folder does not exist.");
    if (this.#homeOrRoot(r)) {
      throw new ApprovalRefusedError("home_or_root", "Your home folder, / and folders that contain your home folder cannot be approved.");
    }
    let dirs: RepoDirs;
    try {
      dirs = await this.#inspector.inspect(r);
    } catch (e) {
      throw new ApprovalRefusedError("repo_refused", refusalText(e));
    }
    if (dirs.toplevel !== r) throw new ApprovalRefusedError("not_toplevel", "Approve the repository's top folder, not a folder inside it.");
    const a: ApprovedRoot = { root: r, commonDir: dirs.commonDir, includeWorktrees, approvedAt: this.#now() };
    this.#store.putApproval(a);
    this.#cache = this.#store.listApprovals();
    return a;
  }

  revoke(root: string): boolean {
    const removed = this.#store.deleteApproval(real(root) ?? root);
    this.#cache = this.#store.listApprovals();
    return removed;
  }

  /** `/`, $HOME, or a folder that contains $HOME (spec §7.5, Spec change 4). `r` is a real path. */
  #homeOrRoot(r: string): boolean {
    return r === "/" || r === this.#home || this.#home.startsWith(r.endsWith("/") ? r : `${r}/`);
  }

  sharingMode(): SharingMode {
    return this.#store.getSharingMode();
  }

  setSharingMode(m: SharingMode): void {
    this.#store.setSharingMode(m);
  }
}
