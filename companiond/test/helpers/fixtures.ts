// Test-only helpers. Every fixture is synthetic and lives in a fresh temp dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ClaudePaths } from "../../src/claude/paths.ts";
import { encodeCwd } from "../../src/claude/paths.ts";

export const MARK = "SYNTHETIC FIXTURE";

const made: string[] = [];

export function tempDir(prefix = "cgc-"): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
}

export function removeTempDirs(): void {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

export function put(root: string, rel: string, body = ""): string {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${MARK}\n${body}`);
  return f;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Deterministic pseudo-random base64, so a SYNTHETIC key body looks like a real one. */
function b64(n: number, seed: number): string {
  let x = seed >>> 0;
  let s = "";
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += B64[(x >>> 16) & 63];
  }
  return s;
}
/** A SYNTHETIC PEM body (no header): full 64-char lines and a short padded last line. */
export function pemBody(lines: number, seed: number): string[] {
  return [...Array.from({ length: lines }, (_, i) => b64(64, seed + i)), `${b64(22, seed + lines)}==`];
}

let cachedGit: string | null = null;

export function testGitPath(): string {
  if (cachedGit === null) {
    cachedGit =
      process.platform === "darwin"
        ? fs.realpathSync.native(execFileSync("/usr/bin/xcrun", ["-f", "git"], { encoding: "utf8" }).trim())
        : "/usr/bin/git";
  }
  return cachedGit;
}

// Fixture setup only (outside the jail). Never used by product code.
export function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync(
    testGitPath(),
    [
      "-c", "user.name=Fixture", "-c", "user.email=fixture.invalid", "-c", "init.defaultBranch=main",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
}

export function makeRepo(files: Record<string, string> = {}): string {
  const root = tempDir("cgc-repo-");
  fixtureGit(root, ["init", "-q"]);
  put(root, "README.md", "fixture repo\n");
  for (const [rel, body] of Object.entries(files)) put(root, rel, body);
  fixtureGit(root, ["add", "."]);
  fixtureGit(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

export function makeWorktree(main: string, branch = "wt"): string {
  const dir = path.join(tempDir("cgc-wt-"), branch);
  fixtureGit(main, ["worktree", "add", "-q", "-b", branch, dir]);
  return fs.realpathSync.native(dir);
}

// An executable "git" that blocks far longer than any test timeout, so timeout tests never race a fast git.
export function slowGitPath(): string {
  const script = path.join(tempDir("cgc-slowgit-"), "git");
  fs.writeFileSync(script, "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
  return script;
}

// An executable that creates `sentinel` when run. Tests assert the sentinel never appears.
export function sentinelScript(): { script: string; sentinel: string } {
  const dir = tempDir("cgc-sentinel-");
  const sentinel = path.join(dir, "RAN");
  const script = path.join(dir, "run.sh");
  fs.writeFileSync(script, `#!/bin/sh\ntouch "${sentinel}"\ncat\n`, { mode: 0o755 });
  return { script, sentinel };
}

// ---- M3: Claude data builders (SYNTHETIC FIXTURE). Everything goes into tempDir() folders. ----

export function claudeTree(): ClaudePaths & { root: string } {
  const root = tempDir("cgc-claude-");
  const p = {
    root,
    desktopSessionsDir: path.join(root, "desktop", "claude-code-sessions"),
    projectsDir: path.join(root, "home", ".claude", "projects"),
    runningDir: path.join(root, "home", ".claude", "sessions"),
  };
  for (const d of [p.desktopSessionsDir, p.projectsDir, p.runningDir]) fs.mkdirSync(d, { recursive: true });
  return p;
}

export interface RecordFields {
  sessionId: string;
  cliSessionId: string;
  cwd: string;
  title?: string;
  lastFocusedAt?: number | string;
  lastActivityAt?: number | string;
  isArchived?: boolean;
  branch?: string;
}

export function writeRecord(p: ClaudePaths, r: RecordFields, org = "org-syn", account = "acct-syn"): string {
  const dir = path.join(p.desktopSessionsDir, org, account);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${r.sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify({ _fixture: MARK, title: `${MARK} ${r.sessionId}`, ...r }));
  return file;
}

export function writeRunning(p: ClaudePaths, pid: number, fields: Record<string, unknown>): string {
  const file = path.join(p.runningDir, `${pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ _fixture: MARK, pid, ...fields }));
  return file;
}

let uuidSeq = 0;
export function userLine(sessionId: string, cwd: string, text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    uuid: `u-${++uuidSeq}`,
    sessionId,
    cwd,
    gitBranch: "syn-branch",
    timestamp: "2026-11-04T10:00:00.000Z",
    message: { role: "user", content: text },
    ...extra,
  });
}

export function assistantLine(sessionId: string, cwd: string, content: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `a-${++uuidSeq}`,
    sessionId,
    cwd,
    timestamp: "2026-11-04T10:00:01.000Z",
    message: { role: "assistant", content },
    ...extra,
  });
}

export function markerLine(sessionId: string): string {
  return JSON.stringify({ type: "custom-title", sessionId, customTitle: MARK });
}

/** `<projectsDir>/<encoded cwd>/<cliSessionId>.jsonl`. */
export function transcriptPath(p: ClaudePaths, cwd: string, cliSessionId: string, folder = encodeCwd(cwd)): string {
  return path.join(p.projectsDir, folder, `${cliSessionId}.jsonl`);
}

/** First line carries the marker. */
export function writeTranscript(file: string, sessionId: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [markerLine(sessionId), ...lines].map((l) => l + "\n").join(""));
}

export function appendLines(file: string, lines: string[]): void {
  fs.appendFileSync(file, lines.map((l) => l + "\n").join(""));
}

/** M2's makeRepo + makeWorktree, with the worktree on branch `feature-a`. */
export function repoWithWorktree(): { main: string; worktree: string } {
  const main = makeRepo();
  return { main, worktree: makeWorktree(main, "feature-a") };
}
