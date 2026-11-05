import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, StoreError } from "../../src/store/store.ts";
import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);

const j = (...p: string[]) => p.join("");

test("threads, reverse lookup and cursors round-trip", () => {
  const s = Store.memory(() => 5);
  assert.equal(s.getThread("s1"), null);
  s.setThread("s1", "thr-1");
  s.setThread("s1", "thr-2");
  assert.equal(s.getThread("s1"), "thr-2");
  assert.equal(s.sessionForThread("thr-2"), "s1");
  assert.equal(s.sessionForThread("thr-1"), null);
  s.setCursor("s1", "uuid-9");
  assert.equal(s.getCursor("s1"), "uuid-9");
  s.clearCursor("s1");
  assert.equal(s.getCursor("s1"), null);
});

test("approvals, pin, sharing mode and UI settings", () => {
  const s = Store.memory(() => 7);
  s.putApproval({ root: "/r", commonDir: "/r/.git", includeWorktrees: true, approvedAt: 7 });
  assert.deepEqual(s.listApprovals(), [{ root: "/r", commonDir: "/r/.git", includeWorktrees: true, approvedAt: 7 }]);
  assert.equal(s.deleteApproval("/r"), true);
  assert.equal(s.deleteApproval("/r"), false);
  assert.equal(s.getPin(), null);
  s.setPin("s1");
  assert.equal(s.getPin(), "s1");
  s.setPin(null);
  assert.equal(s.getPin(), null);
  assert.equal(s.getSharingMode(), "ask");
  s.setSharingMode("off");
  assert.equal(s.getSharingMode(), "off");
  assert.throws(() => s.setSharingMode("loud" as never), StoreError);
  s.setUiSetting("ui.speech.rate", "1.25");
  assert.equal(s.getUiSetting("ui.speech.rate"), "1.25");
  assert.throws(() => s.setUiSetting("token", "x"), StoreError);
  assert.throws(() => s.setUiSetting("ui.big", "x".repeat(5000)), StoreError);
});

test("UI settings refuse credential keys and secret-shaped values", () => {
  const s = Store.memory();
  for (const key of ["ui.openai_api_key", "ui.github.token", "ui.auth_header", "ui.password"]) {
    assert.throws(() => s.setUiSetting(key, "x"), StoreError, key);
  }
  assert.throws(() => s.setUiSetting("ui.note", j("sk", "-proj-", "SYNTHETICsynthetic0123456789")), StoreError);
  assert.equal(s.getUiSetting("ui.note"), null);
});

test("the file is 0600, persists, and refuses a newer schema", () => {
  const file = path.join(tempDir(), "companion.db");
  const a = Store.open(file);
  a.setThread("s1", "thr-1");
  a.close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = Store.open(file);
  assert.equal(b.getThread("s1"), "thr-1");
  b.close();
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  assert.throws(() => Store.open(file), StoreError);
});

test("a corrupt file is a StoreError, not a raw SQLite error, and its handle is closed", () => {
  const file = path.join(tempDir(), "companion.db");
  fs.writeFileSync(file, "SYNTHETIC FIXTURE garbage, not a database\n".repeat(200), { mode: 0o600 });
  const openFds = () => fs.readdirSync("/dev/fd").length;
  const before = openFds();
  assert.throws(() => Store.open(file), (e: unknown) => e instanceof StoreError && e.message === "companion.db is unreadable.");
  assert.equal(openFds(), before);
});

test("a pre-existing 0644 file is tightened to 0600", () => {
  const file = path.join(tempDir(), "companion.db");
  fs.writeFileSync(file, "", { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  Store.open(file).close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a symlink at the DB path, a non-file, and a folder that is not 0700 are refused", () => {
  const dir = tempDir();
  const target = path.join(tempDir(), "elsewhere.db");
  fs.writeFileSync(target, "", { mode: 0o644 });
  fs.chmodSync(target, 0o644);
  fs.symlinkSync(target, path.join(dir, "companion.db"));
  assert.throws(() => Store.open(path.join(dir, "companion.db")), StoreError);
  assert.equal(fs.statSync(target).mode & 0o777, 0o644); // the link target is untouched
  const d2 = tempDir();
  fs.mkdirSync(path.join(d2, "companion.db"));
  assert.throws(() => Store.open(path.join(d2, "companion.db")), StoreError);
  const open = tempDir();
  fs.chmodSync(open, 0o755);
  assert.throws(() => Store.open(path.join(open, "companion.db")), StoreError);
  assert.equal(fs.existsSync(path.join(open, "companion.db")), false);
});

test("no column is meant for secrets", () => {
  const file = path.join(tempDir(), "companion.db");
  Store.open(file).close();
  const raw = new DatabaseSync(file);
  const sql = (raw.prepare("SELECT group_concat(sql, ' ') AS s FROM sqlite_master").get() as { s: string }).s;
  raw.close();
  assert.doesNotMatch(sql, /token|password|secret|auth|email/i);
});
