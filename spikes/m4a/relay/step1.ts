// SPIKE (M4a option b) — owner relay plan, Step 1. macOS only, real Codex 0.166.0, the companion's OWN signed-in
// CODEX_HOME (appPaths(os.homedir()).codexHome), under the narrowed relay profile from profiles.ts.
// Never reads a token, auth file or Keychain item; opens no file in CODEX_HOME except config.toml (via
// writeCodexConfig); calls account/read only with refreshToken:false and keeps only account.type; never calls
// account/login/* or logout; Codex stderr is counted, never kept. Repo tools run only on a synthetic fixture repo.
// Prints one JSON object (home as ~, no temp paths, no message bodies).
// Usage (repo root): node spikes/m4a/relay/step1.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appPaths, ensureAppDirs } from "../../../companiond/src/app/appPaths.ts";
import { findCodex } from "../../../companiond/src/codex/codexInstall.ts";
import { codexEnv, sbplString } from "../../../companiond/src/codex/codexSeatbelt.ts";
import { buildCodexConfigToml, writeCodexConfig } from "../../../companiond/src/codex/config.ts";
import { RuntimeGuard, type GuardAlert } from "../../../companiond/src/codex/guard.ts";
import { checkConfigRead, checkMcpStatus, checkThreadResponse } from "../../../companiond/src/codex/selfCheck.ts";
import { OFF_FEATURES } from "../../../companiond/src/codex/config.ts";
import { COMPANION_ALLOWLIST, decideServerRequest } from "../../../companiond/src/codex/serverRequests.ts";
import { SERVER_NAME } from "../../../companiond/src/jail/mcpServer.ts";
import { SANDBOX_EXEC } from "../../../companiond/src/launch/seatbelt.ts";
import { startAppServer, type AppServer } from "../../../companiond/itest/helpers/appServer.ts";
import { makeRepo, removeTempDirs, tempDir } from "../../../companiond/test/helpers/fixtures.ts";
import { buildRelayCodexProfile } from "./profiles.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = () => crypto.randomBytes(32).toString("hex");
const kids: ChildProcess[] = [];
let tmpRoot = "";
const sysTmp = fs.realpathSync.native(os.tmpdir());
const clean = (s: string) => s.replaceAll(tmpRoot || "\u0000", "<tmp>").replaceAll(sysTmp, "$TMPDIR").replaceAll(os.homedir(), "~");
const errName = (e: unknown) => clean(`${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? ""}`).slice(0, 200);
const FIXTURE_FILE = "pelican-ledger.txt";
const HOLD_MS = 15_000;

// --- reader process (spikes/m4a/relay/reader.ts) -----------------------------------------------------------
interface Reader { p: ChildProcess; events: any[]; waitFor(pred: (e: any) => boolean, ms?: number): Promise<any> }
async function startReader(sock: string, grants: { token: string; kind: "jail"; root: string }[], holdToolsCallMs = 0): Promise<Reader> {
  const p = spawn(process.execPath, [path.join(here, "reader.ts"), sock], { stdio: ["pipe", "pipe", "ignore"] });
  kids.push(p);
  const events: any[] = [];
  let buf = "";
  p.stdout?.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      try { events.push({ ...JSON.parse(buf.slice(0, nl)), t: Date.now() }); } catch {}
      buf = buf.slice(nl + 1);
    }
  });
  p.stdin?.write(`${JSON.stringify({ grants, fake: "/dev/null", holdToolsCallMs })}\n`);
  const waitFor = async (pred: (e: any) => boolean, ms = 10_000) => {
    for (let t = 0; t < ms; t += 50) {
      const e = events.find(pred);
      if (e) return e;
      await sleep(50);
    }
    return null;
  };
  const r = { p, events, waitFor };
  if (!(await waitFor((e) => e.ev === "listening", 30_000))) throw new Error("reader did not start");
  return r;
}
async function stopReader(r: Reader): Promise<void> {
  if (r.p.exitCode !== null) return;
  const gone = new Promise<void>((res) => r.p.on("exit", () => res()));
  r.p.kill("SIGTERM");
  await Promise.race([gone, sleep(3000)]);
}
const readerSummary = (r: Reader) => ({
  methodsForwarded: [...new Set(r.events.filter((e) => e.ev === "method").map((e) => e.method))],
  refused: r.events.filter((e) => e.ev === "refused").map((e) => e.method),
  answeredLocally: r.events.filter((e) => e.ev === "answered-locally").length,
  accepted: r.events.filter((e) => e.ev === "accept").length,
  closes: r.events.filter((e) => e.ev === "close").map((e) => e.reason),
});

