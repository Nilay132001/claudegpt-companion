// Real Codex 0.166.0 under the PRODUCTION profile and code-mode config (M4a Task 8). Prints verdicts, errno names
// and model slugs only — never tokens, credentials or file contents.
// No login: cd companiond && COMPANION_ITEST=1 node --test --test-concurrency=1 itest/codeMode.itest.ts
// Signed in (the exec-cell gate): add COMPANION_ITEST_LIVE=1. Uses the companion's own CODEX_HOME.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { liveRunner, prepareCodeMode, promptInputArgs, parseToolSurface } from "../src/codex/codeMode.ts";
import { findCodex } from "../src/codex/codexInstall.ts";
import { buildCodexLaunch, buildCodexProfile, LOGIN_CALLBACK_PORT, LOOPBACK_DENY } from "../src/codex/codexSeatbelt.ts";
import { startAppServer } from "./helpers/appServer.ts";
import { CATALOG_FILE, CODE_MODE_OFF_FEATURES, CODEX_PROTECTED_FILES, OFF_FEATURES, writeCodexConfig, writeCodexHomeFile } from "../src/codex/config.ts";
import { checkCodeModeConfig, checkConfigLayers, checkConfigRead, checkFeatureList, checkMcpStatus } from "../src/codex/selfCheck.ts";
import { COMPANION_ALLOWLIST } from "../src/codex/serverRequests.ts";
import { SERVER_NAME } from "../src/jail/mcpServer.ts";
import { SANDBOX_EXEC } from "../src/launch/seatbelt.ts";
import { ensureRelayDirs, relayPaths } from "../src/relay/relayPaths.ts";
import { MARK, makeRepo, removeTempDirs, tempDir } from "../test/helpers/fixtures.ts";
import { controlRowOk } from "../test/helpers/gateEval.ts";
import { startSession } from "./helpers/codeModeSession.ts";
import { freshPaths, isSignedIn, ownPaths, skipUnless } from "./helpers/companion.ts";
import { runExecCellGate } from "./helpers/execCellGate.ts";

after(removeTempDirs);
const noLogin = skipUnless({ live: false });
const live = skipUnless({ live: true });
const DENIED = /^(EPERM|EACCES)$/;

test("the generated catalog and the offline tool surface pass on the pinned binary", { skip: noLogin }, () => {
  const paths = freshPaths();
  const t0 = Date.now();
  const prep = prepareCodeMode({ install: findCodex(), paths });
  console.log(JSON.stringify({ models: prep.models, failures: prep.result.failures, ms: Date.now() - t0 }));
  assert.deepEqual(prep.result.failures, []);
  assert.ok(prep.models.length > 0);
  for (const m of JSON.parse(fs.readFileSync(path.join(paths.codexHome, CATALOG_FILE), "utf8")).models) {
    assert.equal(m.multi_agent_version, null);
    assert.equal(m.apply_patch_tool_type, null);
  }
});

test("app-server under the production profile: config/read shows the code-mode config; a bound thread has the five tools", { skip: noLogin }, async () => {
  const paths = freshPaths();
  const s = await startSession({ paths, root: makeRepo() });
  try {
    const cfg = await s.a.rpc.request("config/read", { includeLayers: true, cwd: paths.emptyCwd });
    const features: any = await s.a.rpc.request("experimentalFeature/list", { limit: 200 });
    // serverName is required: without it Codex re-spawns the thread's servers and the one-time token is refused.
    const st: any = await s.a.rpc.request("mcpServerStatus/list", { threadId: s.threadId, serverName: SERVER_NAME });
    const report = {
      configRead: checkConfigRead(cfg, [...OFF_FEATURES, ...CODE_MODE_OFF_FEATURES]).failures,
      configLayers: checkConfigLayers(cfg, paths.codexHome).failures,
      codeMode: checkCodeModeConfig(cfg, features?.data ?? [], path.join(paths.codexHome, CATALOG_FILE)).failures,
      featureList: checkFeatureList(features?.data ?? [], OFF_FEATURES, "0.166.0").failures,
      boundTools: checkMcpStatus((st?.data ?? []).filter((e: any) => e?.name === SERVER_NAME), COMPANION_ALLOWLIST, "thread").failures,
      broker: s.brokerEvents.map((e) => e.type),
      threadModel: s.threadModel,
      threadModelChecked: s.threadModel !== null && s.models.includes(s.threadModel),
      signedIn: await isSignedIn(s.a),
    };
    console.log(JSON.stringify(report));
    assert.deepEqual([report.configRead, report.configLayers, report.codeMode, report.featureList, report.boundTools], [[], [], [], [], []]);
    assert.ok(report.broker.includes("bound"));
    assert.equal(report.broker.includes("refused"), false);
  } finally {
    await s.close();
  }
});

