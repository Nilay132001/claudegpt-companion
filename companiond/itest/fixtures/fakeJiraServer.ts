// SYNTHETIC FIXTURE — a fake companion-jira MCP stdio server for the real-Codex self-check (M6, itest/jira.itest.ts).
// It lists the three Jira read tools (and, with FAKE_JIRA_EXTRA=1, also createJiraIssue), answers every tools/call
// with "SYNTHETIC FIXTURE", and makes no network call. It reads fd 3 like companion-jira and reports only whether a
// line arrived there (serverInfo.version = {"fd3":true|false}), never its content.
import fs from "node:fs";
import { JIRA_TOOL_NAMES } from "../../src/jira/tools.ts";
import { LineBuffer } from "../../src/lineBuffer.ts";

function fd3(): boolean {
  try {
    const raw = fs.readFileSync(3, { encoding: "utf8" });
    fs.closeSync(3);
    return raw.length > 0;
  } catch {
    return false;
  }
}

const tag = JSON.stringify({ fd3: fd3() });
const tools: string[] = [...JIRA_TOOL_NAMES, ...(process.env.FAKE_JIRA_EXTRA === "1" ? ["createJiraIssue"] : [])];
const lb = new LineBuffer();
const reply = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

process.stdin.on("data", (c: Buffer) => {
  for (const line of lb.push(c)) {
    const m = JSON.parse(line) as { id?: number | string; method?: string; params?: { protocolVersion?: string } };
    if (m.id === undefined) continue;
    if (m.method === "initialize") {
      reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-jira", version: tag } } });
    } else if (m.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: m.id, result: { tools: tools.map((name) => ({ name, description: "SYNTHETIC FIXTURE tool", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } })) } });
    } else if (m.method === "tools/call") {
      reply({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "SYNTHETIC FIXTURE" }], isError: false } });
    } else {
      reply({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } });
    }
  }
});
