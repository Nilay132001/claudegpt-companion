import { after, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, Store, StoreError, type TurnRow } from "../../src/store/store.ts";
import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);

const j = (...p: string[]) => p.join("");
type NewTurn = Parameters<Store["insertTurn"]>[0];

function turn(id: string, over: Partial<NewTurn> = {}): NewTurn {
  return {
    turnId: id, sessionId: "s1", threadId: "t1", sessionTitle: "Title", mode: "ask",
    question: `q-${id}`, contextBlock: "ctx", items: [{ kind: "text", label: "L", text: "body", redactions: 0 }],
    omitted: 0, sentAt: 100, ...over,
  };
}

test("schema version is 2", () => {
  assert.equal(SCHEMA_VERSION, 2);
});

test("insertTurn round-trips through turnsForThread, running until finished", () => {
  const s = Store.memory(() => 1);
  s.insertTurn(turn("a", { sentAt: 10 }));
  const [r] = s.turnsForThread("t1") as [TurnRow];
  assert.equal(r.turnId, "a");
  assert.equal(r.status, "running");
  assert.equal(r.answer, "");
  assert.equal(r.completedAt, null);
  assert.equal(r.error, null);
  assert.equal(r.mode, "ask");
  assert.equal(r.sessionTitle, "Title");
  assert.deepEqual(r.items, [{ kind: "text", label: "L", text: "body", redactions: 0 }]);
  s.finishTurn("a", { answer: "hi", status: "completed", error: null });
  const [f] = s.turnsForThread("t1") as [TurnRow];
  assert.equal(f.answer, "hi");
  assert.equal(f.status, "completed");
  assert.equal(f.completedAt, 1);
});

test("a secret in the question is stored redacted", () => {
  const s = Store.memory();
  const secret = j("sk", "-proj-", "SYNTHETICsynthetic0123456789");
  s.insertTurn(turn("a", { question: `use ${secret} now` }));
  const [r] = s.turnsForThread("t1") as [TurnRow];
  assert.ok(!r.question.includes(secret));
});

test("finishTurn redacts answer and error and caps the answer at 64 KB", () => {
  const s = Store.memory();
  const secret = j("sk", "-proj-", "SYNTHETICsynthetic0123456789");
  s.insertTurn(turn("a"));
  s.finishTurn("a", { answer: `key ${secret}`, status: "failed", error: `bad ${secret}` });
  const [r] = s.turnsForThread("t1") as [TurnRow];
  assert.ok(!r.answer.includes(secret));
  assert.ok(!(r.error ?? "").includes(secret));
  s.insertTurn(turn("b", { sentAt: 200 }));
  s.finishTurn("b", { answer: "x".repeat(70 * 1024), status: "completed", error: null });
  const b = s.turnsForThread("t1")[1] as TurnRow;
  assert.equal(b.answer.length, 64 * 1024 + 1);
  assert.ok(b.answer.endsWith("…"));
});

test("finishTurn on an unknown turn is a no-op and the first final status wins", () => {
  const s = Store.memory();
  s.finishTurn("nope", { answer: "x", status: "completed", error: null });
  assert.deepEqual(s.turnsForThread("t1"), []);
  s.insertTurn(turn("a"));
  s.finishTurn("a", { answer: "one", status: "interrupted", error: null });
  s.finishTurn("a", { answer: "two", status: "completed", error: null });
  const [r] = s.turnsForThread("t1") as [TurnRow];
  assert.equal(r.answer, "one");
  assert.equal(r.status, "interrupted");
});

test("abandonRunningTurns flips only running rows", () => {
  const s = Store.memory();
  s.insertTurn(turn("a", { sentAt: 1 }));
  s.insertTurn(turn("b", { sentAt: 2 }));
  s.finishTurn("b", { answer: "ok", status: "completed", error: null });
  assert.equal(s.abandonRunningTurns(), 1);
  const rows = s.turnsForThread("t1");
  assert.deepEqual(rows.map((r) => r.status), ["abandoned", "completed"]);
  assert.equal(s.abandonRunningTurns(), 0);
});