// MEASUREMENT ONLY: the probe sits in the relay's exec slot of an otherwise production profile, so it runs with
// exactly the rights Codex, its code-mode host and the relay have. errno is asserted, never exit codes (M8).
// dropLoopbackDeny: the negative control only (review fix round 1), the same profile minus LOOPBACK_DENY.
function probeRun(paths: ReturnType<typeof freshPaths>, actions: Array<[string, string]>, o: { login?: boolean; dropLoopbackDeny?: boolean } = {}): Record<string, string> {
  const d = tempDir("cgc-probe-");
  const probe = path.join(d, "probe");
  execFileSync("/usr/bin/xcrun", ["clang", "-O2", "-Wall", "-Werror", "-o", probe, fileURLToPath(new URL("./fixtures/probe.c", import.meta.url))], { stdio: ["ignore", "ignore", "ignore"] });
  const relay = relayPaths(paths.supportDir);
  const full = buildCodexProfile({
    install: findCodex(), codexHome: paths.codexHome, emptyCwd: paths.emptyCwd, supportDir: paths.supportDir, home: os.homedir(),
    relay: { binary: probe, socket: relay.socket }, protectedFiles: CODEX_PROTECTED_FILES, login: o.login === true,
  });
  const lines = full.split("\n");
  const kept = o.dropLoopbackDeny ? lines.filter((l) => l !== LOOPBACK_DENY) : lines;
  if (o.dropLoopbackDeny) assert.equal(lines.length - kept.length, 1, "the control drops exactly the loopback deny");
  const profile = kept.join("\n");
  const r = spawnSync(SANDBOX_EXEC, ["-p", profile, probe, ...actions.map((a) => a[1])], { env: {}, cwd: paths.emptyCwd, encoding: "utf8", timeout: 60_000 });
  const out: Record<string, string> = {};
  for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
    const j = JSON.parse(line) as { action: number; errno: string };
    out[actions[j.action - 1]?.[0] ?? "?"] = j.errno;
  }
  return out;
}