// --- one Codex app-server with the companion's guard and request policy -----------------------------------
interface Host {
  a: AppServer;
  alerts: GuardAlert[];
  decisions: { method: string; outcome: string; alert: string | null }[];
  itemTypes: Set<string>;
  commandExecutionItems: number;
}
const allItemTypes = new Set<string>();
let commandExecutionTotal = 0;
const allDecisions: { method: string; outcome: string }[] = [];
const allAlerts: string[] = [];

async function startHost(profile: string, install: ReturnType<typeof findCodex>, paths: ReturnType<typeof appPaths>): Promise<Host> {
  const h = {} as Host;
  h.alerts = [];
  h.decisions = [];
  h.itemTypes = new Set();
  h.commandExecutionItems = 0;
  const guard = new RuntimeGuard(COMPANION_ALLOWLIST, {
    interrupt: async (threadId, turnId) => { await h.a.rpc.request("turn/interrupt", { threadId, turnId }); },
    alert: (x) => { h.alerts.push(x); allAlerts.push(`${x.itemType}: ${clean(x.detail)}`); },
  });
  h.a = await startAppServer(
    { command: SANDBOX_EXEC, args: ["-p", profile, install.binary, "app-server"], env: codexEnv(install, paths, os.homedir()), cwd: paths.emptyCwd },
    async (method, params) => {
      const d = decideServerRequest(method, params, COMPANION_ALLOWLIST, guard.lookup);
      h.decisions.push({ method, outcome: d.outcome, alert: d.alert });
      allDecisions.push({ method, outcome: d.outcome });
      return d.reply;
    },
  );
  h.a.rpc.onNotification((method, params: any) => {
    guard.onNotification(method, params);
    if (method === "item/started") {
      const t = String(params?.item?.type ?? "?");
      h.itemTypes.add(t);
      allItemTypes.add(t);
      if (t === "commandExecution") { h.commandExecutionItems++; commandExecutionTotal++; }
    }
  });
  return h;
}

