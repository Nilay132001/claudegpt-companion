import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECK_DETAILS, JiraService } from "../../src/jira/jiraService.ts";
import { JiraInputError } from "../../src/jira/credentials.ts";
import { CREDS } from "./fixtures.ts";

function svc(o: { check?: (s: string) => Promise<{ ok: boolean; kind?: string }>; noBinding?: boolean } = {}) {
  const set: unknown[] = [];
  const s = new JiraService({
    host: { setJira: (j) => void set.push(j) },
    binding: o.noBinding ? null : (secret) => ({ launch: { command: "/x", args: [], env: {}, cwd: "/" }, validator: { command: "/v", args: [], env: {}, cwd: "/" }, secret }),
    runCheck: o.check ?? (async () => ({ ok: true })),
  });
  return { s, set };
}

test("configure keeps the credential in memory, binds the host, and status never shows the token", () => {
  const { s, set } = svc();
  assert.deepEqual(s.status(), { configured: false, site: null, email: null });
  const st = s.configure({ site: `https://${CREDS.site}/`, email: CREDS.email, token: CREDS.token });
  assert.deepEqual(st, { configured: true, site: CREDS.site, email: CREDS.email });
  assert.equal((set[0] as any).secret, `${JSON.stringify(CREDS)}\n`);
  assert.ok(!JSON.stringify(s).includes(CREDS.token), "JSON.stringify of the service hides the token");
  assert.ok(!JSON.stringify(s.status()).includes(CREDS.token));
});

test("clear unbinds; bad input changes nothing", () => {
  const { s, set } = svc();
  s.configure(CREDS);
  assert.throws(() => s.configure({ ...CREDS, token: "short" }), JiraInputError);
  assert.equal(s.status().configured, true, "a bad configure keeps the old credential");
  assert.deepEqual(s.clear(), { configured: false, site: null, email: null });
  assert.equal(set.at(-1), null);
});

test("without a launch (no macOS toolchain) configure still stores but the host gets nothing", () => {
  const { s, set } = svc({ noBinding: true });
  s.configure(CREDS);
  assert.deepEqual(set, [null]);
});

test("check maps the runner's answer to fixed details", async () => {
  assert.deepEqual(await svc().s.check(), { ok: false, detail: CHECK_DETAILS.setup });
  const { s } = svc({ check: async () => ({ ok: false, kind: "auth" }) });
  s.configure(CREDS);
  assert.deepEqual(await s.check(), { ok: false, detail: CHECK_DETAILS.auth });
  const ok = svc({ check: async () => ({ ok: true }) });
  ok.s.configure(CREDS);
  assert.deepEqual(await ok.s.check(), { ok: true, detail: CHECK_DETAILS.ok });
  const weird = svc({ check: async () => ({ ok: false, kind: `x ${CREDS.token}` }) });
  weird.s.configure(CREDS);
  assert.deepEqual(await weird.s.check(), { ok: false, detail: CHECK_DETAILS.network });
  const thrown = svc({ check: async () => { throw new Error(CREDS.token); } });
  thrown.s.configure(CREDS);
  assert.deepEqual(await thrown.s.check(), { ok: false, detail: CHECK_DETAILS.network });
});