test("Seatbelt at the profile level: one relay socket, no loopback, no exec, protected files, no home", { skip: noLogin }, async () => {
  const paths = freshPaths();
  const relay = ensureRelayDirs(relayPaths(paths.supportDir));
  const hex = crypto.randomBytes(8).toString("hex");
  const homeCanary = path.join(os.homedir(), `.cgc-probe-canary-${hex}.txt`);
  fs.writeFileSync(homeCanary, `${MARK}\n`, { mode: 0o600 });
  let hits = 0;
  const relayListener = net.createServer((c) => c.destroy());
  await new Promise<void>((r) => relayListener.listen(relay.socket, r));
  const decoyDir = tempDir("cgc-decoy-");
  const decoy = net.createServer((c) => { hits++; c.destroy(); });
  await new Promise<void>((r) => decoy.listen(path.join(decoyDir, "d.sock"), r));
  const tcp = net.createServer((c) => { hits++; c.destroy(); });
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  // Local services on 443 (Docker, dev proxies: review I5 / plan review I-7) are judged from errno alone: no listener
  // on 443 is opened (review fix round 1). EPERM/EACCES = Seatbelt refused; anything else = the connect was allowed.
  // The negative control below shows the same rows are NOT refused once the loopback deny is dropped.
  const ifaces = Object.values(os.networkInterfaces()).flat();
  const ownIp = ifaces.find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? null;
  // A routable own IPv6 address (link-local ones need a scope id the probe does not take).
  const ownIp6 = ifaces.find((i) => i && i.family === "IPv6" && !i.internal && !i.address.toLowerCase().startsWith("fe80"))?.address ?? null;
  const localRows: Array<[string, string]> = [
    ["loopback443", "tcp:443"], ["loopback443v6", "tcp6:443"], ["anyAddr443", "host:0.0.0.0:443"], ["anyAddr443v6", "host:::443"],
    ...(ownIp ? [["ownIp443", `host:${ownIp}:443`] as [string, string]] : []),
    ...(ownIp6 ? [["ownIp6_443", `host:${ownIp6}:443`] as [string, string]] : []),
  ];
  const config = "# SYNTHETIC FIXTURE config\n";
  writeCodexConfig(paths.codexHome, config);
  writeCodexHomeFile(paths.codexHome, CATALOG_FILE, "{}");
  const scratch = path.join(paths.codexHome, "cgc-probe-write.txt");
  fs.writeFileSync(scratch, `${MARK}\n`);
  const repo = makeRepo();
  const h = paths.codexHome;
  try {
    const out = probeRun(paths, [
      ["relaySocket", `unix:${relay.socket}`], ["decoySocket", `unix:${path.join(decoyDir, "d.sock")}`],
      ["dnsSocket", "unix:/private/var/run/mDNSResponder"], ...localRows,
      ["loopbackListener", `tcp:${(tcp.address() as net.AddressInfo).port}`], ["bindInCodexHome", `bind:${path.join(h, "b.sock")}`],
      ["execSh", "exec:/bin/sh"], ["execNode", `exec:${fs.realpathSync.native(process.execPath)}`], ["execSandboxExec", `exec:${SANDBOX_EXEC}`],
      ["execFalse", "exec:/usr/bin/false"], ["writeConfigToml", `write:${path.join(h, "config.toml")}`], ["writeCatalog", `write:${path.join(h, CATALOG_FILE)}`],
      ["unlinkConfigToml", `unlink:${path.join(h, "config.toml")}`], ["renameOntoConfigToml", `rename:${scratch}>${path.join(h, "config.toml")}`],
      ["writeCodexHome", `write:${scratch}`], ["readHomeCanary", `read:${homeCanary}`], ["writeHomeCanary", `write:${homeCanary}`],
      ["readRepo", `read:${path.join(repo, "README.md")}`], ["unlinkRelaySocket", `unlink:${relay.socket}`],
      ["linkConfigToml", `link:${path.join(h, "config.toml")}>${path.join(h, "cfg-link.toml")}`],
      ["linkCatalog", `link:${path.join(h, CATALOG_FILE)}>${path.join(h, "cat-link.json")}`],
      ["bindLoginPort", `bindtcp:127.0.0.1:${LOGIN_CALLBACK_PORT}`],
    ]);
    // MEASUREMENT-ONLY negative control: the production profile minus the loopback deny, same local rows.
    const control = probeRun(paths, localRows, { dropLoopbackDeny: true });
    // The sign-in profile (ruling I-9), signed out: only the callback port opens.
    const login = probeRun(paths, [
      ["bindLoginPort", `bindtcp:127.0.0.1:${LOGIN_CALLBACK_PORT}`], ["bindOtherPort", `bindtcp:127.0.0.1:${LOGIN_CALLBACK_PORT + 1}`],
      ["bindLoginPortAnyAddr", `bindtcp:0.0.0.0:${LOGIN_CALLBACK_PORT}`], ["loopback443", "tcp:443"], ["execSh", "exec:/bin/sh"],
    ], { login: true });
    console.log(JSON.stringify({ profileProbe: out, loopbackDenyControl: control, loginProfileProbe: login, decoyAndLoopbackHits: hits }));
    assert.equal(out.relaySocket, "OK");
    assert.equal(out.dnsSocket, "OK");
    assert.equal(out.writeCodexHome, "OK");
    // Measured while planning (macOS 27): every row below is EPERM, including loopback, 0.0.0.0 and the Mac's own
    // address on 443 (the loopback deny is shipped, so it is asserted: plan review I-7).
    for (const k of [
      "decoySocket", "loopbackListener", "bindInCodexHome", "execSh", "execNode", "execSandboxExec", "execFalse", "writeConfigToml",
      "writeCatalog", "unlinkConfigToml", "renameOntoConfigToml", "readHomeCanary", "writeHomeCanary", "readRepo", "unlinkRelaySocket",
      "linkConfigToml", "linkCatalog", ...localRows.map((r) => r[0]), "bindLoginPort",
    ]) {
      assert.match(out[k] ?? "missing", DENIED, k);
    }
    // Without the deny the same connects reach the network stack (ECONNREFUSED: nothing listens; OK: something does):
    // the deny is what blocks them. Any other errno (unreachable, EAI, …) makes the control say nothing, so it fails.
    for (const [k] of localRows) assert.ok(controlRowOk(control[k]), `control ${k}: ${String(control[k])}`);
    assert.equal(login.bindLoginPort, "OK");
    for (const k of ["bindOtherPort", "loopback443", "execSh"]) assert.match(login[k] ?? "missing", DENIED, `login ${k}`);
    // login.bindLoginPortAnyAddr is recorded: measured OK while planning (SBPL's localhost:1455 also matches 0.0.0.0).
    assert.equal(hits, 0);
    assert.equal(fs.readFileSync(path.join(h, "config.toml"), "utf8"), config);
  } finally {
    fs.rmSync(homeCanary, { force: true });
    relayListener.close();
    decoy.close();
    tcp.close();
  }
});

