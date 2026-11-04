// The companion's own folders (spec §3, §7.8). Everything companiond writes lives here.
import fs from "node:fs";
import path from "node:path";

export interface AppPaths { supportDir: string; codexHome: string; emptyCwd: string; dbPath: string }

export class AppDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppDirError";
  }
}

export function appPaths(home: string): AppPaths {
  const supportDir = path.join(home, "Library", "Application Support", "ClaudeGPTCompanion");
  return {
    supportDir,
    codexHome: path.join(supportDir, "codex-home"),
    emptyCwd: path.join(supportDir, "empty-cwd"),
    dbPath: path.join(supportDir, "companion.db"),
  };
}

/** Creates the folders with mode 0700 and returns realpath'd paths. The thread cwd must stay empty (spec §7.1.2). */
export function ensureAppDirs(p: AppPaths): AppPaths {
  for (const d of [p.supportDir, p.codexHome, p.emptyCwd, path.join(p.codexHome, "tmp")]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }
  const real = (q: string) => fs.realpathSync.native(q);
  const supportDir = real(p.supportDir);
  const out: AppPaths = {
    supportDir,
    codexHome: real(p.codexHome),
    emptyCwd: real(p.emptyCwd),
    dbPath: path.join(supportDir, path.basename(p.dbPath)),
  };
  if (fs.readdirSync(out.emptyCwd).length !== 0) {
    throw new AppDirError("Security check failed: the companion's empty folder is not empty.");
  }
  return out;
}
