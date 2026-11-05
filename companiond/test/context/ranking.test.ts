import assert from "node:assert/strict";
import test from "node:test";
import { buildPreview, composeTurnText, DEFAULT_CAPS } from "../../src/context/contextBuilder.ts";
import type { TranscriptEvent } from "../../src/transcript/parser.ts";
import type { SubagentUpdate } from "../../src/transcript/subagents.ts";

// Synthetic shape of a long session: many older items, mostly tool chatter and subagent output.
function fixture(): { events: TranscriptEvent[]; subagents: SubagentUpdate[] } {
  const events: TranscriptEvent[] = [];
  let n = 0;
  const base = { isSidechain: false, timestamp: null } as const;
  for (let turn = 0; turn < 40; turn++) {
    events.push({ ...base, kind: "user_text", uuid: `u${n++}`, text: `Synthetic question ${turn}: please fix the widget parser` });
    for (let k = 0; k < 12; k++) {
      events.push({
        ...base, kind: "tool_result", uuid: `t${n++}`, toolUseId: `tu${n}`, toolName: "Bash", command: `npm test -- widget${k}`,
        isError: false, stdout: "ok ".repeat(400), stderr: "", exitCode: 0, interrupted: false, text: "", failure: null,
      });
    }
    events.push({ ...base, kind: "subagent_summary", uuid: `s${n++}`, toolUseId: `sa${n}`, text: "Subagent explored files. ".repeat(60) });
    events.push({ ...base, kind: "assistant_text", uuid: `a${n++}`, text: `Synthetic reply ${turn}: changed parser.ts` });
  }
  const subagents: SubagentUpdate[] = Array.from({ length: 60 }, (_, i) => ({ agentId: `ag${i}`, records: 3, summary: "Tracker summary text. ".repeat(80) }));
  return { events, subagents };
}

test("user messages and Claude replies outrank subagent and tool chatter under the 12 KB cap", () => {
  const { events, subagents } = fixture();
  const p = buildPreview({ events, hadCursor: false, cursorFound: false, subagents });
  const kinds = p.items.map((i) => i.kind);
  assert.ok(p.bytes <= DEFAULT_CAPS.totalBytes);
  assert.ok(kinds.filter((k) => k === "user").length >= 10, "keeps many user messages");
  assert.ok(kinds.includes("assistant"));
  assert.ok(p.items.some((i) => i.text.includes("Synthetic question 39")), "newest question kept");
  assert.ok(p.items.some((i) => i.text.includes("Synthetic reply 39")), "newest reply kept");
  assert.ok(kinds.filter((k) => k === "subagent").length <= 2, "subagent output gets only leftovers");
  assert.ok(p.omitted > 0);
  assert.match(p.notes.join(" "), /left out/);
  assert.ok(kinds.includes("command"), "pass A leaves slots and bytes for recent commands");
  assert.ok(kinds.filter((k) => k === "user" || k === "assistant").length >= 20);
});

test("the longest omitted note still keeps the emitted block under the cap", () => {
  const { events, subagents } = fixture();
  const many = Array.from({ length: 25 }, () => events).flat().map((e, i) => ({ ...e, uuid: `x${i}` }));
  const p = buildPreview({ events: many, hadCursor: true, cursorFound: false, subagents });
  assert.ok(p.omitted >= 1000, "four-digit counts in the note");
  const long = "Ж".repeat(400);
  const out = composeTurnText({
    sessionTitle: long, repo: { state: "bound", root: `/synthetic/${"d/".repeat(400)}`, branch: long, detail: null },
    repoNote: long, preview: p, removeIds: new Set(), question: "q",
  });
  assert.ok(Buffer.byteLength(out.contextBlock, "utf8") <= DEFAULT_CAPS.totalBytes);
});

test("items keep transcript order", () => {
  const { events, subagents } = fixture();
  const p = buildPreview({ events, hadCursor: false, cursorFound: false, subagents });
  const order = p.items.filter((i) => i.kind === "user").map((i) => Number(/question (\d+)/.exec(i.text)?.[1]));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("when everything fits nothing is reordered or dropped", () => {
  const base = { isSidechain: false, timestamp: null } as const;
  const events: TranscriptEvent[] = [
    { ...base, kind: "user_text", uuid: "1", text: "q" },
    { ...base, kind: "subagent_summary", uuid: "2", toolUseId: "t", text: "s" },
    { ...base, kind: "assistant_text", uuid: "3", text: "a" },
  ];
  const p = buildPreview({ events, hadCursor: false, cursorFound: false });
  assert.deepEqual(p.items.map((i) => i.kind), ["user", "subagent", "assistant"]);
  assert.equal(p.omitted, 0);
});
