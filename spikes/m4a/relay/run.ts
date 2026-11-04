// SPIKE (M4a option b) — measurement script. macOS only, real Codex 0.166.0 from companiond/node_modules,
// a FRESH temp CODEX_HOME that is never signed in (no login, no Keychain, no network to OpenAI).
// Builds the relay and the probe with clang, starts the reader, and measures checks 1–5.
// Touches only decoy sockets and ports it creates itself. Prints one JSON object (home as ~, no temp paths).
// Usage: node spikes/m4a/relay/run.ts            (from the repo root)
//        node spikes/m4a/relay/run.ts --profiles (also print both Seatbelt profiles, paths replaced)
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAppDirs, type AppPaths } from "../../../companiond/src/app/appPaths.ts";
import { findCodex } from "../../../companiond/src/codex/codexInstall.ts";
import { codexEnv } from "../../../companiond/src/codex/codexSeatbelt.ts";
import { buildCodexConfigToml, writeCodexConfig } from "../../../companiond/src/codex/config.ts";
import { SAFE_GIT_ENV, SAFE_GIT_FLAGS } from "../../../companiond/src/git/safeGit.ts";
import { TOOL_NAMES } from "../../../companiond/src/jail/mcpServer.ts";
import { SANDBOX_EXEC, buildReadonlyLaunch } from "../../../companiond/src/launch/seatbelt.ts";
import { discoverToolchain } from "../../../companiond/src/launch/toolchain.ts";
import { startAppServer, threadTools, type AppServer } from "../../../companiond/itest/helpers/appServer.ts";
import { makeRepo, removeTempDirs, tempDir } from "../../../companiond/test/helpers/fixtures.ts";
import { buildRelayCodexProfile } from "./profiles.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const companiond = path.resolve(here, "../../../companiond");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = () => crypto.randomBytes(32).toString("hex");
const kids: ChildProcess[] = [];
let tmpRoot = "";
const sysTmp = fs.realpathSync.native(os.tmpdir());
const clean = (s: string) => s.replaceAll(tmpRoot || "\u0000", "<tmp>").replaceAll(sysTmp, "$TMPDIR").replaceAll(os.homedir(), "~");

// --- line-oriented JSON-RPC client over any duplex pair ---------------------------------------------------
interface Client { send(o: unknown): void; sendRaw(s: string): void; reply(id: number, ms?: number): Promise<any>; end(): void; closed: Promise<void>; isClosed(): boolean }
function client(write: (s: string) => void, onData: (f: (c: Buffer) => void) => void, onClose: (f: () => void) => void, end: () => void): Client {
  let buf = "";
  const got = new Map<number, any>();
  let closed = false;
  const closedP = new Promise<void>((r) => onClose(() => { closed = true; r(); }));
  onData((c) => {
    buf += c.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const m = JSON.parse(line);
        if (typeof m.id === "number") got.set(m.id, m);
      } catch {}
    }
  });
  return {
    send: (o) => write(`${JSON.stringify(o)}\n`),
    sendRaw: (s) => write(s),
    reply: async (id, ms = 15_000) => {
      for (let t = 0; t < ms; t += 50) {
        if (got.has(id)) return got.get(id);
        if (closed) return null;
        await sleep(50);
      }
      return null;
    },
    end,
    closed: closedP,
    isClosed: () => closed,
  };
}
const init = (c: Client, id = 1) => c.send({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spike", version: "0" } } });

function sockClient(sockPath: string, first: string): Promise<Client> {
  return new Promise((res) => {
    const s = net.connect(sockPath);
    s.on("error", () => {});
    s.on("connect", () => {
      s.write(first);
      res(client((x) => { if (!s.destroyed) s.write(x); }, (f) => s.on("data", f), (f) => s.on("close", f), () => s.end()));
    });
  });
}

function relayProc(profile: string, relay: string, tok: string, cwd: string): { c: Client; p: ChildProcess; exit: Promise<number | null> } {
  const p = spawn(SANDBOX_EXEC, ["-p", profile, relay], { env: { CGC_RELAY_TOKEN: tok }, cwd, stdio: ["pipe", "pipe", "ignore"] });
  kids.push(p);
  p.stdin?.on("error", () => {});
  const exit = new Promise<number | null>((r) => p.on("exit", (code) => r(code)));
  const c = client((x) => { if (p.stdin?.writable) p.stdin.write(x); }, (f) => p.stdout?.on("data", f), (f) => p.on("exit", f), () => p.stdin?.end());
  return { c, p, exit };
}

// --- reader process ---------------------------------------------------------------------------------------
interface Reader { p: ChildProcess; events: any[]; waitFor(pred: (e: any) => boolean, ms?: number): Promise<any> }
async function startReader(sock: string, grants: { token: string; kind: "jail" | "probe"; root: string }[], fake: string): Promise<Reader> {
  const p = spawn(process.execPath, [path.join(here, "reader.ts"), sock], { stdio: ["pipe", "pipe", "ignore"] });
  kids.push(p);
  const events: any[] = [];
  let buf = "";
  p.stdout?.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      try { events.push(JSON.parse(buf.slice(0, nl))); } catch {}
      buf = buf.slice(nl + 1);
    }
  });
  p.stdin?.write(`${JSON.stringify({ grants, fake })}\n`);
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

