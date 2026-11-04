import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "../../src/bridge/selection.ts";
import { computeStatus, focusedSessionId, pickerGroups, RECENT_WINDOW_MS, select } from "../../src/bridge/selection.ts";
import { MARK } from "../helpers/fixtures.ts";

const NOW = Date.UTC(2026, 10, 4, 12);
const s = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  cliSessionId: `cli-${id}`,
  title: `${MARK} ${id}`,
  status: "recent",
  isArchived: false,
  lastFocusedAt: null,
  lastActivityAt: null,
  recordCwd: `/syn/${id}`,
  recordBranch: null,
  resolvedRoot: null,
  source: "desktop",
  transcriptPath: null,
  transcriptMissing: null,
  ...over,
});

test("status: live state wins, else recent within 24 h, else inactive", () => {
  assert.equal(computeStatus("busy", null, NOW), "busy");
  assert.equal(computeStatus("idle", null, NOW), "idle");
  assert.equal(computeStatus(null, NOW - RECENT_WINDOW_MS + 1, NOW), "recent");
  assert.equal(computeStatus(null, NOW - RECENT_WINDOW_MS - 1, NOW), "inactive");
  assert.equal(computeStatus(null, null, NOW), "inactive");
});

test("§12.2 multiple open sessions: focus is the highest lastFocusedAt", () => {
  assert.equal(focusedSessionId([s("a", { lastFocusedAt: 1 }), s("b", { lastFocusedAt: 3 }), s("c", { lastFocusedAt: 2 })]), "b");
});

test("focus ties go to the latest lastActivityAt", () => {
  assert.equal(focusedSessionId([s("a", { lastFocusedAt: 5, lastActivityAt: 1 }), s("b", { lastFocusedAt: 5, lastActivityAt: 9 })]), "b");
});

test("§12.2 archived records never take focus and are hidden from the picker by default", () => {
  const list = [s("a", { lastFocusedAt: 9, isArchived: true }), s("b", { lastFocusedAt: 1 })];
  assert.equal(focusedSessionId(list), "b");
  assert.deepEqual(pickerGroups(list).recent.map((x) => x.sessionId), ["b"]);
  assert.deepEqual(pickerGroups(list, { includeArchived: true }).recent.map((x) => x.sessionId).sort(), ["a", "b"]);
});

test("§12.2 lagging lastFocusedAt: focus follows Claude's records only, labelled as such", () => {
  // b is busier and more recent, but Claude's record still says a is focused.
  const list = [s("a", { lastFocusedAt: 10, lastActivityAt: 10 }), s("b", { lastFocusedAt: 5, lastActivityAt: 99, status: "busy" })];
  const sel = select(list, null);
  assert.equal(sel.sessionId, "a");
  assert.equal(sel.focusLabel, "Claude focus (from Claude's records)");
});

test("§12.2 pinned session ignores focus; a focus move shows the chip", () => {
  const before = [s("a", { lastFocusedAt: 10 }), s("b", { lastFocusedAt: 5 })];
  const pin = { sessionId: "b", focusAtPin: focusedSessionId(before) };
  assert.deepEqual(select(before, pin).focusMovedTo, null);
  const after = [s("a", { lastFocusedAt: 10 }), s("b", { lastFocusedAt: 5 }), s("c", { lastFocusedAt: 20 })];
  const sel = select(after, pin);
  assert.equal(sel.sessionId, "b");
  assert.equal(sel.via, "pin");
  assert.equal(sel.focusMovedTo, "c");
});

test("a pinned session that disappears stays pinned and is flagged", () => {
  const sel = select([s("a", { lastFocusedAt: 1 })], { sessionId: "gone", focusAtPin: "a" });
  assert.equal(sel.sessionId, "gone");
  assert.equal(sel.pinnedMissing, true);
});

test("picker groups by status and searches title, cwd and branch", () => {
  const list = [s("a", { status: "busy" }), s("b", { status: "idle", recordBranch: "feature-x" }), s("c"), s("d", { status: "inactive" })];
  const g = pickerGroups(list);
  assert.deepEqual([g.busy.length, g.idle.length, g.recent.length, g.older.length], [1, 1, 1, 0]);
  assert.deepEqual(pickerGroups(list, { query: "FEATURE-X" }).idle.map((x) => x.sessionId), ["b"]);
  assert.deepEqual(pickerGroups(list, { query: "/syn/d" }).older.map((x) => x.sessionId), ["d"]);
});

test("picker search also matches the resolved root", () => {
  const list = [s("a", { resolvedRoot: "/syn/wt/feature-z" })];
  assert.deepEqual(pickerGroups(list, { query: "feature-z" }).recent.map((x) => x.sessionId), ["a"]);
});
