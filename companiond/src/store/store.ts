// companion.db (spec §3, §7.8): session → Codex thread, cursors, approved roots, pin, sharing mode, UI settings.
// Holds no secrets. node:sqlite is @experimental in @types/node 24; this file is the only user.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redact } from "../jail/redactor.ts";

export type SharingMode = "off" | "ask" | "automatic";
export const SHARING_MODES: readonly SharingMode[] = ["off", "ask", "automatic"];
export const DEFAULT_SHARING_MODE: SharingMode = "ask";
export interface ApprovedRoot { root: string; commonDir: string; includeWorktrees: boolean; approvedAt: number }
export const SCHEMA_VERSION = 1;

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (session_id TEXT PRIMARY KEY, codex_thread_id TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS cursors (session_id TEXT PRIMARY KEY, uuid TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS approvals (root TEXT PRIMARY KEY, common_dir TEXT NOT NULL, include_worktrees INTEGER NOT NULL, approved_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;
const UI_KEY = /^ui\.[a-z0-9_.]{1,64}$/;
/** UI settings never hold credentials (spec §7.8): refuse secret-sounding keys and secret-shaped values. */
const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|auth|credential/i;
const MAX_SETTING = 4096;

type Row = Record<string, unknown>;
const UNREADABLE = "companion.db is unreadable.";

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // already closed or never opened
  }
}

/** The folder must be a real directory, 0700 and ours (M4a's ensureAppDirs makes it so; spec §7.8). */
function checkFolder(dir: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    throw new StoreError("The companion data folder is missing.");
  }
  const uid = process.getuid?.();
  if (!st.isDirectory() || (st.mode & 0o777) !== 0o700 || (uid !== undefined && st.uid !== uid)) {
    throw new StoreError("The companion data folder must be a 0700 folder owned by you.");
  }
}

export class Store {
  #db: DatabaseSync;
  #now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    try {
      const row = db.prepare("PRAGMA user_version").get() as Row | undefined;
      const v = Number(row?.user_version ?? 0);
      if (v > SCHEMA_VERSION) throw new StoreError("companion.db was written by a newer companiond.");
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } catch (e) {
      closeQuietly(db);
      throw e instanceof StoreError ? e : new StoreError(UNREADABLE);
    }
  }

  static open(file: string, now?: () => number): Store {
    checkFolder(path.dirname(file));
    // O_NOFOLLOW: a symlink at the DB path is refused instead of followed (and chmod-ed).
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    } catch {
      throw new StoreError("companion.db is not a regular file.");
    }
    try {
      if (!fs.fstatSync(fd).isFile()) throw new StoreError("companion.db is not a regular file.");
      fs.fchmodSync(fd, 0o600); // tightens a pre-existing file too
    } finally {
      fs.closeSync(fd);
    }
    // A corrupt or foreign file raises a raw SQLite error: close the handle and report a StoreError.
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
      db.exec("PRAGMA journal_mode = DELETE");
    } catch {
      if (db) closeQuietly(db);
      throw new StoreError(UNREADABLE);
    }
    return new Store(db, now);
  }

  static memory(now?: () => number): Store {
    return new Store(new DatabaseSync(":memory:"), now);
  }

  close(): void {
    this.#db.close();
  }

  getThread(sessionId: string): string | null {
    const r = this.#db.prepare("SELECT codex_thread_id AS v FROM threads WHERE session_id = ?").get(sessionId) as Row | undefined;
    return typeof r?.v === "string" ? r.v : null;
  }

  setThread(sessionId: string, threadId: string): void {
    this.#db
      .prepare("INSERT INTO threads (session_id, codex_thread_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET codex_thread_id = excluded.codex_thread_id, updated_at = excluded.updated_at")
      .run(sessionId, threadId, this.#now());
  }

  sessionForThread(threadId: string): string | null {
    const r = this.#db.prepare("SELECT session_id AS v FROM threads WHERE codex_thread_id = ?").get(threadId) as Row | undefined;
    return typeof r?.v === "string" ? r.v : null;
  }

  getCursor(sessionId: string): string | null {
    const r = this.#db.prepare("SELECT uuid AS v FROM cursors WHERE session_id = ?").get(sessionId) as Row | undefined;
    return typeof r?.v === "string" ? r.v : null;
  }

  setCursor(sessionId: string, uuid: string): void {
    this.#db
      .prepare("INSERT INTO cursors (session_id, uuid, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET uuid = excluded.uuid, updated_at = excluded.updated_at")
      .run(sessionId, uuid, this.#now());
  }

  clearCursor(sessionId: string): void {
    this.#db.prepare("DELETE FROM cursors WHERE session_id = ?").run(sessionId);
  }

  listApprovals(): ApprovedRoot[] {
    return (this.#db.prepare("SELECT root, common_dir, include_worktrees, approved_at FROM approvals ORDER BY root").all() as Row[]).map((r) => ({
      root: String(r.root),
      commonDir: String(r.common_dir),
      includeWorktrees: Number(r.include_worktrees) === 1,
      approvedAt: Number(r.approved_at),
    }));
  }

  putApproval(a: ApprovedRoot): void {
    this.#db
      .prepare("INSERT INTO approvals (root, common_dir, include_worktrees, approved_at) VALUES (?, ?, ?, ?) ON CONFLICT(root) DO UPDATE SET common_dir = excluded.common_dir, include_worktrees = excluded.include_worktrees, approved_at = excluded.approved_at")
      .run(a.root, a.commonDir, a.includeWorktrees ? 1 : 0, a.approvedAt);
  }

  deleteApproval(root: string): boolean {
    return Number(this.#db.prepare("DELETE FROM approvals WHERE root = ?").run(root).changes) > 0;
  }

  getPin(): string | null {
    return this.#get("pin");
  }

  setPin(sessionId: string | null): void {
    if (sessionId === null) this.#db.prepare("DELETE FROM settings WHERE name = 'pin'").run();
    else this.#set("pin", sessionId);
  }

  getSharingMode(): SharingMode {
    const v = this.#get("sharing_mode");
    return SHARING_MODES.includes(v as SharingMode) ? (v as SharingMode) : DEFAULT_SHARING_MODE;
  }

  setSharingMode(m: SharingMode): void {
    if (!SHARING_MODES.includes(m)) throw new StoreError("Unknown sharing mode.");
    this.#set("sharing_mode", m);
  }

  getUiSetting(key: string): string | null {
    if (!UI_KEY.test(key)) throw new StoreError("UI setting keys look like ui.<name>.");
    return this.#get(key);
  }

  setUiSetting(key: string, value: string): void {
    if (!UI_KEY.test(key)) throw new StoreError("UI setting keys look like ui.<name>.");
    if (SECRET_KEY.test(key)) throw new StoreError("UI settings cannot hold credentials.");
    if (value.length > MAX_SETTING) throw new StoreError("UI setting value is too long.");
    if (redact(value).count > 0) throw new StoreError("UI settings cannot hold credentials.");
    this.#set(key, value);
  }

  #get(name: string): string | null {
    const r = this.#db.prepare("SELECT value AS v FROM settings WHERE name = ?").get(name) as Row | undefined;
    return typeof r?.v === "string" ? r.v : null;
  }

  #set(name: string, value: string): void {
    this.#db.prepare("INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, value);
  }
}
