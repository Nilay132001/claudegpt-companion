import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraClient, JiraError } from "../../src/jira/client.ts";
import { CLOUD_ID, COMMENTS, CREDS, fakeFetch, ISSUE, SEARCH, tenantRoute } from "./fixtures.ts";

const API = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3`;

test("every request is a GET with basic auth, no redirects, to the tenant URL or the API base only", async () => {
  const { fetch, calls } = fakeFetch({ ...tenantRoute, "/issue/SYN-1/comment": { status: 200, body: COMMENTS }, "/issue/SYN-1?": { status: 200, body: ISSUE }, "/search/jql": { status: 200, body: SEARCH }, "/myself": { status: 200, body: { accountId: "x" } } });
  const c = new JiraClient(CREDS, { fetch });
  await c.issue("SYN-1");
  await c.search('project = SYN AND text ~ "a&b"', 5);
  await c.comments("SYN-1", 3);
  await c.myself();
  assert.equal(calls[0]?.url, "https://example-synthetic.atlassian.net/_edge/tenant_info");
  assert.equal(calls.filter((x) => x.url.includes("tenant_info")).length, 1, "the cloudId is looked up once");
  const auth = `Basic ${Buffer.from(`${CREDS.email}:${CREDS.token}`).toString("base64")}`;
  for (const x of calls) {
    assert.equal(x.method, "GET");
    assert.equal(x.redirect, "error");
    assert.ok(x.url.startsWith("https://example-synthetic.atlassian.net/_edge/") || x.url.startsWith(`${API}/`), x.url);
    if (x.url.startsWith(API)) assert.equal(x.headers.Authorization, auth);
    else assert.equal(x.headers.Authorization, undefined, "the token never goes to the tenant_info call");
  }
  const search = new URL(calls.find((x) => x.url.includes("/search/jql"))!.url);
  assert.equal(search.searchParams.get("jql"), 'project = SYN AND text ~ "a&b"');
  assert.equal(search.searchParams.get("maxResults"), "5");
  assert.equal(new URL(calls.find((x) => x.url.includes("/comment"))!.url).searchParams.get("maxResults"), "3");
});

test("inputs are checked before any request", async () => {
  const { fetch, calls } = fakeFetch(tenantRoute);
  const c = new JiraClient(CREDS, { fetch });
  await assert.rejects(c.issue("SYN-1/../../myself"), (e: unknown) => e instanceof JiraError && e.kind === "badRequest");
  await assert.rejects(c.search("", 5), (e: unknown) => e instanceof JiraError && e.kind === "badRequest");
  await assert.rejects(c.search("x".repeat(1001), 5), (e: unknown) => e instanceof JiraError && e.kind === "badRequest");
  await assert.rejects(c.comments("SYN-1", 0), (e: unknown) => e instanceof JiraError && e.kind === "badRequest");
  await assert.rejects(c.search("a", 21), (e: unknown) => e instanceof JiraError && e.kind === "badRequest");
  assert.equal(calls.length, 0);
});

test("errors map to kinds with fixed messages that never contain the token", async () => {
  const cases: Array<[number | Error, string]> = [[401, "auth"], [403, "auth"], [404, "notFound"], [400, "badRequest"], [429, "rateLimited"], [500, "server"], [new TypeError("fetch failed"), "network"]];
  for (const [r, kind] of cases) {
    const route = r instanceof Error ? r : { status: r, body: { errorMessages: [`SYNTHETIC ${CREDS.token}`] } };
    const { fetch } = fakeFetch({ ...tenantRoute, "/issue/": route });
    await assert.rejects(new JiraClient(CREDS, { fetch }).issue("SYN-1"), (e: unknown) => {
      assert.ok(e instanceof JiraError);
      assert.equal(e.kind, kind);
      assert.ok(!e.message.includes(CREDS.token));
      return true;
    });
  }
});

test("a bad tenant_info or a missing cloudId is a site error; oversized bodies are refused", async () => {
  for (const body of [{}, { cloudId: "not-a-uuid" }, "nope"]) {
    const { fetch } = fakeFetch({ "/_edge/tenant_info": { status: 200, body } });
    await assert.rejects(new JiraClient(CREDS, { fetch }).myself(), (e: unknown) => e instanceof JiraError && e.kind === "site");
  }
  const { fetch } = fakeFetch({ "/_edge/tenant_info": { status: 404, body: {} } });
  await assert.rejects(new JiraClient(CREDS, { fetch }).myself(), (e: unknown) => e instanceof JiraError && e.kind === "site");
  const big = fakeFetch({ ...tenantRoute, "/myself": { status: 200, body: "x".repeat(2 * 1024 * 1024 + 1) } });
  await assert.rejects(new JiraClient(CREDS, { fetch: big.fetch }).myself(), (e: unknown) => e instanceof JiraError && e.kind === "tooLarge");
});

test("the client has no other HTTP verb", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../src/jira/client.ts", import.meta.url), "utf8"));
  for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) assert.ok(!src.includes(`"${verb}"`), verb);
});