test("sign-in, signed out: the production profile refuses the callback server; the sign-in profile starts it (I-9)", { skip: noLogin }, async () => {
  const paths = freshPaths();
  const install = findCodex();
  const relay = ensureRelayDirs(relayPaths(paths.supportDir));
  prepareCodeMode({ install, paths });
  const out: Record<string, string> = {};
  for (const login of [false, true]) {
    const a = await startAppServer(buildCodexLaunch({ install, paths, sandboxed: true, relay: { binary: relay.binary, socket: relay.socket }, login }));
    try {
      const r: any = await a.rpc.request("account/login/start", { type: "chatgpt" });
      // The link is not a credential, but it is never printed: only where its callback points.
      const cb = new URL(new URL(String(r?.authUrl)).searchParams.get("redirect_uri") ?? "http://none");
      out[login ? "loginProfile" : "production"] = `callback ${cb.hostname}:${cb.port}`;
      await a.rpc.request("account/login/cancel", { loginId: r?.loginId }).catch(() => undefined);
    } catch (e) {
      out[login ? "loginProfile" : "production"] = `refused: ${(e as Error).name}`;
    } finally {
      a.kill();
    }
  }
  console.log(JSON.stringify(out));
  assert.match(out.production ?? "", /^refused/);
  assert.equal(out.loginProfile, `callback 127.0.0.1:${LOGIN_CALLBACK_PORT}`);
});

test("signed in: list_dir through the relay, then the exec-cell gate", { skip: live }, async (t) => {
  const paths = ownPaths();
  const repo = makeRepo({ "pelican-ledger.txt": "ledger entries\n" });
  // rawEvents: the gate reads the cell's verdict from the exec call's own output (review fix round 1).
  const s = await startSession({ paths, root: repo, rawEvents: true });
  try {
    if (!(await isSignedIn(s.a))) return t.skip("the companion's CODEX_HOME is not signed in");
    const baseline = await s.turn("Use functions.exec to call tools.mcp__companion_readonly__list_dir({}) once, then list the file names it returned.");
    const gate = await runExecCellGate(s, { codexHome: paths.codexHome });
    const net443 = probeRun(paths, [["nonOpenAiHost443", "host:example.com:443"], ["nonOpenAiHost80", "host:example.com:80"]]);
    // Plan review I-6: can a live surface check see account- or server-gated tools? The goal tools appear only live
    // (codemode-report M2); with goals turned on for this one call they are the canary. Tool NAMES only are kept.
    const liveRun = liveRunner(findCodex(), paths, { binary: s.relay.binary, socket: s.relay.socket });
    const model = s.threadModel ?? String(s.models[0]);
    let liveSurface: Record<string, unknown>;
    try {
      const plain = parseToolSurface(liveRun(promptInputArgs(model), paths.codexHome));
      const goalsOn = parseToolSurface(liveRun(promptInputArgs(model, ["-c", "features.goals=true"]), paths.codexHome));
      liveSurface = { plain, goalsOn, liveShowsGoalTools: [...goalsOn.top, ...goalsOn.nested].some((t) => /goal/i.test(t)) };
    } catch (e) {
      liveSurface = { error: (e as Error).message };
    }
    console.log(JSON.stringify({
      threadModel: s.threadModel, threadModelChecked: s.threadModel !== null && s.models.includes(s.threadModel),
      baseline: { status: baseline.status, mcpCalls: baseline.mcpCalls, itemTypes: baseline.itemTypes, replyHasFixture: baseline.agentText.includes("pelican-ledger.txt") },
      gate, profileLevelNetwork: net443, liveSurface, alerts: s.alerts, serverRequests: s.decisions,
    }, null, 2));
    assert.ok(baseline.mcpCalls.includes("list_dir:completed"));
    assert.ok(baseline.agentText.includes("pelican-ledger.txt"));
    assert.ok(s.threadModel !== null && s.models.includes(s.threadModel), "the thread runs a model whose surface was checked");
    assert.deepEqual(gate.open, []);
    assert.equal(gate.pass, true);
    assert.deepEqual(s.alerts, []);
  } finally {
    await s.close();
  }
});