interface TurnResult { status: string; turnId: string | null; agentText: string; itemTypes: string[]; mcpCalls: { server: string; tool: string; status: string }[] }
async function runTurn(h: Host, threadId: string, text: string, opts: { timeoutMs?: number; onStarted?: (turnId: string) => void } = {}): Promise<TurnResult> {
  const n0 = h.a.notifications.length;
  const r: any = await h.a.rpc.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
  const turnId = typeof r?.turn?.id === "string" ? r.turn.id : null;
  if (turnId) opts.onStarted?.(turnId);
  const limit = opts.timeoutMs ?? 180_000;
  for (let t = 0; t < limit; t += 250) {
    const mine = h.a.notifications.slice(n0).filter((n) => n.params?.threadId === threadId);
    const done = mine.find((n) => n.method === "turn/completed");
    if (done) {
      const completed = mine.filter((n) => n.method === "item/completed").map((n) => n.params?.item);
      return {
        status: String(done.params?.turn?.status),
        // The turn's error text (Codex/OpenAI wording, not a credential); cut short and passed through clean().
        error: done.params?.turn?.error ? String(done.params.turn.error.message ?? JSON.stringify(done.params.turn.error)).slice(0, 300) : undefined,
        turnId,
        agentText: completed.filter((i) => i?.type === "agentMessage").map((i) => String(i?.text ?? "")).join("\n"),
        itemTypes: [...new Set(mine.filter((n) => n.method === "item/started").map((n) => String(n.params?.item?.type)))],
        mcpCalls: completed.filter((i) => i?.type === "mcpToolCall").map((i) => ({ server: String(i?.server), tool: String(i?.tool), status: String(i?.status) })),
      };
    }
    await sleep(250);
  }
  return { status: "no turn/completed in time", turnId, agentText: "", itemTypes: [], mcpCalls: [] };
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("macOS only");
  const install = findCodex();
  const paths = ensureAppDirs(appPaths(os.homedir()));
  tmpRoot = tempDir("cgc-step1-");
  const relayDir = path.join(tmpRoot, "r");
  fs.mkdirSync(relayDir, { mode: 0o700 });
  fs.chmodSync(relayDir, 0o700);
  const sock = path.join(relayDir, "s.sock");
  const binDir = path.join(tmpRoot, "bin");
  fs.mkdirSync(binDir, { mode: 0o700 });
  const relay = path.join(binDir, "relay");
  execFileSync("/usr/bin/xcrun", ["clang", "-O2", "-Wall", "-Werror", `-DRELAY_SOCKET="${sock}"`, "-o", relay, path.join(here, "relay.c")], { stdio: ["ignore", "ignore", "pipe"] });
  const repo = fs.realpathSync.native(makeRepo({ [FIXTURE_FILE]: "ledger entries\n", "src/notes.md": "notes\n" }));

  // The production config.toml (base companion-readonly command stays /usr/bin/false; bindings are per thread).
  writeCodexConfig(paths.codexHome, buildCodexConfigToml());

  const base = buildRelayCodexProfile({
    codexBinary: install.binary, vendorDir: install.vendorDir, codexHome: paths.codexHome, emptyCwd: paths.emptyCwd,
    supportDir: paths.supportDir, launcher: relay, relaySocket: sock,
  });
  // Candidate additions, tried in order until account/read reports "chatgpt". Each one was named by a Seatbelt
  // denial seen in the sandbox log of a previous run (never network*).
  const keychains = path.join(os.homedir(), "Library", "Keychains");
  const RULES = {
    // The login keychain file only: metadata on its folder, read on the one file.
    keychainLogin: `(allow file-read-metadata (literal ${sbplString(keychains)}))\n(allow file-read* (literal ${sbplString(path.join(keychains, "login.keychain-db"))}))\n`,
    // The whole Keychains folder read-only (codexSeatbelt.ts keychainFileReads).
    keychainReads: `(allow file-read* (subpath ${sbplString(keychains)}))\n`,
    // The system DNS resolver socket (libresolv / getaddrinfo talk to mDNSResponder over this unix socket).
    dns: '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))\n',
  };
  const variants: Record<string, string> = {
    relayStrict: base,
    relayKeychainLogin: base + RULES.keychainLogin,
    relayKeychainLoginDns: base + RULES.keychainLogin + RULES.dns,
    relayKeychainReadsDns: base + RULES.keychainReads + RULES.dns,
  };

  const T = { tool: token(), toolHost: token(), interrupt: token() };
  let reader = await startReader(sock, [], 0); // items 1–4 bind no thread; items 5–6 restart it with their grants
  const out: Record<string, any> = { codex: install.version, codexHome: clean(paths.codexHome), relaySocketInTemp: true };

  // ---- Items 1 + 2: start, config/read, account/read, per variant until one reads the credential --------------
  const tried: Record<string, any> = {};
  let profileName: string | null = null;
  for (const [name, profile] of Object.entries(variants)) {
    const r: Record<string, any> = {};
    let h: Host | null = null;
    try {
      h = await startHost(profile, install, paths);
      r.initialize = "ok";
      r.userAgentVersion = /\/(\d+\.\d+\.\d+)/.exec(String(h.a.init?.userAgent ?? ""))?.[1] ?? null;
    } catch (e) {
      r.initialize = `blocked: ${errName(e)}`;
    }
    if (h) {
      try {
        const cfg = await h.a.rpc.request<any>("config/read", { includeLayers: true, cwd: paths.emptyCwd });
        const c = checkConfigRead(cfg, OFF_FEATURES);
        r.configRead = c.failures.length ? { ok: false, failures: c.failures } : "ok";
      } catch (e) {
        r.configRead = `blocked: ${errName(e)}`;
      }
      try {
        const acct = await h.a.rpc.request<any>("account/read", { refreshToken: false });
        r.accountType = acct?.account?.type ?? null; // nothing else from the response is kept
      } catch (e) {
        r.accountType = `blocked: ${errName(e)}`;
      }
      r.stderrBytes = h.a.rpc.stats.stderrBytes;
      h.a.kill();
      await sleep(1000);
    }
    tried[name] = r;
    if (r.initialize === "ok" && r.configRead === "ok" && r.accountType === "chatgpt") {
      profileName = name;
      break;
    }
  }
  out.items1and2 = tried;
  out.profileUsed = profileName;
  out.rulesAddedToRelayProfile = profileName ? (variants[profileName] as string).slice(base.length).trim().split("\n").filter(Boolean) : [];
  if (!profileName) {
    out.stopped = "items 1–2 failed under every variant";
    return void process.stdout.write(`${JSON.stringify(out, (_k, v) => (typeof v === "string" ? clean(v) : v), 2)}\n`);
  }
  const profile = variants[profileName] as string;

  // ---- Items 3 + 4: a short turn on a persisted thread, then thread/resume in a new app-server ----------------
  // STEP1_MODEL pins thread/start's model (direct-tools probe: the bundled catalog marks every model code_mode_only
  // except gpt-5.5, whose tool_mode is null). Unset = the account default, as in the recorded Step 1 run.
  const threadParams = {
    cwd: paths.emptyCwd, sandbox: "read-only", approvalPolicy: "untrusted",
    ...(process.env.STEP1_MODEL ? { model: process.env.STEP1_MODEL } : {}),
  };
  out.model = process.env.STEP1_MODEL ?? "account default";
  let threadId = "";
  // STEP1_ONLY=tools skips items 3–4 (local iteration on items 5–6 only; the recorded run does not set it).
  if (process.env.STEP1_ONLY !== "tools") {
    const h = await startHost(profile, install, paths);
    const item3: Record<string, any> = {};
    const item4: Record<string, any> = {};
    try {
      const ts: any = await h.a.rpc.request("thread/start", threadParams);
      threadId = String(ts?.thread?.id ?? "");
      item4.threadStartCheck = checkThreadResponse(ts, paths.emptyCwd);
      const turn = await runTurn(h, threadId, "Reply with the single word OK.");
      item3.turnStatus = turn.status;
      item3.replyIsOk = /^\W*ok\W*$/i.test(turn.agentText.trim());
      item3.itemTypes = turn.itemTypes;
    } catch (e) {
      item3.error = errName(e);
    }
    item3.guardAlerts = h.alerts.length;
    item3.serverRequests = h.decisions.map((d) => `${d.method}:${d.outcome}`);
    h.a.kill();
    await sleep(1500);
    if (threadId) {
      const h2 = await startHost(profile, install, paths);
      try {
        const rs: any = await h2.a.rpc.request("thread/resume", { threadId, ...threadParams });
        item4.resumedSameId = rs?.thread?.id === threadId;
        item4.threadResumeCheck = checkThreadResponse(rs, paths.emptyCwd);
        const turn = await runTurn(h2, threadId, "Reply with the single word OK.");
        item4.turnAfterResume = turn.status;
        item4.replyIsOkAfterResume = /^\W*ok\W*$/i.test(turn.agentText.trim());
      } catch (e) {
        item4.error = errName(e);
      }
      item4.guardAlerts = h2.alerts.length;
      h2.a.kill();
      await sleep(1000);
    }
    out.item3 = item3;
    out.item4 = item4;
  }

  // ---- Items 5 + 6: repo tool through the relay, then an interrupt mid-call ---------------------------------------
  const bind = (tok: string) => ({
    [`mcp_servers.${SERVER_NAME}.command`]: relay,
    [`mcp_servers.${SERVER_NAME}.args`]: [],
    [`mcp_servers.${SERVER_NAME}.env`]: { CGC_RELAY_TOKEN: tok },
    [`mcp_servers.${SERVER_NAME}.cwd`]: paths.emptyCwd,
  });
  const toolPrompt = process.env.STEP1_PROMPT ?? `Call the ${SERVER_NAME} list_dir tool once with no arguments (the repository root). Then reply with only the file and folder names it returned, one per line.`;
  // Item 5 with the production config; if no tool call reaches the relay, once more as a LABELLED DIAGNOSTIC with
  // Codex's code-mode host on (config.toml without code_mode_host = false; a per-thread feature override did not take
  // effect) and exec of that host allowed (it is in the approved strict profile, not in the relay profile).
  // The diagnostic variant is never a proposal by itself; it needs an owner ruling. The production config is restored.
  const codeModeHostRule = install.codeModeHost ? `(allow process-exec (literal ${sbplString(install.codeModeHost)}))\n` : "";
  const productionToml = buildCodexConfigToml();
  const hostOnToml = buildCodexConfigToml(OFF_FEATURES.filter((f) => f !== "code_mode_host"));
  const toolVariants: { name: string; profile: string; toml: string; token: string }[] = [
    { name: "production", profile, toml: productionToml, token: T.tool },
    { name: "diagnosticCodeModeHost", profile: profile + codeModeHostRule, toml: hostOnToml, token: T.toolHost },
  ];
  // STEP1_DIRECT_CATALOG=<catalog json>: LABELLED PROBE. Copies that catalog into CODEX_HOME (Codex can read its own
  // home) and points model_catalog_json at it, with the production config and profile otherwise (code mode stays off).
  // Only this variant runs; the copy and the config are removed/restored at the end.
  const probeCatalog = path.join(paths.codexHome, "probe-catalog.json");
  if (process.env.STEP1_DIRECT_CATALOG) {
    fs.copyFileSync(process.env.STEP1_DIRECT_CATALOG, probeCatalog);
    toolVariants.splice(0, toolVariants.length, {
      name: "probeDirectCatalog", profile, token: T.tool,
      toml: `model_catalog_json = ${JSON.stringify(probeCatalog)}\n${productionToml}`,
    });
  }
  let toolVariant: (typeof toolVariants)[number] | null = null;
  out.item5 = {};
  for (const v of toolVariants) {
    if (v.name !== "production" && !install.codeModeHost) { out.item5[v.name] = "skipped: no code-mode host in this install"; continue; }
    await stopReader(reader);
    try { fs.unlinkSync(sock); } catch {}
    reader = await startReader(sock, [{ token: v.token, kind: "jail", root: repo }], 0);
    writeCodexConfig(paths.codexHome, v.toml);
    const h = await startHost(v.profile, install, paths);
    const item5: Record<string, any> = {};
    try {
      if (!out.accountModels) {
        try {
          const ml: any = await h.a.rpc.request("model/list", {});
          out.accountModels = (ml?.data ?? []).map((m: any) => String(m?.model ?? m?.id));
        } catch (e) { out.accountModels = `model/list failed: ${errName(e)}`; }
      }
      const ts: any = await h.a.rpc.request("thread/start", { ...threadParams, ephemeral: true, config: bind(v.token) });
      const tid = String(ts?.thread?.id ?? "");
      item5.threadStartCheck = checkThreadResponse(ts, paths.emptyCwd);
      item5.threadModel = String(ts?.model ?? ts?.thread?.model ?? "?");
      const st: any = await h.a.rpc.request("mcpServerStatus/list", { threadId: tid, serverName: SERVER_NAME });
      item5.mcpStatusCheck = checkMcpStatus((st?.data ?? []).filter((e: any) => e?.name === SERVER_NAME), COMPANION_ALLOWLIST, "thread");
      const turn = await runTurn(h, tid, toolPrompt);
      item5.turnStatus = turn.status;
      if ((turn as any).error) item5.turnError = (turn as any).error;
      item5.mcpCalls = turn.mcpCalls;
      item5.itemTypes = turn.itemTypes;
      item5.replyHasFixtureFile = turn.agentText.includes(FIXTURE_FILE);
      // Local debugging only (stderr, never in the JSON): the model's reply about the synthetic fixture.
      if (process.env.STEP1_DEBUG === "1") process.stderr.write(`item5 reply: ${clean(turn.agentText).slice(0, 1500)}\n`);
    } catch (e) {
      item5.error = errName(e);
    }
    item5.elicitations = h.decisions.filter((d) => d.method === "mcpServer/elicitation/request").map((d) => d.outcome);
    item5.otherServerRequests = h.decisions.filter((d) => d.method !== "mcpServer/elicitation/request").map((d) => `${d.method}:${d.outcome}`);
    item5.guardAlerts = h.alerts.map((a) => `${a.itemType}: ${clean(a.detail)}`);
    h.a.kill();
    await sleep(1000);
    item5.reader = readerSummary(reader);
    out.item5[v.name] = item5;
    if (item5.mcpCalls?.some((c: any) => c.server === SERVER_NAME)) { toolVariant = v; break; }
  }
  out.item5.passedWith = toolVariant?.name ?? null;
  if (!toolVariant) {
    out.item6 = "not measurable: no model tool call reached the relay";
  } else {
    // Item 6: the reader holds every tools/call for HOLD_MS; interrupt as soon as the call reaches the reader.
    await stopReader(reader);
    try { fs.unlinkSync(sock); } catch {}
    reader = await startReader(sock, [{ token: T.interrupt, kind: "jail", root: repo }], HOLD_MS);
    writeCodexConfig(paths.codexHome, toolVariant.toml);
    const h = await startHost(toolVariant.profile, install, paths);
    const item6: Record<string, any> = { variant: toolVariant.name, holdMs: HOLD_MS };
    try {
      const ts: any = await h.a.rpc.request("thread/start", { ...threadParams, ephemeral: true, config: bind(T.interrupt) });
      const tid = String(ts?.thread?.id ?? "");
      let turnId: string | null = null;
      const watcher = (async () => {
        const hit = await reader.waitFor((e) => e.ev === "method" && e.method === "tools/call", 180_000);
        if (!hit || !turnId) return "tools/call never reached the reader";
        const t0 = Date.now();
        await h.a.rpc.request("turn/interrupt", { threadId: tid, turnId });
        return `sent ${Date.now() - hit.t} ms after tools/call reached the reader (ack ${Date.now() - t0} ms)`;
      })();
      const turn = await runTurn(h, tid, toolPrompt, { onStarted: (id) => { turnId = id; } });
      item6.interrupt = await watcher;
      item6.turnStatus = turn.status;
      item6.mcpCalls = turn.mcpCalls;
      await sleep(HOLD_MS + 2000); // let the held call be released (or not) and anything Codex sends after arrive
      const iAt = reader.events.find((e) => e.ev === "method" && e.method === "tools/call")?.t ?? 0;
      item6.readerEventsAfterToolsCall = reader.events.filter((e) => e.t >= iAt && e.ev !== "listening").map((e) => (e.ev === "method" || e.ev === "refused" ? `${e.ev}:${e.method}` : e.ev === "close" ? `close:${e.reason}` : e.ev));
      // Cost check: is the thread's repo tool still usable after the interrupt?
      const n = reader.events.length;
      const again = await runTurn(h, tid, toolPrompt);
      item6.nextTurn = { status: again.status, mcpCalls: again.mcpCalls, replyHasFixtureFile: again.agentText.includes(FIXTURE_FILE) };
      item6.readerEventsDuringNextTurn = reader.events.slice(n).map((e) => (e.ev === "method" || e.ev === "refused" ? `${e.ev}:${e.method}` : e.ev === "close" ? `close:${e.reason}` : e.ev));
    } catch (e) {
      item6.error = errName(e);
    }
    item6.serverRequests = h.decisions.map((d) => `${d.method}:${d.outcome}`);
    item6.guardAlerts = h.alerts.map((a) => `${a.itemType}: ${clean(a.detail)}`);
    h.a.kill();
    await sleep(1000);
    item6.reader = readerSummary(reader);
    out.item6 = item6;
  }

  writeCodexConfig(paths.codexHome, buildCodexConfigToml()); // always leave the production config behind

  // ---- Item 7: Codex's own command sandbox ---------------------------------------------------------------------
  out.item7 = { commandExecutionItemsStarted: commandExecutionTotal, allItemTypesSeen: [...allItemTypes].sort() };
  out.allServerRequests = [...new Set(allDecisions.map((d) => `${d.method}:${d.outcome}`))];
  out.allGuardAlerts = allAlerts;
  await stopReader(reader);
  process.stdout.write(`${JSON.stringify(out, (_k, v) => (typeof v === "string" ? clean(v) : v), 2)}\n`);
}

try {
  await main();
} finally {
  for (const k of kids) if (k.exitCode === null) k.kill("SIGKILL");
  writeCodexConfig(appPaths(os.homedir()).codexHome, buildCodexConfigToml()); // never leave a diagnostic config behind
  try { fs.unlinkSync(path.join(appPaths(os.homedir()).codexHome, "probe-catalog.json")); } catch {}
  removeTempDirs();
}
