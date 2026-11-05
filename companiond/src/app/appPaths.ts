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

/** Makes d a real 0700 directory owned by this user, never following a link (final review I-1: Codex can write
 * inside CODEX_HOME, so CODEX_HOME/tmp may have been replaced by a symlink). The folder is opened with O_NOFOLLOW
 * and checked and chmodded through that descriptor, so a link swapped in after a check is never followed either.
 * Anything that is not a real directory of ours is refused; nothing is changed through it. */
export function ensurePrivateDir(d: string): void {
  try {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  } catch (e) {
    // mkdir on an existing name (a link, a file) fails or is a no-op; the checks below decide.
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
  let fd: number;
  try {
    fd = fs.openSync(d, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch {
    throw new AppDirError("Security check failed: a companion folder is not a real folder.");
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
      throw new AppDirError("Security check failed: a companion folder is not a real folder of this user.");
    }
    fs.fchmodSync(fd, 0o700);
  } finally {
    fs.closeSync(fd);
  }
}

/** Creates the folders with mode 0700 and returns realpath'd paths. The thread cwd must stay empty (spec §7.1.2). */
export function ensureAppDirs(p: AppPaths): AppPaths {
  for (const d of [p.supportDir, p.codexHome, p.emptyCwd, path.join(p.codexHome, "tmp")]) ensurePrivateDir(d);
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
