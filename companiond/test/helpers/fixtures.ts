// Test-only helpers. Every fixture is synthetic and lives in a fresh temp dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

// An executable that creates `sentinel` when run. Tests assert the sentinel never appears.
export function sentinelScript(): { script: string; sentinel: string } {
  const dir = tempDir("cgc-sentinel-");
  const sentinel = path.join(dir, "RAN");
  const script = path.join(dir, "run.sh");
  fs.writeFileSync(script, `#!/bin/sh\ntouch "${sentinel}"\ncat\n`, { mode: 0o755 });
  return { script, sentinel };
}
