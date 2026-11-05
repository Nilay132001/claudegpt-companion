// M6: the self-check with real Codex for the relayed companion-jira (spec §11, §14). No login, no Jira network: the
// Jira server is a SYNTHETIC FIXTURE (fixtures/fakeJiraServer.ts) behind the real relay, acceptor and the Jira
// validator. Each case runs the production CodexHost (pass/fail, stop) and, where the tool list itself is the
// measurement, one raw app-server with the same config, relay and grant so mcpServerStatus/list can be read directly.
// Run: cd companiond && COMPANION_ITEST=1 node --test --test-concurrency=1 itest/jira.itest.ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppPaths } from "../src/app/appPaths.ts";
import { inertOverride, relayOverride } from "../src/codex/binding.ts";
import { prepareCodeMode, snapshotProtectedFiles } from "../src/codex/codeMode.ts";
import { CodexHost, type JiraBinding } from "../src/codex/codexHost.ts";
import { companionHostOptions, startCompanionRelay } from "../src/codex/companionCodex.ts";
import { findCodex } from "../src/codex/codexInstall.ts";
import { buildCodexLaunch } from "../src/codex/codexSeatbelt.ts";
import { tomlKey, writeCodexConfig } from "../src/codex/config.ts";
import { DEVELOPER_INSTRUCTIONS } from "../src/codex/instructions.ts";
import { SERVER_NAME } from "../src/jail/mcpServer.ts";
import { JIRA_SERVER_NAME, JIRA_TOOL_NAMES } from "../src/jira/tools.ts";
import type { LaunchSpec } from "../src/launch/seatbelt.ts";
import { discoverToolchain, type Toolchain } from "../src/launch/toolchain.ts";
import type { BrokerEvent } from "../src/relay/broker.ts";
import { buildValidatorLaunch } from "../src/relay/validatorProfile.ts";
import { removeTempDirs } from "../test/helpers/fixtures.ts";
import { startAppServer, threadTools } from "./helpers/appServer.ts";
import { freshPaths, skipUnless, sleep } from "./helpers/companion.ts";

const skip = skipUnless({ live: false });
after(removeTempDirs);

const FAKE = fileURLToPath(new URL("./fixtures/fakeJiraServer.ts", import.meta.url));
const SECRET = "SYNTHETIC-SECRET\n";
const THREE = [...JIRA_TOOL_NAMES].sort();

function fakeLaunch(tc: Toolchain, extra: boolean): LaunchSpec {
  return { command: tc.nodePath, args: [FAKE], env: { PATH: "/usr/bin:/bin", ...(extra ? { FAKE_JIRA_EXTRA: "1" } : {}) }, cwd: "/" };
}

const binding = (tc: Toolchain, extra: boolean): JiraBinding => ({ launch: fakeLaunch(tc, extra), validator: buildValidatorLaunch(tc, JIRA_TOOL_NAMES), secret: SECRET });

/** config.toml with companion-jira's enabled_tools line removed (the flag-flip pattern); every other line unchanged. */
function dropJiraEnabledTools(codexHome: string): void {
  const file = path.join(codexHome, "config.toml");
  const toml = fs.readFileSync(file, "utf8");
  const header = `[mcp_servers.${tomlKey(JIRA_SERVER_NAME)}]`;
  const at = toml.indexOf(header);
  assert.ok(at >= 0, "companion-jira section");
  const out = toml.slice(0, at) + toml.slice(at).replace(/^enabled_tools = .*\n/m, "");
  assert.notEqual(out, toml);
  writeCodexConfig(codexHome, out);
}

/** The production CodexHost; with dropEnabledTools, prepare() removes companion-jira's enabled_tools after writing the
 * config and re-snapshots the protected files (itest only: production prepare has no such step). */
async function startHost(o: { paths: AppPaths; tc: Toolchain; dropEnabledTools?: boolean }) {
  const install = findCodex();
  const { acceptor, relay } = await startCompanionRelay(o.paths, o.tc);
  const events: string[] = [];
  acceptor.on((e: BrokerEvent) => events.push(e.type === "closed" ? `closed:${e.end}` : e.type));
  const opts = companionHostOptions({ paths: o.paths, install, toolchain: o.tc, home: os.homedir() }, acceptor, relay);
  const prepare = opts.prepare;
  const host = new CodexHost({
    ...opts,
    prepare: o.dropEnabledTools
      ? () => {
          const p = prepare();
          dropJiraEnabledTools(o.paths.codexHome);
          return { ...p, protectedFiles: snapshotProtectedFiles(o.paths.codexHome) };
        }
      : prepare,
  });
  return { host, events, close: async () => { await host.stop(); await acceptor.stop(); } };
}

/** One raw app-server under the production profile and config, the same relay and acceptor, one Jira grant. */
async function rawJiraThread(o: { tc: Toolchain; extra: boolean; dropEnabledTools?: boolean }) {
  const paths = freshPaths();
  const install = findCodex();
  const { acceptor, relay } = await startCompanionRelay(paths, o.tc);
  const events: string[] = [];
  acceptor.on((e: BrokerEvent) => events.push(e.type === "closed" ? `closed:${e.end}` : e.type === "refused" ? `refused:${e.reason}` : e.type));
  const prep = prepareCodeMode({ install, paths });
  assert.deepEqual(prep.result.failures, []);
  if (o.dropEnabledTools) dropJiraEnabledTools(paths.codexHome);
  const a = await startAppServer(buildCodexLaunch({ install, paths, sandboxed: true, relay }));
  try {
    const b = binding(o.tc, o.extra);
    const grant = acceptor.grant(b.launch, { validator: b.validator, secret: b.secret });
    const cwd = paths.emptyCwd;
    const ts: any = await a.rpc.request("thread/start", {
      cwd, sandbox: "read-only", approvalPolicy: "untrusted", developerInstructions: DEVELOPER_INSTRUCTIONS, ephemeral: true,
      config: { ...inertOverride(SERVER_NAME), ...relayOverride(relay.binary, grant.token, cwd, JIRA_SERVER_NAME) },
    });
    grant.arm();
    const threadId = String(ts?.thread?.id ?? "");
    assert.ok(threadId);
    return { a, grant, events, threadId, close: async () => { a.kill(); await acceptor.stop(); } };
  } catch (e) {
    a.kill();
    await acceptor.stop();
    throw e;
  }
}

