import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSecret, encodeSecret, ISSUE_KEY, JiraInputError, normalizeSite, parseCredentials, redactedCredentials } from "../../src/jira/credentials.ts";
import { CREDS } from "./fixtures.ts";

test("site: bare host or https URL, lower-cased; anything else refused", () => {
  assert.equal(normalizeSite("Example-Synthetic.atlassian.net"), "example-synthetic.atlassian.net");
  assert.equal(normalizeSite("https://example-synthetic.atlassian.net/"), "example-synthetic.atlassian.net");
  for (const bad of ["http://x.atlassian.net", "x.atlassian.net.evil.com", "evil.com", "a b.atlassian.net", "-x.atlassian.net",
    "https://x.atlassian.net/path", "https://user@x.atlassian.net", "x.atlassian.net:443", "", "atlassian.net"]) {
    assert.throws(() => normalizeSite(bad), JiraInputError, bad);
  }
});

test("credentials: validated; error messages never contain the input", () => {
  assert.deepEqual(parseCredentials({ site: CREDS.site, email: CREDS.email, token: CREDS.token }), CREDS);
  for (const p of [
    { site: CREDS.site, email: "no-at-sign", token: CREDS.token },
    { site: CREDS.site, email: CREDS.email, token: "short" },
    { site: CREDS.site, email: CREDS.email, token: "has space in it 0123456789" },
    { site: CREDS.site, email: CREDS.email, token: 42 },
    { site: CREDS.site, email: CREDS.email, token: "x".repeat(2049) },
  ]) {
    try {
      parseCredentials(p);
      assert.fail("accepted");
    } catch (e) {
      assert.ok(e instanceof JiraInputError);
      assert.ok(!String(e.message).includes(String(p.token)) && !e.message.includes("no-at-sign"));
    }
  }
});

test("secret line: one JSON line, round-trips, and rejects junk; redacted form hides the token", () => {
  const line = encodeSecret(CREDS);
  assert.ok(line.endsWith("\n") && line.indexOf("\n") === line.length - 1);
  assert.deepEqual(decodeSecret(line), CREDS);
  assert.throws(() => decodeSecret("not json"), JiraInputError);
  assert.throws(() => decodeSecret(`${JSON.stringify({ ...CREDS, site: "evil.com" })}\n`), JiraInputError);
  assert.throws(() => decodeSecret("x".repeat(9000)), JiraInputError);
  assert.deepEqual(redactedCredentials(CREDS), { site: CREDS.site, email: CREDS.email, token: "<hidden>" });
  assert.ok(!JSON.stringify(redactedCredentials(CREDS)).includes(CREDS.token));
});

test("issue keys", () => {
  for (const k of ["SYN-1", "AB_2-99", "X-1234567890"]) assert.ok(ISSUE_KEY.test(k), k);
  for (const k of ["syn-1", "SYN-0", "SYN-", "-1", "SYN-1/../x", "SYN-1?x", "SYN 1", "1SYN-1"]) assert.ok(!ISSUE_KEY.test(k), k);
});
