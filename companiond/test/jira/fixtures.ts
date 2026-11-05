// SYNTHETIC FIXTURE — Jira REST shapes with made-up content. Never real Jira data.
import type { FetchFn } from "../../src/jira/client.ts";
import type { JiraCredentials } from "../../src/jira/credentials.ts";

export const CREDS: JiraCredentials = { site: "example-synthetic.atlassian.net", email: "someone@example.invalid", token: "SYNTHETIC-TOKEN-0123456789abcdef" };
export const CLOUD_ID = "11111111-2222-4333-8444-555555555555";

const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

export const ISSUE = {
  key: "SYN-1",
  fields: {
    summary: "SYNTHETIC FIXTURE summary",
    status: { name: "In Progress" },
    issuetype: { name: "Task" },
    priority: { name: "Medium" },
    assignee: { displayName: "Synthetic Person" },
    reporter: { displayName: "Synthetic Reporter" },
    labels: ["synthetic"],
    created: "2026-11-01T10:00:00.000+0000",
    updated: "2026-11-02T10:00:00.000+0000",
    parent: { key: "SYN-0" },
    description: adf("SYNTHETIC FIXTURE description <b>with tags</b> & ampersands"),
  },
};
export const SEARCH = { issues: [{ key: "SYN-1", fields: { summary: "First", status: { name: "Done" }, issuetype: { name: "Bug" }, assignee: null, updated: "2026-11-02T10:00:00.000+0000" } }], isLast: true };
export const COMMENTS = { comments: [{ author: { displayName: "Synthetic Person" }, created: "2026-11-03T09:00:00.000+0000", body: adf("SYNTHETIC FIXTURE comment") }], total: 1 };

export interface Call { url: string; method: string; headers: Record<string, string>; redirect: string }

/** A fake fetch: routes by URL suffix, records every call. */
export function fakeFetch(routes: Record<string, { status: number; body: unknown } | Error>): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, redirect: init.redirect });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return { status: 404, text: async () => "{}" };
    const r = hit[1];
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  return { fetch, calls };
}
export const tenantRoute = { "/_edge/tenant_info": { status: 200, body: { cloudId: CLOUD_ID } } };
