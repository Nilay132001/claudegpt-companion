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
export const SCHEMA_VERSION = 2;

export interface TurnItem { kind: string; label: string; text: string; redactions: number }
export type TurnStatus = "running" | "completed" | "interrupted" | "failed" | "abandoned";
export interface TurnRow {
  turnId: string; sessionId: string; threadId: string; sessionTitle: string | null; mode: SharingMode;
  question: string; contextBlock: string; items: TurnItem[]; omitted: number;
  answer: string; status: TurnStatus; error: string | null;
  sentAt: number; completedAt: number | null;
}
export interface ChatSummary { sessionId: string; threadId: string; sessionTitle: string | null; firstQuestion: string; turns: number; startedAt: number; lastAt: number }

const MAX_ANSWER = 64 * 1024;
const MAX_CONTEXT_BLOCK = 16 * 1024;
const MAX_ITEMS_JSON = 32 * 1024;
const PER_THREAD_KEEP = 200;
const OVERALL_KEEP = 2000;

/** Cut at a character (code point) boundary; mark the cut with an ellipsis. */
function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1; // do not split a surrogate pair
  return `${s.slice(0, end)}…`;
}

function parseItems(raw: unknown): TurnItem[] {
  if (typeof raw !== "string") return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.flatMap((x): TurnItem[] => {
      if (typeof x !== "object" || x === null) return [];
      const o = x as Record<string, unknown>;
      return [{ kind: String(o.kind ?? ""), label: String(o.label ?? ""), text: String(o.text ?? ""), redactions: Number(o.redactions ?? 0) || 0 }];
    });
  } catch {
    return [];
  }
}

/** Items JSON stays under the cap: shrink each item's text evenly until it fits. */
function itemsJson(items: TurnItem[]): string {
  let list = items;
  let json = JSON.stringify(list);
  for (let budget = 4096; json.length > MAX_ITEMS_JSON && budget >= 1; budget = Math.floor(budget / 2)) {
    list = items.map((i) => ({ ...i, text: capText(i.text, budget), label: capText(i.label, 200) }));
    json = JSON.stringify(list);
  }
  return json.length > MAX_ITEMS_JSON ? "[]" : json;
}

function turnFromRow(r: Row): TurnRow {
  return {
    turnId: String(r.turn_id), sessionId: String(r.session_id), threadId: String(r.thread_id),
    sessionTitle: typeof r.session_title === "string" ? r.session_title : null,
    mode: r.mode as SharingMode, question: String(r.question), contextBlock: String(r.context_block),
    items: parseItems(r.items), omitted: Number(r.omitted), answer: String(r.answer),
    status: r.status as TurnStatus, error: typeof r.error === "string" ? r.error : null,
    sentAt: Number(r.sent_at), completedAt: r.completed_at === null || r.completed_at === undefined ? null : Number(r.completed_at),
  };
}

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
CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, thread_id TEXT NOT NULL, session_title TEXT,
  mode TEXT NOT NULL, question TEXT NOT NULL, context_block TEXT NOT NULL, items TEXT NOT NULL, omitted INTEGER NOT NULL,
  answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error TEXT, sent_at INTEGER NOT NULL, completed_at INTEGER) STRICT;
CREATE INDEX IF NOT EXISTS turns_thread ON turns (thread_id, sent_at);
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

  insertTurn(t: Omit<TurnRow, "answer" | "status" | "error" | "completedAt">): void {
    this.#db
      .prepare("INSERT INTO turns (turn_id, session_id, thread_id, session_title, mode, question, context_block, items, omitted, status, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)")
      .run(t.turnId, t.sessionId, t.threadId, t.sessionTitle, t.mode, redact(t.question).text, capText(redact(t.contextBlock).text, MAX_CONTEXT_BLOCK), itemsJson(t.items), t.omitted, t.sentAt);
    // Retention: newest 200 per thread (by sent_at, tie-break turn_id), newest 2,000 overall.
    this.#db
      .prepare("DELETE FROM turns WHERE thread_id = ? AND turn_id NOT IN (SELECT turn_id FROM turns WHERE thread_id = ? ORDER BY sent_at DESC, turn_id DESC LIMIT ?)")
      .run(t.threadId, t.threadId, PER_THREAD_KEEP);
    this.#db
      .prepare("DELETE FROM turns WHERE turn_id NOT IN (SELECT turn_id FROM turns ORDER BY sent_at DESC, turn_id DESC LIMIT ?)")
      .run(OVERALL_KEEP);
  }

  finishTurn(turnId: string, f: { answer: string; status: TurnStatus; error: string | null }): void {
    const answer = capText(redact(f.answer).text, MAX_ANSWER);
    const error = f.error === null ? null : redact(f.error).text;
    this.#db
      .prepare("UPDATE turns SET answer = ?, status = ?, error = ?, completed_at = ? WHERE turn_id = ? AND status = 'running'")
      .run(answer, f.status, error, this.#now(), turnId);
  }

  abandonRunningTurns(): number {
    return Number(this.#db.prepare("UPDATE turns SET status = 'abandoned', completed_at = ? WHERE status = 'running'").run(this.#now()).changes);
  }

  turnsForThread(threadId: string, limit = 200): TurnRow[] {
    const rows = this.#db
      .prepare("SELECT * FROM (SELECT * FROM turns WHERE thread_id = ? ORDER BY sent_at DESC, turn_id DESC LIMIT ?) ORDER BY sent_at ASC, turn_id ASC")
      .all(threadId, limit) as Row[];
    return rows.map(turnFromRow);
  }

  listChats(limit = 100): ChatSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT thread_id, COUNT(*) AS turns, MIN(sent_at) AS started_at, MAX(sent_at) AS last_at,
          (SELECT n.session_id FROM turns n WHERE n.thread_id = g.thread_id ORDER BY n.sent_at DESC, n.turn_id DESC LIMIT 1) AS session_id,
          (SELECT n.session_title FROM turns n WHERE n.thread_id = g.thread_id ORDER BY n.sent_at DESC, n.turn_id DESC LIMIT 1) AS session_title,
          (SELECT o.question FROM turns o WHERE o.thread_id = g.thread_id ORDER BY o.sent_at ASC, o.turn_id ASC LIMIT 1) AS first_question
         FROM turns g GROUP BY thread_id ORDER BY last_at DESC, thread_id LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => ({
      sessionId: String(r.session_id), threadId: String(r.thread_id),
      sessionTitle: typeof r.session_title === "string" ? r.session_title : null,
      firstQuestion: String(r.first_question), turns: Number(r.turns), startedAt: Number(r.started_at), lastAt: Number(r.last_at),
    }));
  }

  deleteChat(threadId: string): number {
    return Number(this.#db.prepare("DELETE FROM turns WHERE thread_id = ?").run(threadId).changes);
  }

  deleteAllHistory(): number {
    return Number(this.#db.prepare("DELETE FROM turns").run().changes);
  }

  historyEnabled(): boolean {
    return this.#get("history_enabled") !== "0";
  }

  setHistoryEnabled(on: boolean): void {
    this.#set("history_enabled", on ? "1" : "0");
  }

  clearThread(sessionId: string): void {
    this.#db.prepare("DELETE FROM threads WHERE session_id = ?").run(sessionId);
  }

  #get(name: string): string | null {
    const r = this.#db.prepare("SELECT value AS v FROM settings WHERE name = ?").get(name) as Row | undefined;
    return typeof r?.v === "string" ? r.v : null;
  }

  #set(name: string, value: string): void {
    this.#db.prepare("INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, value);
  }
}
