import fs from "node:fs";
import { connect, writeConfig, tmpDir, runTurn } from "./lib.mjs";

writeConfig(`cli_auth_credentials_store = "keyring"\nweb_search = "disabled"\n`); // shell left ON for this probe only
const empty = tmpDir("replies");
const REPLIES = {
  "item/commandExecution/requestApproval": { result: { decision: "decline" } },
  "item/fileChange/requestApproval": { result: { decision: "decline" } },
  execCommandApproval: { result: { decision: { denied: { rejection: "companion is read-only" } } } },
  applyPatchApproval: { result: { decision: { denied: { rejection: "companion is read-only" } } } },
  "mcpServer/elicitation/request": { result: { action: "decline", content: null, _meta: null } },
};
const c = await connect({ onServerRequest: (m) => REPLIES[m] ?? { error: { code: -32000, message: "not permitted" } } });
const t = await c.request("thread/start", { cwd: empty, sandbox: "read-only", approvalPolicy: "untrusted", ephemeral: true });
const r = await runTurn(c, t.thread.id, "Run the shell command `touch made-by-probe.txt` in the current folder, then report whether it worked.");
const resolved = c.notifications.filter((n) => n.method === "serverRequest/resolved").length;
const cmdItems = c.notifications.filter((n) => n.method === "item/completed" && n.params.item?.type === "commandExecution").map((n) => n.params.item.status);
console.log(JSON.stringify({
  serverRequests: c.serverRequests.map((s) => s.method),
  resolved, commandStatuses: cmdItems,
  fileCreated: fs.existsSync(`${empty}/made-by-probe.txt`),
  turnStatus: r.status,
}, null, 2));
c.close();
