// companion-jira's tools (owner ruling B): three fixed read tools, nothing else.
import { JiraError } from "./client.ts";
import { ISSUE_KEY, MAX_JQL, MAX_RESULTS } from "./credentials.ts";
import { formatComments, formatIssue, formatSearch } from "./format.ts";

export const JIRA_SERVER_NAME = "companion-jira";
export const JIRA_TOOL_NAMES = ["jira_get_issue", "jira_search", "jira_get_comments"] as const;
export type JiraToolName = (typeof JIRA_TOOL_NAMES)[number];
export interface JiraApi {
  issue(key: string): Promise<unknown>;
  search(jql: string, max: number): Promise<unknown>;
  comments(key: string, max: number): Promise<unknown>;
}

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const keyProp = { type: "string", pattern: ISSUE_KEY.source, description: "Issue key, for example ABC-123." };
const maxProp = { type: "integer", minimum: 1, maximum: MAX_RESULTS };
export const DEFAULT_RESULTS = 10;

export const JIRA_TOOL_DEFS = [
  {
    name: "jira_get_issue",
    description: "Read one Jira issue: summary, status, type, people, dates and description. Read-only.",
    inputSchema: { type: "object", properties: { key: keyProp }, required: ["key"], additionalProperties: false },
    annotations,
  },
  {
    name: "jira_search",
    description: `Search Jira issues with JQL. Returns up to ${MAX_RESULTS} issues (default ${DEFAULT_RESULTS}): key, summary, status, type, assignee, updated. Read-only.`,
    inputSchema: { type: "object", properties: { jql: { type: "string", minLength: 1, maxLength: MAX_JQL }, max_results: maxProp }, required: ["jql"], additionalProperties: false },
    annotations,
  },
  {
    name: "jira_get_comments",
    description: `Read the newest comments on a Jira issue (up to ${MAX_RESULTS}, default ${DEFAULT_RESULTS}). Read-only.`,
    inputSchema: { type: "object", properties: { key: keyProp, max_results: maxProp }, required: ["key"], additionalProperties: false },
    annotations,
  },
];

const WRITE_TOKENS = new Set(["create", "edit", "update", "transition", "add", "delete", "remove", "assign", "worklog", "post", "put", "patch",
  "write", "set", "move", "link", "upload", "archive", "comment", "send", "submit", "merge", "close", "resolve"]);
const READ_TOKENS = new Set(["get", "list", "read", "search", "fetch", "lookup", "status", "diff"]);

/** True for a name that looks like it changes something: any token is a write verb. The one exception is
 * comment/comments, a noun as much as a verb: it counts only when no read verb (get/list/read/search…) comes before
 * it, so jira_get_comments and listComments pass while addCommentToJiraIssue and postComment do not (spec §11, M6).
 * Tokens are whole words, split on separators, camelCase and acronym runs (JIRADeleteIssue → jira, delete, issue). */
export function isWriteShapedTool(name: string): boolean {
  const tokens = name.split(/[_\-.\s]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  let sawRead = false;
  for (const t of tokens) {
    if (t === "comment" || t === "comments") {
      if (!sawRead) return true;
    } else if (WRITE_TOKENS.has(t)) return true;
    if (READ_TOKENS.has(t)) sawRead = true;
  }
  return false;
}

const fail = (text: string) => ({ text, isError: true });
const ARGS: Record<JiraToolName, readonly string[]> = { jira_get_issue: ["key"], jira_search: ["jql", "max_results"], jira_get_comments: ["key", "max_results"] };

export async function runJiraTool(api: JiraApi, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  if (!(JIRA_TOOL_NAMES as readonly string[]).includes(name)) return fail("Unknown tool.");
  const tool = name as JiraToolName;
  if (Object.keys(args).some((k) => !ARGS[tool].includes(k))) return fail("Unexpected argument.");
  const max = args.max_results ?? DEFAULT_RESULTS;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_RESULTS) return fail(`max_results must be 1 to ${MAX_RESULTS}.`);
  try {
    if (tool === "jira_search") {
      if (typeof args.jql !== "string" || args.jql.trim() === "" || args.jql.length > MAX_JQL) return fail(`jql must be 1 to ${MAX_JQL} characters.`);
      return { text: formatSearch(args.jql, await api.search(args.jql, max)), isError: false };
    }
    if (typeof args.key !== "string" || !ISSUE_KEY.test(args.key)) return fail("key must be an issue key like ABC-123.");
    if (tool === "jira_get_issue") return { text: formatIssue(await api.issue(args.key)), isError: false };
    return { text: formatComments(args.key, await api.comments(args.key, max)), isError: false };
  } catch (e) {
    return fail(e instanceof JiraError ? e.message : "Jira could not be read.");
  }
}
