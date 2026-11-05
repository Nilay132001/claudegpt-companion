// The Jira credential (owner ruling B, M6): site + email + scoped read-only API token. It lives in memory only: the
// app's Keychain item → jira.configure (stdio) → JiraService → fd 3 of companion-jira. Error messages are fixed and
// never contain the input.
export interface JiraCredentials { site: string; email: string; token: string }

export class JiraInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraInputError";
  }
}

const SITE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;
const EMAIL = /^[^\s@\u0000-\u001f\u007f]{1,64}@[^\s@\u0000-\u001f\u007f]{1,189}$/;
const TOKEN = /^[\x21-\x7e]{16,2048}$/;
/** Jira project keys: an upper-case letter, then letters, digits or _; the number has no leading zero. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,9}$/;
export const MAX_JQL = 1000;
export const MAX_RESULTS = 20;
const MAX_SECRET_BYTES = 8192;

export function normalizeSite(input: string): string {
  let s = input.trim().toLowerCase();
  if (s.startsWith("https://")) {
    s = s.slice("https://".length);
    if (s.endsWith("/")) s = s.slice(0, -1);
  }
  if (!SITE.test(s)) throw new JiraInputError("The Jira site must look like your-team.atlassian.net.");
  return s;
}

export function parseCredentials(p: { site: unknown; email: unknown; token: unknown }): JiraCredentials {
  if (typeof p.site !== "string") throw new JiraInputError("The Jira site must look like your-team.atlassian.net.");
  const site = normalizeSite(p.site);
  if (typeof p.email !== "string" || !EMAIL.test(p.email.trim())) throw new JiraInputError("The Atlassian account email does not look like an email address.");
  if (typeof p.token !== "string" || !TOKEN.test(p.token)) throw new JiraInputError("The API token must be 16 to 2048 visible characters with no spaces.");
  return { site, email: p.email.trim(), token: p.token };
}

export function encodeSecret(c: JiraCredentials): string {
  return `${JSON.stringify({ site: c.site, email: c.email, token: c.token })}\n`;
}

export function decodeSecret(raw: string): JiraCredentials {
  if (Buffer.byteLength(raw) > MAX_SECRET_BYTES) throw new JiraInputError("The Jira credential is too large.");
  let o: unknown;
  try {
    o = JSON.parse(raw.trim());
  } catch {
    throw new JiraInputError("The Jira credential could not be read.");
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new JiraInputError("The Jira credential could not be read.");
  const r = o as Record<string, unknown>;
  return parseCredentials({ site: r.site, email: r.email, token: r.token });
}

export function redactedCredentials(c: JiraCredentials): { site: string; email: string; token: "<hidden>" } {
  return { site: c.site, email: c.email, token: "<hidden>" };
}
