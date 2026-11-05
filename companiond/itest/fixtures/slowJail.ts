// SYNTHETIC FIXTURE — a jail stand-in for the live interrupt test: MCP over stdio, the five tool names, reads no
// files. Its FIRST tools/call is held for 15 s so the test can interrupt mid-call; later calls answer at once.
import { LineBuffer } from "../../src/lineBuffer.ts";

const TOOLS = ["list_dir", "read_file", "search", "git_status", "git_diff"];
const lb = new LineBuffer();
const send = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
let first = true;

process.stdin.on("data", (c: Buffer) => {
  for (const line of lb.push(c)) {
    const m = JSON.parse(line) as { id?: number | string; method?: string; params?: { protocolVersion?: string } };
    if (m.id === undefined) continue;
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "slow-jail", version: "0" } } });
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS.map((name) => ({ name, description: "SYNTHETIC FIXTURE tool", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } })) } });
    } else if (m.method === "tools/call") {
      const reply = () => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "SYNTHETIC FIXTURE listing: slow-jail-ok.txt" }], isError: false } });
      if (first) {
        first = false;
        setTimeout(reply, 15_000);
      } else reply();
    } else {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});
