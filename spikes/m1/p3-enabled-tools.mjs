import fs from "node:fs";
import path from "node:path";
import { connect, writeConfig, HARDENED_FEATURES, tmpDir, runTurn, HERE } from "./lib.mjs";

const dir = tmpDir("enabled-tools");
const log = path.join(dir, "calls.log");
writeConfig(HARDENED_FEATURES + `
[mcp_servers.fake]
command = "node"
args = [${JSON.stringify(path.join(HERE, "fake-mcp.mjs"))}]
env = { FAKE_TOOLS = "read_file,write_file", FAKE_LOG = ${JSON.stringify(log)} }
enabled_tools = ["read_file"]
`);
const c = await connect();
const t = await c.request("thread/start", { cwd: dir, sandbox: "read-only", approvalPolicy: "untrusted", ephemeral: true });
const st = await c.request("mcpServerStatus/list", { threadId: t.thread.id, serverName: "fake" });
const listed = Object.keys(st.data[0]?.tools || {});
const r = await runTurn(c, t.thread.id, "Call the fake write_file tool with text 'x'. If no such tool exists, reply exactly NO_WRITE_TOOL and list the tool names you do have.");
const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).tool) : [];
console.log(JSON.stringify({ listedByStatus: listed, writeCalled: calls.includes("write_file"), calls, items: r.items, reply: r.text.slice(0, 200) }, null, 2));
c.close();
