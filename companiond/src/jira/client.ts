// GET-only Jira Cloud REST client for companion-jira (owner ruling B). Scoped API tokens work only through
// api.atlassian.com/ex/jira/<cloudId>; the cloudId comes from the site's public tenant_info (no token sent there).
// fetch is injected so tests never touch the network. Messages are fixed: no token, no Jira text.
import { ISSUE_KEY, MAX_JQL, MAX_RESULTS, type JiraCredentials } from "./credentials.ts";

export type FetchFn = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; redirect: "error"; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export type JiraErrorKind = "auth" | "notFound" | "badRequest" | "rateLimited" | "network" | "site" | "tooLarge" | "server";
const MESSAGES: Record<JiraErrorKind, string> = {
  auth: "Jira refused the API token. Check it in Settings › Jira (it needs read:jira-work and read:jira-user).",
  notFound: "Jira found nothing there, or the token has no access to it.",
  badRequest: "Jira could not run that request. Check the issue key or the JQL.",
  rateLimited: "Jira is rate-limiting requests. Try again in a minute.",
  network: "Jira could not be reached.",
  site: "That Jira site could not be found.",
  tooLarge: "Jira's answer was too large.",
  server: "Jira had an error. Try again later.",
};

export class JiraError extends Error {
  readonly kind: JiraErrorKind;
  constructor(kind: JiraErrorKind) {
    super(MESSAGES[kind]);
    this.name = "JiraError";
    this.kind = kind;
  }
}

const MAX_BODY_CHARS = 2 * 1024 * 1024;
const CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_FIELDS = "summary,status,issuetype,priority,assignee,reporter,labels,created,updated,parent,description";
const SEARCH_FIELDS = "summary,status,issuetype,assignee,updated";

export class JiraClient {
  readonly #c: JiraCredentials;
  readonly #fetch: FetchFn;
  readonly #timeoutMs: number;
  readonly #apiBase: string;
  #cloudId: string | null = null;

  constructor(c: JiraCredentials, o: { fetch?: FetchFn; timeoutMs?: number; apiBase?: string } = {}) {
    this.#c = c;
    this.#fetch = o.fetch ?? (globalThis.fetch as unknown as FetchFn);
    this.#timeoutMs = o.timeoutMs ?? 15_000;
    this.#apiBase = o.apiBase ?? "https://api.atlassian.com";
  }

  toJSON(): string {
    return "JiraClient";
  }

  // async: a bad input becomes a rejection, before any request.
  async issue(key: string): Promise<unknown> {
    checkKey(key);
    return this.#api(`/issue/${encodeURIComponent(key)}`, { fields: ISSUE_FIELDS });
  }

  async search(jql: string, max: number): Promise<unknown> {
    if (typeof jql !== "string" || jql.trim().length === 0 || jql.length > MAX_JQL) throw new JiraError("badRequest");
    checkMax(max);
    return this.#api("/search/jql", { jql, maxResults: String(max), fields: SEARCH_FIELDS });
  }

  async comments(key: string, max: number): Promise<unknown> {
    checkKey(key);
    checkMax(max);
    return this.#api(`/issue/${encodeURIComponent(key)}/comment`, { orderBy: "-created", maxResults: String(max) });
  }

  async myself(): Promise<unknown> {
    return this.#api("/myself", {});
  }

  async #api(path: string, query: Record<string, string>): Promise<unknown> {
    const cloudId = await this.#resolveCloudId();
    const q = new URLSearchParams(query).toString();
    const url = `${this.#apiBase}/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3${path}${q ? `?${q}` : ""}`;
    const auth = `Basic ${Buffer.from(`${this.#c.email}:${this.#c.token}`).toString("base64")}`;
    const r = await this.#get(url, { Authorization: auth, Accept: "application/json" });
    if (r.status === 401 || r.status === 403) throw new JiraError("auth");
    if (r.status === 404) throw new JiraError("notFound");
    if (r.status === 400) throw new JiraError("badRequest");
    if (r.status === 429) throw new JiraError("rateLimited");
    if (r.status < 200 || r.status >= 300) throw new JiraError("server");
    return parseJson(r.body, "server");
  }

  async #resolveCloudId(): Promise<string> {
    if (this.#cloudId) return this.#cloudId;
    const r = await this.#get(`https://${this.#c.site}/_edge/tenant_info`, { Accept: "application/json" });
    if (r.status !== 200) throw new JiraError("site");
    const o = parseJson(r.body, "site");
    const id = typeof o === "object" && o !== null ? (o as Record<string, unknown>).cloudId : undefined;
    if (typeof id !== "string" || !CLOUD_ID.test(id)) throw new JiraError("site");
    this.#cloudId = id;
    return id;
  }

  async #get(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    let res: { status: number; text(): Promise<string> };
    let body: string;
    try {
      res = await this.#fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(this.#timeoutMs) });
      body = await res.text();
    } catch {
      throw new JiraError("network");
    }
    if (body.length > MAX_BODY_CHARS) throw new JiraError("tooLarge");
    return { status: res.status, body };
  }
}

function checkKey(key: unknown): void {
  if (typeof key !== "string" || !ISSUE_KEY.test(key)) throw new JiraError("badRequest");
}
function checkMax(max: unknown): void {
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_RESULTS) throw new JiraError("badRequest");
}
function parseJson(s: string, kind: JiraErrorKind): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new JiraError(kind);
  }
}
