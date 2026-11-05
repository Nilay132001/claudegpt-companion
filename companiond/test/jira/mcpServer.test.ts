import { test } from "node:test";
import assert from "node:assert/strict";
import { handleJiraMessage, type JiraServerState } from "../../src/jira/mcpServer.ts";
import { isWriteShapedTool, JIRA_TOOL_DEFS, JIRA_TOOL_NAMES, runJiraTool, type JiraApi } from "../../src/jira/tools.ts";
import { JiraError } from "../../src/jira/client.ts";
import { COMMENTS, ISSUE, SEARCH } from "./fixtures.ts";

function api(over: Partial<JiraApi> = {}): JiraApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    issue: async (k) => (calls.push(`issue:${k}`), ISSUE),
    search: async (q, m) => (calls.push(`search:${q}:${m}`), SEARCH),
    comments: async (k, m) => (calls.push(`comments:${k}:${m}`), COMMENTS),
    ...over,
  };
}
const ready = (a: JiraApi): JiraServerState => ({ kind: "ready", api: a });
const call = (state: JiraServerState, name: string, args: unknown) => handleJiraMessage(state, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const text = (r: any): string => r.result.content[0].text;

test("tools/list is exactly the three read tools, all read-only, none write-shaped", async () => {
  const r: any = await handleJiraMessage(ready(api()), { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(r.result.tools.map((t: any) => t.name), [...JIRA_TOOL_NAMES]);
  for (const t of JIRA_TOOL_DEFS) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(isWriteShapedTool(t.name), false, t.name);
  }
});

test("write-shaped names are recognised, including Atlassian's own write tools", () => {
  for (const n of ["createJiraIssue", "editJiraIssue", "transitionJiraIssue", "addCommentToJiraIssue", "addWorklogToJiraIssue", "createIssueLink",
    "updateConfluencePage", "jira_delete_issue", "assign_issue", "write_file", "jira_add_comment", "comment", "postComment", "jira_set_status",
    "jira_get_issue_and_delete", "read_then_write_file", "search_and_transition", "JIRADeleteIssue"]) {
    assert.equal(isWriteShapedTool(n), true, n);
  }
  for (const n of ["jira_get_issue", "jira_search", "jira_get_comments", "getJiraIssue", "searchJiraIssuesUsingJql", "list_dir", "read_file", "search", "git_status", "git_diff", "listComments"]) {
    assert.equal(isWriteShapedTool(n), false, n);
  }
});

test("calls reach the API with checked arguments and default limits", async () => {
  const a = api();
  assert.ok(text(await call(ready(a), "jira_get_issue", { key: "SYN-1" })).includes("SYNTHETIC FIXTURE summary"));
  assert.ok(text(await call(ready(a), "jira_search", { jql: "project = SYN" })).includes("JQL: project = SYN"));
  assert.ok(text(await call(ready(a), "jira_get_comments", { key: "SYN-1", max_results: 3 })).includes("SYNTHETIC FIXTURE comment"));
  assert.deepEqual(a.calls, ["issue:SYN-1", "search:project = SYN:10", "comments:SYN-1:3"]);
});

test("bad arguments, unknown tools and API errors are tool errors with fixed text", async () => {
  const a = api({ issue: async () => { throw new JiraError("auth"); } });
  for (const [n, args] of [["jira_get_issue", { key: "syn-1" }], ["jira_get_issue", {}], ["jira_search", { jql: 5 }], ["jira_search", { jql: "x", max_results: 99 }],
    ["jira_get_comments", { key: "SYN-1", extra: 1 }], ["jira_create_issue", {}]] as const) {
    const r: any = await call(ready(a), n, args);
    assert.equal(r.result.isError, true, `${n} ${JSON.stringify(args)}`);
  }
  const r: any = await call(ready(a), "jira_get_issue", { key: "SYN-1" });
  assert.equal(r.result.isError, true);
  assert.match(text(r), /refused the API token/);
  const other: any = await call(ready(api({ issue: async () => { throw new Error("SYNTHETIC internal detail"); } })), "jira_get_issue", { key: "SYN-1" });
  assert.equal(text(other), "Jira could not be read.");
  const refused: any = await call({ kind: "refused", reason: "Jira is not set up." }, "jira_get_issue", { key: "SYN-1" });
  assert.equal(text(refused), "Jira is not set up.");
});

test("initialize names the server; notifications get no reply; unknown methods are -32601", async () => {
  const init: any = await handleJiraMessage(ready(api()), { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "companion-jira");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(await handleJiraMessage(ready(api()), { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const unknown: any = await handleJiraMessage(ready(api()), { jsonrpc: "2.0", id: 2, method: "resources/list" });
  assert.equal(unknown.error.code, -32601);
});

test("runJiraTool never calls the API for an unknown tool", async () => {
  const a = api();
  assert.equal((await runJiraTool(a, "jira_get_issue_and_delete", { key: "SYN-1" })).isError, true);
  assert.deepEqual(a.calls, []);
});