test("bad items JSON reads as an empty list", () => {
  const file = path.join(tempDir(), "companion.db");
  const s = Store.open(file);
  s.insertTurn(turn("a"));
  const raw = new DatabaseSync(file);
  raw.exec("UPDATE turns SET items = '{nope'");
  raw.close();
  assert.deepEqual((s.turnsForThread("t1")[0] as TurnRow).items, []);
  s.close();
});

test("listChats groups by thread, newest first, with first question and newest title", () => {
  const s = Store.memory();
  s.insertTurn(turn("a1", { threadId: "A", sessionId: "sa", sessionTitle: "old", question: "first A", sentAt: 10 }));
  s.insertTurn(turn("a2", { threadId: "A", sessionId: "sa", sessionTitle: "new", question: "second A", sentAt: 30 }));
  s.insertTurn(turn("b1", { threadId: "B", sessionId: "sb", sessionTitle: null, question: "only B", sentAt: 20 }));
  const chats = s.listChats();
  assert.deepEqual(chats, [
    { sessionId: "sa", threadId: "A", sessionTitle: "new", firstQuestion: "first A", turns: 2, startedAt: 10, lastAt: 30 },
    { sessionId: "sb", threadId: "B", sessionTitle: null, firstQuestion: "only B", turns: 1, startedAt: 20, lastAt: 20 },
  ]);
  assert.equal(s.listChats(1).length, 1);
});

test("retention keeps the newest 200 per thread", () => {
  const s = Store.memory();
  for (let i = 0; i < 205; i++) s.insertTurn(turn(`t${String(i).padStart(3, "0")}`, { sentAt: i }));
  const rows = s.turnsForThread("t1", 1000);
  assert.equal(rows.length, 200);
  assert.equal(rows[0]?.turnId, "t005");
  assert.equal(rows[199]?.turnId, "t204");
  assert.equal(s.turnsForThread("t1", 3).length, 3);
  assert.equal(s.turnsForThread("t1", 3)[2]?.turnId, "t204");
});

test("retention keeps the newest 2,000 overall", () => {
  const s = Store.memory();
  for (let i = 0; i < 2010; i++) s.insertTurn(turn(`x${i}`, { threadId: `th${i % 20}`, sessionId: `se${i % 20}`, sentAt: i }));
  const total = s.listChats(1000).reduce((n, c) => n + c.turns, 0);
  assert.equal(total, 2000);
});

test("deleteChat and deleteAllHistory return counts", () => {
  const s = Store.memory();
  s.insertTurn(turn("a", { threadId: "A" }));
  s.insertTurn(turn("b", { threadId: "A", sentAt: 101 }));
  s.insertTurn(turn("c", { threadId: "B" }));
  assert.equal(s.deleteChat("A"), 2);
  assert.equal(s.turnsForThread("A").length, 0);
  assert.equal(s.deleteAllHistory(), 1);
  assert.deepEqual(s.listChats(), []);
});

test("historyEnabled defaults to true and toggles", () => {
  const s = Store.memory();
  assert.equal(s.historyEnabled(), true);
  s.setHistoryEnabled(false);
  assert.equal(s.historyEnabled(), false);
  s.setHistoryEnabled(true);
  assert.equal(s.historyEnabled(), true);
});

test("clearThread drops the session's thread mapping", () => {
  const s = Store.memory();
  s.setThread("s1", "thr");
  s.clearThread("s1");
  assert.equal(s.getThread("s1"), null);
});

test("a v1 file upgrades in place; a newer one is still refused", () => {
  const file = path.join(tempDir(), "companion.db");
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE threads (session_id TEXT PRIMARY KEY, codex_thread_id TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE cursors (session_id TEXT PRIMARY KEY, uuid TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE approvals (root TEXT PRIMARY KEY, common_dir TEXT NOT NULL, include_worktrees INTEGER NOT NULL, approved_at INTEGER NOT NULL) STRICT;
CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO threads VALUES ('s1', 'thr', 1);
PRAGMA user_version = 1;`);
  raw.close();
  const s = Store.open(file);
  assert.equal(s.getThread("s1"), "thr");
  s.insertTurn(turn("a"));
  assert.equal(s.turnsForThread("t1").length, 1);
  s.close();
  const chk = new DatabaseSync(file);
  assert.equal(Number((chk.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 2);
  chk.exec("PRAGMA user_version = 3");
  chk.close();
  assert.throws(() => Store.open(file), StoreError);
});
