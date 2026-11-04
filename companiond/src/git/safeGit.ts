// SafeGit (spec §7.3): the only way any component runs git. Fixed argv, fixed env, no shell.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describeKeys, parseConfigList, programKeys } from "./configGate.ts";

// Fixed-size answers (config list, rev-parse, hash-object) get their own cap, so a small
// maxOutputBytes can never turn into a refusal.
const SMALL_CAP = 1024 * 1024;

export const SAFE_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
});

export const SAFE_GIT_FLAGS: readonly string[] = Object.freeze([
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "diff.external=",
  "-c", "core.pager=cat",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.excludesFile=/dev/null",
  "-c", "core.quotePath=false",
]);

export class RepoRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Repository refused: ${reason}`);
    this.name = "RepoRefusedError";
    this.reason = reason;
  }
}

export class GitError extends Error {
  readonly code: number | null; // git's exit code; null = timed out or killed
  constructor(message: string, code: number | null) {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}

export interface GitResult {
  stdout: Buffer;
  code: number | null;
  truncated: boolean;
}

export interface SafeGitOptions {
  root: string;
  gitPath: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RepoDirs {
  toplevel: string;
  gitDir: string;
  commonDir: string;
}

// Don't trust what git reports: a `.git` file can point anywhere, and these dirs become Seatbelt read
// rules. Allowed: <toplevel>/.git, or a linked worktree's <commonDir>/worktrees/<name> whose `gitdir`
// file points back at <toplevel>/.git.
export function validateRepoDirs(dirs: RepoDirs): void {
  const dotGit = path.join(dirs.toplevel, ".git");
  if (dirs.gitDir === dotGit && dirs.commonDir === dotGit) return;
  if (!dirs.gitDir.startsWith(path.join(dirs.commonDir, "worktrees") + path.sep)) {
    throw new RepoRefusedError("its .git points outside the repository");
  }
  let back: string;
  try {
    back = fs.realpathSync.native(fs.readFileSync(path.join(dirs.gitDir, "gitdir"), "utf8").trim());
  } catch {
    throw new RepoRefusedError("its worktree link cannot be checked");
  }
  if (back !== dotGit) throw new RepoRefusedError("its worktree link does not point back to it");
}

export type LocateErrorKind = "not_git" | "git_failed" | "refused";

export class LocateError extends Error {
  readonly kind: LocateErrorKind;
  readonly reason: string;
  constructor(kind: LocateErrorKind, reason: string) {
    super(`${kind}: ${reason}`);
    this.name = "LocateError";
    this.kind = kind;
    this.reason = reason;
  }
}

export class SafeGit {
  readonly root: string;
  readonly gitPath: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;

  private constructor(root: string, gitPath: string, timeoutMs: number, maxBytes: number) {
    this.root = root;
    this.gitPath = gitPath;
    this.#timeoutMs = timeoutMs;
    this.#maxBytes = maxBytes;
  }

  static async open(opts: SafeGitOptions): Promise<SafeGit> {
    if (!path.isAbsolute(opts.gitPath)) throw new Error("gitPath must be an absolute path");
    let root: string;
    try {
      root = fs.realpathSync.native(opts.root);
    } catch {
      throw new RepoRefusedError("folder not found");
    }
    const git = new SafeGit(root, opts.gitPath, opts.timeoutMs ?? 10_000, opts.maxOutputBytes ?? 4 * 1024 * 1024);
    let dirs: RepoDirs;
    try {
      await git.checkConfig();
      dirs = await git.repoDirs();
    } catch (e) {
      if (e instanceof RepoRefusedError) throw e;
      if (e instanceof GitError && e.code === null) throw e; // timed out: say so, do not call it a refusal
      throw new RepoRefusedError("not a git repository");
    }
    if (dirs.toplevel !== root) throw new RepoRefusedError("not the top level of a git repository");
    validateRepoDirs(dirs);
    return git;
  }

  // For M3's WorktreeResolver: the repo that contains `cwd` (any sub-folder). Gate first; never requires
  // cwd to be the toplevel. Exit 128 from git means "not a git repository".
  static async locate(opts: { gitPath: string; cwd: string; timeoutMs?: number }): Promise<RepoDirs> {
    if (!path.isAbsolute(opts.gitPath)) throw new Error("gitPath must be an absolute path");
    let cwd: string;
    try {
      cwd = fs.realpathSync.native(opts.cwd);
    } catch {
      throw new LocateError("not_git", "folder not found");
    }
    const git = new SafeGit(cwd, opts.gitPath, opts.timeoutMs ?? 10_000, SMALL_CAP);
    try {
      await git.checkConfig();
      const dirs = await git.repoDirs();
      validateRepoDirs(dirs);
      return dirs;
    } catch (e) {
      if (e instanceof RepoRefusedError) throw new LocateError("refused", e.reason);
      if (e instanceof GitError && e.code === 128) throw new LocateError("not_git", "not inside a git repository");
      throw new LocateError("git_failed", e instanceof Error ? e.message : "git failed");
    }
  }

  async branch(): Promise<string | null> {
    const head = await this.#run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], [0, 1], SMALL_CAP);
    if (head.code !== 0) return null;
    const sym = await this.#run(["symbolic-ref", "--short", "-q", "HEAD"], [0, 1], SMALL_CAP);
    const name = sym.stdout.toString("utf8").trim();
    if (sym.code === 0 && name !== "") return name;
    const short = await this.#run(["rev-parse", "--short", "HEAD"], [0], SMALL_CAP);
    return `detached@${short.stdout.toString("utf8").trim()}`;
  }

  async checkConfig(): Promise<void> {
    const r = await this.#spawnGit(["config", "--list", "--null", "--show-scope", "--no-includes"], SMALL_CAP);
    if (r.truncated) throw new RepoRefusedError("repository config is too large");
    if (r.code !== 0) throw new GitError(`git config failed (${r.code === null ? "timed out" : `exit ${r.code}`})`, r.code);
    const bad = programKeys(parseConfigList(r.stdout.toString("utf8")));
    if (bad.length > 0) throw new RepoRefusedError(`its git config can run programs (${describeKeys(bad)})`);
  }

  async repoDirs(): Promise<RepoDirs> {
    const r = await this.#run(
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
      [0],
      SMALL_CAP,
    );
    if (r.truncated) throw new GitError("git rev-parse output is too large", 0);
    const [toplevel, gitDir, commonDir] = r.stdout.toString("utf8").split("\n");
    if (!toplevel || !gitDir || !commonDir) throw new GitError("git rev-parse returned no paths", 0);
    return {
      toplevel: fs.realpathSync.native(toplevel),
      gitDir: fs.realpathSync.native(gitDir),
      commonDir: fs.realpathSync.native(commonDir),
    };
  }

  // Gate, then run with the safety flags. Tasks 4b and 5 add the public queries that call this.
  async #run(args: readonly string[], okCodes: readonly number[] = [0], cap = this.#maxBytes): Promise<GitResult> {
    await this.checkConfig();
    const r = await this.#spawnGit([...SAFE_GIT_FLAGS, ...args], cap);
    if (!r.truncated && (r.code === null || !okCodes.includes(r.code))) {
      throw new GitError(`git ${args[0]} failed (${r.code === null ? "timed out" : `exit ${r.code}`})`, r.code);
    }
    return r;
  }

  #spawnGit(args: readonly string[], cap: number): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, ["-C", this.root, ...args], {
        env: { ...SAFE_GIT_ENV },
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
        timeout: this.#timeoutMs,
        killSignal: "SIGKILL",
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      child.stdout.on("data", (c: Buffer) => {
        if (truncated) return;
        const room = cap - size;
        if (c.length > room) {
          chunks.push(c.subarray(0, room));
          size += room;
          truncated = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(c);
        size += c.length;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout: Buffer.concat(chunks), code, truncated }));
    });
  }
}
