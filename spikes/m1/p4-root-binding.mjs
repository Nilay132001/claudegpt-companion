import fs from "node:fs";
import path from "node:path";
import { connect, writeConfig, HARDENED_FEATURES, tmpDir, runTurn, HERE } from "./lib.mjs";

const dir = tmpDir("binding");
const log = path.join(dir, "calls.log");
const rootA = tmpDir("rootA");
const rootB = tmpDir("rootB");
writeConfig(HARDENED_FEATURES + `
[mcp_servers.fake]
command = "node"
args = [${JSON.stringify(path.join(HERE, "fake-mcp.mjs"))}]
env = { FAKE_TOOLS = "whereami", FAKE_LOG = ${JSON.stringify(log)}, FAKE_ROOT = "DEFAULT" }
enabled_tools = ["whereami"]
`);
const empty = tmpDir("empty");
const c = await connect({ onServerRequest: (m) => m === "mcpServer/elicitation/request" ? { result: { action: "accept", content: null, _meta: null } } : { error: { code: -32000, message: "not permitted" } } });
const shapes = {
  dotted: (root) => ({ "mcp_servers.fake.env.FAKE_ROOT": root }),
  nested: (root) => ({ mcp_servers: { fake: { env: { FAKE_TOOLS: "whereami", FAKE_LOG: log, FAKE_ROOT: root } } } }),
};
const results = {};
for (const [shape, mk] of Object.entries(shapes)) {
  const seen = {};
  for (const [label, root] of [["A", rootA], ["B", rootB]]) {
    try {
      const t = await c.request("thread/start", { cwd: empty, sandbox: "read-only", approvalPolicy: "untrusted", ephemeral: true, config: mk(root) });
      const r = await runTurn(c, t.thread.id, "Call the whereami tool once and reply with exactly what it returned.");
      const other = label === "A" ? rootB : rootA;
      seen[label] = { sawOwnRoot: r.text.includes(root), sawOtherRoot: r.text.includes(other), reply: r.text.trim().slice(0, 200) };
    } catch (e) { seen[label] = { error: String(e.message).slice(0, 200) }; }
  }
  results[shape] = seen;
}
const pids = fs.existsSync(log) ? [...new Set(fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).pid))] : [];
console.log(JSON.stringify({ rootA, rootB, results, distinctMcpProcesses: pids.length, serverRequests: c.serverRequests.map((x) => x.method) }, null, 2));
c.close();
