// SYNTHETIC FIXTURE — stands in for the jail in relay unit tests: MCP over stdio, five read-only tool names,
// reads no files. FAKE_JAIL_MODE: "" normal | "server-request" (sends a request after initialize)
// | "bad-id" (answers tools/list with an id nobody asked for) | "slow" (tools/call waits 2 s).
import { LineBuffer } from "../../src/lineBuffer.ts";

const mode = process.env.FAKE_JAIL_MODE ?? "";
const TOOLS = ["list_dir", "read_file", "search", "git_status", "git_diff"];
const lb = new LineBuffer();
const send = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

process.stdin.on("data", (c: Buffer) => {
  for (const line of lb.push(c)) {
    const m = JSON.parse(line) as { id?: number | string; method?: string; params?: { name?: string; protocolVersion?: string } };
    if (m.id === undefined) continue;
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-jail", version: "0" } } });
      if (mode === "server-request") send({ jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} });
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: mode === "bad-id" ? 999 : m.id, result: { tools: TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) } });
    } else if (m.method === "tools/call") {
      const reply = () => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `SYNTHETIC FIXTURE called ${m.params?.name}` }], isError: false } });
      if (mode === "slow") setTimeout(reply, 2000);
      else reply();
    } else {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});
