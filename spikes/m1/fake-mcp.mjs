// Fake stdio MCP server for probes. Tools: FAKE_TOOLS (comma list). Calls logged to FAKE_LOG.
import fs from "node:fs";
import readline from "node:readline";

const names = (process.env.FAKE_TOOLS || "whereami").split(",");
const log = (o) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") return reply(m.id, { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
  if (m.method === "tools/list") return reply(m.id, { tools: names.map((n) => ({ name: n, description: `Fake tool ${n}. Call it when asked.`, inputSchema: { type: "object", properties: { text: { type: "string" } } } })) });
  if (m.method === "tools/call") {
    log({ tool: m.params.name, args: m.params.arguments, pid: process.pid });
    const text = m.params.name === "whereami" ? `ROOT=${process.env.FAKE_ROOT}` : `ok:${m.params.name}`;
    return reply(m.id, { content: [{ type: "text", text }] });
  }
  if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } }) + "\n");
});