test("(a) a thread with the Jira binding opens; companion-jira lists exactly the three read tools", { skip }, async () => {
  const tc = discoverToolchain();
  const h = await startHost({ paths: freshPaths(), tc });
  try {
    assert.equal((await h.host.start()).state, "ready");
    h.host.setJira(binding(tc, false));
    await h.host.openThread(null, null); // SecurityCheckError on any mismatch
    console.log(JSON.stringify({ case: "a/host", broker: h.events, state: h.host.state().state }));
    assert.ok(h.events.includes("bound"));
    assert.equal(h.host.state().state, "ready");
  } finally {
    await h.close();
  }
  const r = await rawJiraThread({ tc, extra: false });
  try {
    const st = await threadTools(r.a, r.threadId, JIRA_SERVER_NAME);
    console.log(JSON.stringify({ case: "a/raw", tools: st.tools, serverInfo: st.serverInfo, error: st.error, broker: r.events }));
    assert.deepEqual([...st.tools].sort(), THREE);
    assert.equal(st.serverInfo?.version, JSON.stringify({ fd3: true }));
  } finally {
    await r.close();
  }
});

test("(b) with FAKE_JIRA_EXTRA=1, enabled_tools hides createJiraIssue: the status lists only the three, the thread opens", { skip }, async () => {
  const tc = discoverToolchain();
  const h = await startHost({ paths: freshPaths(), tc });
  try {
    assert.equal((await h.host.start()).state, "ready");
    h.host.setJira(binding(tc, true));
    let err: unknown = null;
    await h.host.openThread(null, null).catch((e) => (err = e));
    const s = h.host.state();
    console.log(JSON.stringify({ case: "b/host", broker: h.events, state: s.state, detail: s.state === "failed" ? s.detail : null, error: err instanceof Error ? err.message : null }));
    assert.equal(err, null);
    assert.equal(s.state, "ready");
  } finally {
    await h.close();
  }
  const r = await rawJiraThread({ tc, extra: true });
  try {
    const st = await threadTools(r.a, r.threadId, JIRA_SERVER_NAME);
    console.log(JSON.stringify({ case: "b/raw", tools: st.tools, error: st.error, broker: r.events }));
    assert.deepEqual([...st.tools].sort(), THREE);
  } finally {
    await r.close();
  }
});

test("(c) with enabled_tools removed, the extra write tool shows and the self-check stops the host", { skip }, async () => {
  const tc = discoverToolchain();
  // Negative control: the fixture really lists createJiraIssue when enabled_tools does not hide it.
  const r = await rawJiraThread({ tc, extra: true, dropEnabledTools: true });
  try {
    const st = await threadTools(r.a, r.threadId, JIRA_SERVER_NAME);
    console.log(JSON.stringify({ case: "c/raw", tools: st.tools, error: st.error, broker: r.events }));
    assert.ok(st.tools.includes("createJiraIssue"));
  } finally {
    await r.close();
  }
  const h = await startHost({ paths: freshPaths(), tc, dropEnabledTools: true });
  try {
    assert.equal((await h.host.start()).state, "ready");
    h.host.setJira(binding(tc, true));
    await assert.rejects(h.host.openThread(null, null), /looks like a write tool/);
    const s = h.host.state();
    console.log(JSON.stringify({ case: "c/host", broker: h.events, state: s.state, detail: s.state === "failed" ? s.detail : null }));
    assert.equal(s.state, "failed");
    assert.match(s.state === "failed" ? s.detail : "", /MCP tool companion-jira\/createJiraIssue looks like a write tool/);
  } finally {
    await h.close();
  }
});

test("(d) measurement: the Jira grant revoked under a loaded thread, then the thread's companion-jira status by serverName", { skip }, async () => {
  // Models setJira(null) on a loaded thread: CodexHost revokes the thread's Jira grant at once (#dropJiraGrant). The
  // acceptor's "refused" event is what CodexHost turns into a latched security stop (#onBroker). Recorded, not judged.
  const tc = discoverToolchain();
  const r = await rawJiraThread({ tc, extra: false });
  try {
    const before = await threadTools(r.a, r.threadId, JIRA_SERVER_NAME);
    r.grant.revoke();
    for (let t = 0; t < 2000 && !r.events.some((e) => e.startsWith("closed:")); t += 50) await sleep(50);
    let after: unknown;
    try {
      after = await threadTools(r.a, r.threadId, JIRA_SERVER_NAME);
    } catch (e) {
      after = { rpcError: e instanceof Error ? e.message : String(e) };
    }
    await sleep(2000); // any relay re-exec reaches the acceptor within this
    const refused = r.events.filter((e) => e.startsWith("refused"));
    console.log(JSON.stringify({ case: "d/raw", before: before.tools, after, broker: r.events, hostWouldStop: refused.length > 0 }));
    assert.deepEqual([...before.tools].sort(), THREE);
  } finally {
    await r.close();
  }
});
