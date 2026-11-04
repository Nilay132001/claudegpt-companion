// SafeGit (spec §7.3): the only way any component runs git. Fixed argv, fixed env, no shell.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describeKeys, parseConfigList, programKeys, repoShapeKeys } from "./configGate.ts";
import { denyPathspecs } from "../jail/denyList.ts";

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
  readonly code: number | null; // git's exit code; null = timed out, killed, or could not start
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
// rules. Allowed: <toplevel>/.git, or a linked worktree's <commonDir>/worktrees/<name> (exactly one
// segment below, with commonDir named `.git`) whose `gitdir` file points back at <toplevel>/.git.
// A relative `gitdir` (worktree.useRelativePaths) is relative to the worktree's git dir, never to cwd.
export function validateRepoDirs(dirs: RepoDirs): void {
  const dotGit = path.join(dirs.toplevel, ".git");
  if (dirs.gitDir === dotGit && dirs.commonDir === dotGit) return;
  if (path.basename(dirs.commonDir) !== ".git" || path.dirname(dirs.gitDir) !== path.join(dirs.commonDir, "worktrees")) {
    throw new RepoRefusedError("its .git points outside the repository");
  }
  let back: string;
  try {
    back = fs.realpathSync.native(path.resolve(dirs.gitDir, fs.readFileSync(path.join(dirs.gitDir, "gitdir"), "utf8").trim()));
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

export interface StatusEntry {
  code: string;
  path: string;
}

export interface StatusResult {
  branch: string;
  entries: StatusEntry[];
  truncated: boolean;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

// `git status --porcelain=v1 -z --branch --no-renames`: "## <branch>\0" then "XY <path>\0" per entry.
export function parseStatusZ(out: string): { branch: string; entries: StatusEntry[] } {
  let branch = "";
  const entries: StatusEntry[] = [];
  for (const p of out.split("\0")) {
    if (p.startsWith("## ")) branch = p.slice(3);
    else if (p.length >= 4) entries.push({ code: p.slice(0, 2), path: p.slice(3) });
  }
  return { branch, entries };
}

// `git grep -z -n`: "<path>\0<line>:<text>\n" (some versions print "\0" after the line number too).
export function parseGrepZ(out: string): GrepHit[] {
  const hits: GrepHit[] = [];
  // A tokenizer, not a line split: -z prints raw file names, which may contain "\n".
  let pos = 0;
  while (pos < out.length) {
    const a = out.indexOf("\0", pos);
    if (a < 0) break;
    const m = out.slice(a + 1).match(/^(\d+)[:\0]/); // match, not RegExp exec: the no-writes scan bans that call name
    if (!m) break;
    const textStart = a + 1 + m[0].length;
    const nl = out.indexOf("\n", textStart);
    const end = nl < 0 ? out.length : nl;
    hits.push({ path: out.slice(pos, a), line: Number(m[1]), text: out.slice(textStart, end) });
    pos = end + 1;
  }
  return hits;
}

export class SafeGit {
  readonly root: string;
  readonly gitPath: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  #opened: RepoDirs | null = null; // set once open() has validated the dirs

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
      dirs = await git.repoDirs(); // gate first, then rev-parse
    } catch (e) {
      if (e instanceof RepoRefusedError) throw e;
      if (e instanceof GitError && e.code === null) throw e; // timed out or could not start: say so, do not call it a refusal
      throw new RepoRefusedError("not a git repository");
    }
    if (dirs.toplevel !== root) throw new RepoRefusedError("not the top level of a git repository");
    validateRepoDirs(dirs);
    git.#opened = dirs;
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
      const dirs = await git.repoDirs(); // gate first, then rev-parse
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
    const entries = parseConfigList(r.stdout.toString("utf8"));
    const bad = programKeys(entries);
    if (bad.length > 0) throw new RepoRefusedError(`its git config can run programs (${describeKeys(bad)})`);
    const shape = repoShapeKeys(entries);
    if (shape.length > 0) throw new RepoRefusedError(`its git config moves the work tree (${describeKeys(shape)})`);
  }

  // Gate, then the dirs as git reports them now. Once open, they must still be the dirs captured at open:
  // a `.git` swapped afterwards for a link to another repo is refused before git reads anything there.
  async repoDirs(): Promise<RepoDirs> {
    await this.checkConfig();
    return this.#currentDirs();
  }

  async #currentDirs(): Promise<RepoDirs> {
    const r = await this.#spawnGit(
      [...SAFE_GIT_FLAGS, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
      SMALL_CAP,
    );
    if (r.truncated) throw new GitError("git rev-parse output is too large", 0);
    if (r.code !== 0) throw new GitError(`git rev-parse failed (${r.code === null ? "timed out" : `exit ${r.code}`})`, r.code);
    const [toplevel, gitDir, commonDir] = r.stdout.toString("utf8").split("\n");
    if (!toplevel || !gitDir || !commonDir) throw new GitError("git rev-parse returned no paths", 0);
    const dirs = {
      toplevel: fs.realpathSync.native(toplevel),
      gitDir: fs.realpathSync.native(gitDir),
      commonDir: fs.realpathSync.native(commonDir),
    };
    const was = this.#opened;
    if (was && (dirs.toplevel !== was.toplevel || dirs.gitDir !== was.gitDir || dirs.commonDir !== was.commonDir)) {
      throw new RepoRefusedError("its .git changed after it was opened");
    }
    return dirs;
  }

  async status(): Promise<StatusResult> {
    const r = await this.#run([
      "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=all", "--no-renames",
      "--", ...denyPathspecs(),
    ]);
    const parsed = parseStatusZ(r.stdout.toString("utf8"));
    if (r.truncated) parsed.entries.pop(); // the last entry may be cut off
    return { ...parsed, truncated: r.truncated };
  }

  async diffNames(): Promise<{ names: string[]; truncated: boolean }> {
    const base = await this.#base();
    const r = await this.#run([
      "diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-renames", base, "--",
      ...denyPathspecs(),
    ]);
    const parts = r.stdout.toString("utf8").split("\0");
    if (r.truncated) parts.pop(); // the last name may be cut off
    return { names: parts.filter((p) => p.length > 0), truncated: r.truncated };
  }

  async diff(paths: readonly string[]): Promise<{ text: string; truncated: boolean }> {
    if (paths.length === 0) return { text: "", truncated: false };
    if (paths.some((p) => p === "")) throw new Error("diff paths must not be empty"); // `:(literal)` alone matches everything
    const base = await this.#base();
    const r = await this.#run([
      "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all", "--no-renames", base, "--",
      ...paths.map((p) => `:(literal)${p}`),
      ...denyPathspecs(),
    ]);
    return { text: r.stdout.toString("utf8"), truncated: r.truncated };
  }

  async grep(query: string): Promise<{ hits: GrepHit[]; truncated: boolean }> {
    const r = await this.#run(
      ["grep", "-z", "-n", "-I", "-F", "--untracked", "--no-color", "-e", query, "--", ".", ...denyPathspecs()],
      [0, 1],
    );
    const hits = r.code === 1 ? [] : parseGrepZ(r.stdout.toString("utf8"));
    if (r.truncated) hits.pop(); // the last hit may be cut off
    return { hits, truncated: r.truncated };
  }

  // HEAD, or the empty tree when HEAD is unborn (no commits yet).
  async #base(): Promise<string> {
    const head = await this.#run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], [0, 1], SMALL_CAP);
    if (head.code === 0) return "HEAD";
    const empty = await this.#run(["hash-object", "-t", "tree", "/dev/null"], [0], SMALL_CAP);
    return empty.stdout.toString("utf8").trim();
  }

  // Gate (config, then the repo dirs against those captured at open), then run with the safety flags.
  async #run(args: readonly string[], okCodes: readonly number[] = [0], cap = this.#maxBytes): Promise<GitResult> {
    await this.repoDirs();
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
      // A git that cannot start (missing, not executable) is a GitError, not "not a git repository".
      child.on("error", (e: NodeJS.ErrnoException) => reject(new GitError(`git could not start (${e.code ?? "error"})`, null)));
      child.on("close", (code) => resolve({ stdout: Buffer.concat(chunks), code, truncated }));
    });
  }
}