const alive = (pid: number | null | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The jail-side probe: runs under the EXACT profile buildReadonlyLaunch gives the jail, via `node -e`
// (so it needs no file outside what the jail may read).
const JAIL_PROBE = `
import fs from "node:fs"; import net from "node:net"; import { spawnSync, execFileSync } from "node:child_process";
const e = process.env; const out = {};
try { fs.readdirSync(e.COMPANION_ROOT); out.readRoot = true } catch (x) { out.readRoot = x.code }
try { execFileSync(e.COMPANION_GIT, ["-C", e.COMPANION_ROOT, ...JSON.parse(e.P_GITFLAGS), "rev-parse", "--is-inside-work-tree"], { env: JSON.parse(e.P_GITENV), stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }); out.git = true } catch (x) { out.git = x.code ?? "failed" }
try { fs.readdirSync(e.P_OUTSIDE); out.readOutsideRoot = true } catch (x) { out.readOutsideRoot = x.code }
const conn = (o) => new Promise((r) => { const s = net.connect(o); s.on("connect", () => { s.destroy(); r("OK") }); s.on("error", (x) => r(x.code)); });
out.unixDecoy = await conn({ path: e.P_DECOY_SOCK });
out.unixRelaySocket = await conn({ path: e.P_RELAY_SOCK });
out.tcpDecoy = await conn({ host: "127.0.0.1", port: Number(e.P_DECOY_PORT) });
const ex = (p) => { const r = spawnSync(p, [], { stdio: "ignore", timeout: 5000 }); return r.error ? r.error.code : "ran:" + r.status };
out.execSh = ex("/bin/sh"); out.execNc = ex("/usr/bin/nc"); out.execRelay = ex(e.P_RELAY);
process.stdout.write(JSON.stringify(out));
`;

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("macOS only");
  const install = findCodex();
  const tc = discoverToolchain();
  tmpRoot = tempDir("cgc-relay-");
  const d = path.join(tmpRoot, "s");
  const paths: AppPaths = ensureAppDirs({ supportDir: d, codexHome: path.join(d, "codex-home"), emptyCwd: path.join(d, "empty-cwd"), dbPath: path.join(d, "companion.db") });
  const relayDir = path.join(paths.supportDir, "r");
  fs.mkdirSync(relayDir, { mode: 0o700 });
  fs.chmodSync(relayDir, 0o700);
  const sock = path.join(relayDir, "s.sock");
  const decoyDir = path.join(tmpRoot, "decoy");
  fs.mkdirSync(decoyDir, { mode: 0o700 });
  const decoySock = path.join(decoyDir, "d.sock");
  const binDir = path.join(tmpRoot, "bin");
  fs.mkdirSync(binDir, { mode: 0o700 });

  // Build: the relay (fixed socket), a relay built for the decoy (to show the profile, not the binary, stops it), the probe.
  // xcrun (not the bare clang path) so the macOS SDK headers are found.
  const cc = (src: string, out: string, defs: string[] = []) => execFileSync("/usr/bin/xcrun", ["clang", "-O2", "-Wall", "-Werror", ...defs, "-o", out, path.join(here, src)], { stdio: ["ignore", "ignore", "pipe"] });
  const relay = path.join(binDir, "relay");
  const relayDecoy = path.join(binDir, "relay-decoy");
  const probe = path.join(binDir, "probe");
  cc("relay.c", relay, [`-DRELAY_SOCKET="${sock}"`]);
  cc("relay.c", relayDecoy, [`-DRELAY_SOCKET="${decoySock}"`]);
  cc("probe.c", probe);

  // Decoys: a unix socket and a TCP port on 127.0.0.1, both ours. They count connections.
  let decoyUnixHits = 0;
  let decoyTcpHits = 0;
  const du = net.createServer((s) => { decoyUnixHits++; s.destroy(); });
  await new Promise<void>((r) => du.listen(decoySock, r));
  const dt = net.createServer((s) => { decoyTcpHits++; s.destroy(); });
  await new Promise<void>((r) => dt.listen(0, "127.0.0.1", r));
  const decoyPort = (dt.address() as net.AddressInfo).port;

  const repo = fs.realpathSync.native(makeRepo());
  const fake = fs.realpathSync.native(path.join(companiond, "itest", "fixtures", "fakeMcp.ts"));
  const T = { relayJail: token(), codexJail: token(), codexProbe: token(), stolen: token(), badMethod: token(), badTool: token(), malformed: token(), oversized: token(), clientResponse: token(), listingAnswered: token(), relayCrash: token(), jailCrash: token(), readerCrash: token() };
  const grants = Object.entries(T).map(([k, t]) => ({ token: t, kind: (k === "codexProbe" ? "probe" : "jail") as "jail" | "probe", root: repo }));
  let reader = await startReader(sock, grants, fake);
  const socketMode = reader.events.find((e) => e.ev === "listening")?.mode;
  const dirMode = (fs.statSync(relayDir).mode & 0o777).toString(8);

  const profileInput = { codexBinary: install.binary, vendorDir: install.vendorDir, codexHome: paths.codexHome, emptyCwd: paths.emptyCwd, supportDir: paths.supportDir, relaySocket: sock };
  const codexProfile = buildRelayCodexProfile({ ...profileInput, launcher: relay });
  const probeProfile = buildRelayCodexProfile({ ...profileInput, launcher: probe });
  const decoyRelayProfile = buildRelayCodexProfile({ ...profileInput, launcher: relayDecoy });
  const jailLaunch = await buildReadonlyLaunch({ root: repo, toolchain: tc });
  const jailProfile = jailLaunch.args[1] as string;

  const out: Record<string, unknown> = { codex: install.version, signedIn: false, relay: "C binary (clang), fixed socket path", socketMode, socketDirMode: dirMode };

  // ---- Check 1: connects ---------------------------------------------------------------------------------
  const parseProbe = (stdout: string, labels: string[]) => Object.fromEntries(stdout.trim().split("\n").filter(Boolean).map((l) => { const j = JSON.parse(l); return [labels[j.action - 1], j.errno]; }));
  const ctlLabels = ["unixDecoy", "tcpDecoy"];
  const control = spawnSync(probe, [`unix:${decoySock}`, `tcp:${decoyPort}`], { env: {}, encoding: "utf8" });
  await sleep(300); // let the decoys' accept events run before counting
  const controlHits = { unix: decoyUnixHits, tcp: decoyTcpHits };
  decoyUnixHits = 0;
  decoyTcpHits = 0;
  const labels = ["unixRelaySocket", "unixDecoy", "tcpDecoy", "bindUnixDecoy", "execSh", "execNc", "execNode", "execRelay", "execSandboxExec", "execGit", "execSelfLauncher", "bindInRelayDir", "unlinkRelaySocket", "writeRelayBinary"];
  const pr = spawnSync(SANDBOX_EXEC, ["-p", probeProfile, probe, `unix:${sock}`, `unix:${decoySock}`, `tcp:${decoyPort}`, `bind:${path.join(decoyDir, "b.sock")}`, "exec:/bin/sh", "exec:/usr/bin/nc", `exec:${tc.nodePath}`, `exec:${relay}`, `exec:${SANDBOX_EXEC}`, `exec:${tc.gitPath}`, `exec:${probe}`, `bind:${path.join(relayDir, "x.sock")}`, `unlink:${sock}`, `write:${relay}`], { env: {}, cwd: paths.emptyCwd, encoding: "utf8", timeout: 20_000 });
  const underCodexProfile = parseProbe(pr.stdout, labels);
  await sleep(300);
  const hitsUnderProfile = { unix: decoyUnixHits, tcp: decoyTcpHits };

  // The real relay under the real (relay-launcher) profile, end to end to the jail: initialize, tools/list, tools/call.
  const rr = relayProc(codexProfile, relay, T.relayJail, paths.emptyCwd);
  init(rr.c, 1);
  const i1 = await rr.c.reply(1);
  rr.c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  rr.c.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tl = await rr.c.reply(2);
  rr.c.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_dir", arguments: {} } });
  const tcall = await rr.c.reply(3);
  rr.c.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "git_status", arguments: {} } });
  const gcall = await rr.c.reply(4);
  rr.c.end();
  const rrExit = await Promise.race([rr.exit, sleep(10_000).then(() => "timeout")]);
  const listText = String(tcall?.result?.content?.[0]?.text ?? "");
  const relayDirect = {
    initialize: i1?.result?.serverInfo?.name ?? null,
    tools: (tl?.result?.tools ?? []).map((t: any) => t.name),
    listDirOk: tcall?.result?.isError === false && listText.includes("README"),
    gitStatusOk: gcall?.result?.isError === false,
    relayExit: rrExit,
  };
  decoyUnixHits = 0;
  const dr = relayProc(decoyRelayProfile, relayDecoy, T.stolen.replace(/./g, "a"), paths.emptyCwd);
  dr.c.end();
  const decoyRelayExit = await Promise.race([dr.exit, sleep(10_000).then(() => "timeout")]);
  out.check1 = {
    controlUnsandboxed: { ...parseProbe(control.stdout, ctlLabels), hits: controlHits },
    underCodexProfile: { unixRelaySocket: underCodexProfile.unixRelaySocket, unixDecoy: underCodexProfile.unixDecoy, tcpDecoy: underCodexProfile.tcpDecoy, bindUnixDecoy: underCodexProfile.bindUnixDecoy, bindInRelayDir: underCodexProfile.bindInRelayDir, unlinkRelaySocket: underCodexProfile.unlinkRelaySocket, writeRelayBinary: underCodexProfile.writeRelayBinary, decoyHits: hitsUnderProfile },
    realRelayUnderCodexProfile: relayDirect,
    relayBuiltForDecoyUnderProfile: { exit: decoyRelayExit, decoyHits: decoyUnixHits, note: "69 = connect refused by the profile" },
  };

  // ---- Check 2: exec ---------------------------------------------------------------------------------------
  const firstExec = (cmd: string) => {
    const r = spawnSync(SANDBOX_EXEC, ["-p", codexProfile, cmd], { env: {}, cwd: paths.emptyCwd, encoding: "utf8", timeout: 10_000 });
    return { exit: r.status, message: (r.stderr.split("\n")[0] ?? "").replace(/(\/[^\s:"']+)+/g, "<path>").slice(0, 120) };
  };
  out.check2 = {
    fromInsideProfile: Object.fromEntries(["execSh", "execNc", "execNode", "execRelay", "execSandboxExec", "execGit", "execSelfLauncher"].map((k) => [k, underCodexProfile[k]])),
    note: "execRelay is the real relay binary while the probe holds the launcher slot: only the one launcher literal may run",
    sandboxExecFirstExec: { sh: firstExec("/bin/sh"), nc: firstExec("/usr/bin/nc"), node: firstExec(tc.nodePath) },
  };

  // ---- Check 3: the jail (reader side) ---------------------------------------------------------------------
  decoyUnixHits = 0;
  decoyTcpHits = 0;
  const jr = spawnSync(SANDBOX_EXEC, ["-p", jailProfile, tc.nodePath, "--input-type=module", "-e", JAIL_PROBE], {
    env: { ...jailLaunch.env, P_GITFLAGS: JSON.stringify(SAFE_GIT_FLAGS), P_GITENV: JSON.stringify(SAFE_GIT_ENV), P_OUTSIDE: decoyDir, P_DECOY_SOCK: decoySock, P_DECOY_PORT: String(decoyPort), P_RELAY_SOCK: sock, P_RELAY: relay },
    cwd: jailLaunch.cwd, encoding: "utf8", timeout: 30_000,
  });
  let jailRes: unknown;
  try { jailRes = JSON.parse(jr.stdout); } catch { jailRes = { error: `exit ${jr.status}` }; }
  await sleep(300);
  out.check3 = { underJailProfile: jailRes, decoyHits: { unix: decoyUnixHits, tcp: decoyTcpHits } };

  // ---- Check 4: authorization and validation ---------------------------------------------------------------
  const closeReason = async (from: number) => (await reader.waitFor((e, ) => e.ev === "close" && reader.events.indexOf(e) >= from, 6000))?.reason ?? "no close";
  const attempt = async (first: string, then?: (c: Client) => void) => {
    const from = reader.events.length;
    const c = await sockClient(sock, first);
    then?.(c);
    const r = await c.reply(1, 5000);
    await Promise.race([c.closed, sleep(5000)]);
    return { replied: !!r, closed: c.isClosed(), reason: await closeReason(from) };
  };
  const mcpInit = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
  const check4: Record<string, unknown> = {};
  check4.noToken = await attempt(mcpInit);
  check4.wrongToken = await attempt(`${token()}\n${mcpInit}`);
  check4.silent = await attempt("");
  // Token theft by a second process: the first connection uses it; the second one with the same token is refused.
  const firstUse = await sockClient(sock, `${T.stolen}\n`);
  init(firstUse, 1);
  const firstOk = !!(await firstUse.reply(1));
  check4.secondProcessSameToken = { firstConnectionServed: firstOk, second: await attempt(`${T.stolen}\n${mcpInit}`) };
  firstUse.end();
  const authed = (tok: string, payload: string) => attempt(`${tok}\n${payload}`);
  check4.methodNotAllowed = await authed(T.badMethod, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "file:///etc/hosts" } }) + "\n");
  {
    // resources/list is answered by the reader itself (Method not found) and the connection stays usable.
    const from = reader.events.length;
    const c = await sockClient(sock, `${T.listingAnswered}\n`);
    c.send({ jsonrpc: "2.0", id: 1, method: "resources/list" });
    const r1 = await c.reply(1, 5000);
    c.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const r2 = await c.reply(2, 10_000);
    c.end();
    await Promise.race([c.closed, sleep(5000)]);
    check4.resourcesListAnsweredLocally = {
      reply: r1?.error?.code ?? null,
      thenToolsList: (r2?.result?.tools ?? []).length,
      forwardedToJail: reader.events.some((e) => reader.events.indexOf(e) >= from && e.ev === "method" && e.method === "resources/list"),
    };
  }
  check4.toolNotAllowed = await authed(T.badTool, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "exec", arguments: {} } }) + "\n");
  check4.malformed = await authed(T.malformed, "{not json\n");
  check4.clientResponse = await authed(T.clientResponse, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n");
  check4.oversized = await authed(T.oversized, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024) } }) + "\n");
  // Relay crash: kill the relay mid-session; the reader must drop the connection and kill the jail.
  {
    const from = reader.events.length;
    const r = relayProc(codexProfile, relay, T.relayCrash, paths.emptyCwd);
    init(r.c, 1);
    const ok = !!(await r.c.reply(1));
    const acc = await reader.waitFor((e) => e.ev === "accept" && reader.events.indexOf(e) >= from);
    r.p.kill("SIGKILL");
    const reason = await closeReason(from);
    await sleep(500);
    check4.relayCrash = { servedBefore: ok, readerClose: reason, jailStillAlive: alive(acc?.jailPid) };
  }
  // Jail crash: kill the jail; the relay must see EOF and exit, the pending call gets no reply.
  {
    const from = reader.events.length;
    const r = relayProc(codexProfile, relay, T.jailCrash, paths.emptyCwd);
    init(r.c, 1);
    const ok = !!(await r.c.reply(1));
    const acc = await reader.waitFor((e) => e.ev === "accept" && reader.events.indexOf(e) >= from);
    if (acc?.jailPid) process.kill(acc.jailPid, "SIGKILL");
    r.c.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_dir", arguments: {} } });
    const after = await r.c.reply(2, 3000);
    const ex = await Promise.race([r.exit, sleep(5000).then(() => "timeout")]);
    check4.jailCrash = { servedBefore: ok, replyAfterCrash: !!after, relayExit: ex, readerClose: await closeReason(from) };
  }
  // Reader crash: SIGKILL the reader mid-session. The relay must exit; the jail it spawned must go too;
  // a new relay launch must fail (nothing listens), never reach anything else.
  {
    const from = reader.events.length;
    const r = relayProc(codexProfile, relay, T.readerCrash, paths.emptyCwd);
    init(r.c, 1);
    const ok = !!(await r.c.reply(1));
    const acc = await reader.waitFor((e) => e.ev === "accept" && reader.events.indexOf(e) >= from);
    reader.p.kill("SIGKILL");
    r.c.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_dir", arguments: {} } });
    const after = await r.c.reply(2, 3000);
    const ex = await Promise.race([r.exit, sleep(5000).then(() => "timeout")]);
    await sleep(1000);
    const again = relayProc(codexProfile, relay, token(), paths.emptyCwd);
    again.c.end();
    const exAgain = await Promise.race([again.exit, sleep(5000).then(() => "timeout")]);
    check4.readerCrash = { servedBefore: ok, replyAfterCrash: !!after, relayExit: ex, jailStillAlive: alive(acc?.jailPid), newRelayWithNoReaderExit: exAgain };
  }
  out.check4 = check4;

  // ---- Check 5: real Codex under the relay profile ---------------------------------------------------------
  try { fs.unlinkSync(sock); } catch {}
  reader = await startReader(sock, grants.filter((g) => g.token === T.codexJail || g.token === T.codexProbe), fake);
  writeCodexConfig(paths.codexHome, buildCodexConfigToml() + ["[mcp_servers.fake]", 'command = "/usr/bin/false"', "args = []", 'enabled_tools = ["whereami"]', ""].join("\n"));
  const check5: Record<string, unknown> = {};
  let a: AppServer | null = null;
  try {
    a = await startAppServer({ command: SANDBOX_EXEC, args: ["-p", codexProfile, install.binary, "app-server"], env: codexEnv(install, paths, os.homedir()), cwd: paths.emptyCwd });
    check5.initialize = "ok";
  } catch (e) {
    check5.initialize = `blocked: ${(e as Error).name}`;
  }
  if (a) {
    const s = a;
    const thread = async (config: Record<string, unknown>) => ((await s.rpc.request<any>("thread/start", { cwd: paths.emptyCwd, sandbox: "read-only", approvalPolicy: "untrusted", ephemeral: true, config })).thread.id as string);
    const bind = (server: string, command: string, env: Record<string, string>) => ({ [`mcp_servers.${server}.command`]: command, [`mcp_servers.${server}.args`]: [], [`mcp_servers.${server}.env`]: env, [`mcp_servers.${server}.cwd`]: paths.emptyCwd });
    const err = (x: unknown) => clean(typeof x === "string" ? x : JSON.stringify(x)).slice(0, 200);
    const jail = await threadTools(s, await thread(bind("companion-readonly", relay, { CGC_RELAY_TOKEN: T.codexJail })), "companion-readonly");
    check5.jailTools = jail.error ? `blocked: ${err(jail.error)}` : [...jail.tools].sort();
    check5.exactlyFiveJailTools = !jail.error && [...jail.tools].sort().join() === [...TOOL_NAMES].sort().join();
    const pr5 = await threadTools(s, await thread(bind("fake", relay, { CGC_RELAY_TOKEN: T.codexProbe })), "fake");
    const probeInfo = pr5.error ? null : (JSON.parse(String(pr5.serverInfo?.version ?? "{}")) as { probe?: unknown }).probe;
    check5.rootProbeThroughRelay = pr5.error ? `blocked: ${err(pr5.error)}` : probeInfo;
    const reuse = await threadTools(s, await thread(bind("fake", relay, { CGC_RELAY_TOKEN: T.codexProbe })), "fake");
    check5.reusedTokenViaCodex = reuse.error ? `refused: ${err(reuse.error)}` : "SERVED (unexpected)";
    const sh = await threadTools(s, await thread(bind("fake", "/bin/sh", {})), "fake");
    check5.codexExecShell = sh.error ? `refused: ${err(sh.error)}` : "SERVED (unexpected)";
    const nd = await threadTools(s, await thread(bind("fake", tc.nodePath, {})), "fake");
    check5.codexExecNode = nd.error ? `refused: ${err(nd.error)}` : "SERVED (unexpected)";
    await sleep(1000);
    // Bound servers must still be connected after Codex's startup chatter (a closed one would fail every tool call).
    const accepted = reader.events.filter((e) => e.ev === "accept").map((e) => e.conn);
    const closedConns = new Set(reader.events.filter((e) => e.ev === "close").map((e) => e.conn));
    check5.acceptedConnectionsStillOpenBeforeCodexExit = `${accepted.filter((c) => !closedConns.has(c)).length}/${accepted.length}`;
    s.kill();
    await sleep(1000);
  }
  check5.methodsCodexSent = [...new Set(reader.events.filter((e) => e.ev === "method").map((e) => e.method))];
  check5.methodsRefused = reader.events.filter((e) => e.ev === "refused").map((e) => e.method);
  check5.requestsAnsweredLocally = reader.events.filter((e) => e.ev === "answered-locally").length;
  check5.readerCloses = reader.events.filter((e) => e.ev === "close").map((e) => e.reason);
  // Was any token written to disk by Codex (CODEX_HOME, the whole support folder)?
  const files: string[] = [];
  const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } };
  walk(paths.supportDir);
  const all = Object.values(T);
  check5.tokenFoundOnDisk = files.some((f) => { const b = fs.readFileSync(f, "latin1"); return all.some((t) => b.includes(t)); });
  check5.filesScanned = files.length;
  out.check5 = check5;
  out.pending = ["network to OpenAI under (remote tcp \"*:443\") — owner login (Step 1)", "Keychain token read under this profile — owner login (Step 1)", "DNS: whether the mach dnssd lookup suffices without a resolver socket literal — owner login (Step 1)"];

  if (process.argv.includes("--profiles")) {
    out.profiles = {
      codex: clean(codexProfile).replaceAll(path.dirname(install.vendorDir), "<codex-vendor-parent>"),
      jail: clean(jailProfile).replaceAll(path.dirname(companiond), "<repo>"),
    };
  }
  process.stdout.write(`${JSON.stringify(out, (_k, v) => (typeof v === "string" ? clean(v) : v), 2)}\n`);
  du.close();
  dt.close();
}

try {
  await main();
} finally {
  for (const k of kids) if (k.exitCode === null) k.kill("SIGKILL");
  removeTempDirs();
}
