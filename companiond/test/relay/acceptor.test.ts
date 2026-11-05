import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES } from "../../src/jail/mcpServer.ts";
import type { LaunchSpec } from "../../src/launch/seatbelt.ts";
import { RelayAcceptor, type AcceptorOptions } from "../../src/relay/acceptor.ts";
import type { BrokerEvent } from "../../src/relay/broker.ts";
import { HELLO_BYTES, newToken, proof } from "../../src/relay/handshake.ts";
import { ensureRelayDirs, relayPaths, RelaySetupError } from "../../src/relay/relayPaths.ts";
import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";
import { connectRelay } from "./relayClient.ts";

const started: RelayAcceptor[] = [];
after(async () => {
  for (const a of started) await a.stop();
  removeTempDirs();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => {
  for (let t = 0; t < ms && !f(); t += 20) await sleep(20);
  return f();
};
const VALIDATOR = fileURLToPath(new URL("../../src/relay/validator.ts", import.meta.url));
const JAIL = fileURLToPath(new URL("./fakeJail.ts", import.meta.url));
const validator = (env: Record<string, string> = {}): LaunchSpec => ({ command: process.execPath, args: [VALIDATOR, TOOL_NAMES.join(",")], env: { PATH: "/usr/bin:/bin", ...env }, cwd: "/" });
const jail = (mode = ""): LaunchSpec => ({ command: process.execPath, args: [JAIL], env: { FAKE_JAIL_MODE: mode, PATH: "/usr/bin:/bin" }, cwd: "/" });

async function start(o: Partial<AcceptorOptions> = {}) {
  const rp = ensureRelayDirs(relayPaths(tempDir("cgc-acc-")));
  const a = new RelayAcceptor({ socketPath: rp.socket, validator: validator(), ...o });
  const events: BrokerEvent[] = [];
  a.on((e) => events.push(e));
  await a.start();
  started.push(a);
  return { a, events, rp };
}
const has = (events: BrokerEvent[], type: BrokerEvent["type"], end?: string) =>
  events.some((e) => e.type === type && (end === undefined || (e.type === "closed" && e.end === end)));

test("listening: socket 0600 in a 0700 folder; a stale socket is replaced; anything else is refused (M7)", async () => {
  const { rp } = await start();
  assert.equal(fs.lstatSync(rp.socket).mode & 0o777, 0o600);
  // A crashed companiond leaves its socket file behind: a child binds it and is SIGKILLed before any cleanup.
  const stale = ensureRelayDirs(relayPaths(tempDir("cgc-acc-")));
  spawnSync(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(stale.socket)}, () => process.kill(process.pid, "SIGKILL"))`]);
  // Replaced = the stale file refused connections before, and a live 0600 socket accepts them after. (Not an inode
  // comparison: Linux reuses the freed inode number at once, measured in CI.)
  assert.equal(fs.lstatSync(stale.socket).isSocket(), true);
  const before = await new Promise<string>((r) => net.connect(stale.socket).once("connect", () => r("connected")).on("error", (e: NodeJS.ErrnoException) => r(e.code ?? "error")));
  assert.equal(before, "ECONNREFUSED", "the leftover socket is stale");
  const a2 = new RelayAcceptor({ socketPath: stale.socket, validator: validator() });
  await a2.start();
  started.push(a2);
  assert.equal(fs.lstatSync(stale.socket).mode & 0o777, 0o600, "the stale socket was replaced by ours");
  const hello = await new Promise<string>((r) => net.connect(stale.socket).once("data", (d) => r(d.toString("latin1"))).on("error", () => r("")));
  assert.match(hello, /^CGC1 [0-9a-f]{64}\n$/);
  // A LIVE socket at the path (another companiond, another itest run) is refused, never unlinked (M-9).
  const busy = ensureRelayDirs(relayPaths(tempDir("cgc-acc-")));
  const other = net.createServer((c) => c.destroy());
  await new Promise<void>((r) => other.listen(busy.socket, r));
  await assert.rejects(new RelayAcceptor({ socketPath: busy.socket, validator: validator() }).start(), RelaySetupError);
  assert.equal(fs.lstatSync(busy.socket).isSocket(), true);
  other.close();
  const notSock = ensureRelayDirs(relayPaths(tempDir("cgc-acc-")));
  fs.writeFileSync(notSock.socket, "SYNTHETIC FIXTURE\n");
  await assert.rejects(new RelayAcceptor({ socketPath: notSock.socket, validator: validator() }).start(), RelaySetupError);
  const loose = relayPaths(tempDir("cgc-acc-"));
  fs.mkdirSync(loose.runDir, { mode: 0o755 });
  fs.chmodSync(loose.runDir, 0o755);
  await assert.rejects(new RelayAcceptor({ socketPath: loose.socket, validator: validator() }).start(), RelaySetupError);
});

test("a granted relay reaches the jail: tools, a call, local resources, cancelled dropped", async () => {
  const { a, events, rp } = await start();
  const g = a.grant(jail());
  const c = await connectRelay(rp.socket, g.token);
  assert.equal(c.isClosed(), false);
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  assert.equal((await c.reply(1))?.result?.serverInfo?.name, "fake-jail");
  c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  c.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(((await c.reply(2))?.result?.tools ?? []).map((t: any) => t.name), [...TOOL_NAMES]);
  c.send({ jsonrpc: "2.0", id: 3, method: "resources/list" });
  assert.deepEqual((await c.reply(3))?.result, { resources: [] });
  c.send({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "file:///etc/hosts" } });
  assert.equal((await c.reply(4))?.error?.code, -32002);
  c.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
  c.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_dir", arguments: {} } });
  assert.match((await c.reply(5))?.result?.content?.[0]?.text ?? "", /called list_dir/);
  assert.ok(has(events, "bound"));
  assert.equal(has(events, "refused"), false);
  assert.equal(a.counts.bound, 1);
  c.end();
  assert.ok(await until(() => has(events, "closed", "normal")));
  assert.equal(a.counts.bound, 0);
});

test("a wrong proof is refused and reported; a token works once; tampered framing is refused", async () => {
  const { a, events, rp } = await start();
  const bad = await connectRelay(rp.socket, newToken());
  await bad.closed;
  assert.ok(await until(() => events.filter((e) => e.type === "refused").length === 1));
  const g = a.grant(jail());
  const ok = await connectRelay(rp.socket, g.token);
  assert.equal(ok.isClosed(), false);
  const again = await connectRelay(rp.socket, g.token);
  await again.closed;
  assert.ok(await until(() => events.filter((e) => e.type === "refused").length === 2));
  const g2 = a.grant(jail());
  const extra = await connectRelay(rp.socket, g2.token, { tamper: "extraBytes" });
  await extra.closed;
  assert.ok(await until(() => events.filter((e) => e.type === "refused").length === 3));
  ok.end();
});

test("every connection gets a fresh nonce, and a proof for one nonce does not work on another (I2)", async () => {
  const { a, events, rp } = await start();
  const g = a.grant(jail());
  const hello = () => new Promise<{ s: net.Socket; nonce: Buffer }>((resolve) => {
    const s = net.connect(rp.socket);
    s.on("error", () => {});
    let buf = Buffer.alloc(0);
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= HELLO_BYTES) resolve({ s, nonce: Buffer.from(buf.subarray(5, HELLO_BYTES - 1).toString("latin1"), "hex") });
    });
  });
  const one = await hello();
  const two = await hello();
  assert.notEqual(one.nonce.toString("hex"), two.nonce.toString("hex"));
  // A valid proof for connection one's nonce, replayed on connection two, is refused: the token is not spent.
  two.s.write(`${proof(g.token, one.nonce, "relay")}\n`);
  assert.ok(await until(() => events.filter((e) => e.type === "refused").length === 1));
  assert.equal(a.counts.grants, 1, "the grant is still unspent");
  one.s.destroy();
  two.s.destroy();
});

test("the socket is rechecked before binding: a swap after the proof is reported and nothing is bound (I2, I-8)", async () => {
  const { a, events, rp } = await start({ inodeCheckMs: 60_000 });
  const g = a.grant(jail());
  const s = net.connect(rp.socket);
  s.on("error", () => {});
  let buf = Buffer.alloc(0);
  await new Promise<void>((resolve) => s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length >= HELLO_BYTES) resolve();
  }));
  // The sweep is far away: only the check at bind time can catch this swap.
  fs.renameSync(rp.socket, `${rp.socket}.moved`);
  const decoy = net.createServer();
  await new Promise<void>((r) => decoy.listen(rp.socket, r));
  try {
    const nonce = Buffer.from(buf.subarray(5, HELLO_BYTES - 1).toString("latin1"), "hex");
    s.write(`${proof(g.token, nonce, "relay")}\n`);
    assert.ok(await until(() => has(events, "closed", "violation")));
    assert.ok(await until(() => has(events, "socketReplaced")), "a failed recheck reports the replaced socket (review 2)");
    assert.equal(a.healthy(), false);
    assert.equal(has(events, "bound"), false);
    assert.equal(a.counts.bound, 0);
  } finally {
    s.destroy();
    decoy.close();
    fs.rmSync(rp.socket, { force: true });
    fs.renameSync(`${rp.socket}.moved`, rp.socket);
  }
});

test("an armed token expires; a silent connection is refused after the handshake timeout", async () => {
  const { a, events, rp } = await start({ handshakeMs: 300 });
  const g = a.grant(jail());
  g.arm(50);
  await sleep(150);
  const late = await connectRelay(rp.socket, g.token);
  await late.closed;
  const silent = await connectRelay(rp.socket, newToken(), { tamper: "silent" });
  await silent.closed;
  assert.ok(await until(() => events.filter((e) => e.type === "refused").length === 2));
});

test("revoke ends a live binding; the jail and validator are gone", async () => {
  const { a, events, rp } = await start();
  const g = a.grant(jail());
  const c = await connectRelay(rp.socket, g.token);
  c.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(await c.reply(1));
  g.revoke();
  await c.closed;
  assert.ok(await until(() => has(events, "closed", "revoked")));
  assert.equal(a.counts.bound, 0);
});

test("violations close the binding: a method outside the allowlist, a server request, an unknown response id", async () => {
  const { a, events, rp } = await start();
  const c1 = await connectRelay(rp.socket, a.grant(jail()).token);
  c1.send({ jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: {} });
  await c1.closed;
  const c2 = await connectRelay(rp.socket, a.grant(jail("server-request")).token);
  c2.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await c2.closed;
  const c3 = await connectRelay(rp.socket, a.grant(jail("bad-id")).token);
  c3.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  await c3.closed;
  assert.ok(await until(() => events.filter((e) => e.type === "closed" && e.end === "violation").length === 3));
});

test("more than 16 requests in flight closes with the limit end (I3)", async () => {
  const { a, events, rp } = await start();
  const c = await connectRelay(rp.socket, a.grant(jail("slow")).token);
  for (let i = 0; i < 17; i++) c.send({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "list_dir", arguments: {} } });
  await c.closed;
  assert.ok(await until(() => has(events, "closed", "limit")));
});

test("an idle binding closes with the idle end (I3)", async () => {
  const { a, events, rp } = await start({ validator: validator({ CGC_VALIDATOR_IDLE_MS: "600" }) });
  const c = await connectRelay(rp.socket, a.grant(jail()).token);
  await c.closed;
  assert.ok(await until(() => has(events, "closed", "idle")));
});

test("too many pending handshakes are refused (M4)", async () => {
  const { events, rp } = await start({ maxPending: 1, handshakeMs: 2000 });
  const first = connectRelay(rp.socket, newToken(), { tamper: "silent" });
  await sleep(100);
  const second = await connectRelay(rp.socket, newToken(), { tamper: "silent" });
  await second.closed;
  assert.ok(await until(() => events.some((e) => e.type === "refused" && e.reason === "too many connections")));
  await (await first).closed;
});

test("a replaced socket file revokes everything, is reported, and leaves the broker unhealthy until restart (I2, I-1)", async () => {
  const { a, events, rp } = await start({ inodeCheckMs: 50 });
  const c = await connectRelay(rp.socket, a.grant(jail()).token);
  fs.renameSync(rp.socket, `${rp.socket}.moved`);
  const decoy = net.createServer();
  await new Promise<void>((r) => decoy.listen(rp.socket, r));
  assert.ok(await until(() => has(events, "socketReplaced")));
  await c.closed;
  assert.ok(await until(() => has(events, "closed", "revoked")));
  assert.equal(a.healthy(), false);
  // Closing our listener unlinks the path (libuv), so the decoy's file may be gone; a listener that holds the path
  // when restart() runs is refused, never unlinked.
  fs.rmSync(rp.socket, { force: true });
  const squat = net.createServer((x) => x.destroy());
  await new Promise<void>((r) => squat.listen(rp.socket, r));
  try {
    await assert.rejects(a.restart(), RelaySetupError, "a live foreign listener at the path is refused");
  } finally {
    squat.close();
    decoy.close();
  }
  fs.rmSync(rp.socket, { force: true });
  await a.restart();
  assert.equal(a.healthy(), true);
});

test("a validator that crashes or exits with an unknown code ends the binding as a violation (I-2)", async () => {
  // SYNTHETIC stand-ins for a validator that Codex input crashed: a signal death, and Node's own exit code 1.
  for (const script of ['process.kill(process.pid, "SIGSEGV")', "process.exit(1)"]) {
    const { a, events, rp } = await start({ validator: { command: process.execPath, args: ["-e", script], env: { PATH: "/usr/bin:/bin" }, cwd: "/" } });
    const c = await connectRelay(rp.socket, a.grant(jail()).token);
    await c.closed;
    assert.ok(await until(() => has(events, "closed", "violation")), script);
  }
});

test("a jail that cannot spawn plus a validator spawn that throws reports error and never signals the process group (review 7)", async () => {
  // Detached = its own process group, so a kill(0) regression kills only the child, never the test runner.
  const child = spawn(process.execPath, [fileURLToPath(new URL("./pidlessChild.ts", import.meta.url))], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
  const exit = new Promise<{ code: number | null; signal: string | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  const res = await Promise.race([exit, sleep(15_000).then(() => "timeout" as const)]);
  if (res === "timeout") process.kill(-(child.pid as number), "SIGKILL");
  assert.deepEqual(res, { code: 0, signal: null });
  assert.equal(out.trim(), "RESULT error");
});

test("a grant revoked between the proof match and the bind is never bound (review 1)", async () => {
  const { a, events, rp } = await start();
  const g = a.grant(jail());
  // Delay only companiond's write callback for its own 65-byte reader proof (the only write that passes a callback).
  const realWrite = net.Socket.prototype.write;
  net.Socket.prototype.write = function (this: net.Socket, chunk: any, ...rest: any[]) {
    const cb = rest.find((x) => typeof x === "function");
    if (typeof chunk === "string" && chunk.length === 65 && cb) {
      const done = realWrite.call(this, chunk);
      setTimeout(() => cb(), 200);
      return done;
    }
    return (realWrite as any).call(this, chunk, ...rest);
  } as typeof net.Socket.prototype.write;
  try {
    const pending = connectRelay(rp.socket, g.token);
    await sleep(100); // matched; the callback is still 100 ms away
    assert.equal(a.counts.grants, 0, "the grant is matched");
    g.revoke();
    const c = await pending;
    // Bounded: if the grant were bound, the connection would stay open and this must fail, not hang.
    assert.notEqual(await Promise.race([c.closed.then(() => "closed"), sleep(2000).then(() => "open")]), "open", "the connection was closed");
  } finally {
    net.Socket.prototype.write = realWrite;
  }
  assert.ok(await until(() => has(events, "closed", "revoked")));
  assert.equal(has(events, "bound"), false);
  assert.equal(a.counts.bound, 0);
});

test("a revoked grant is refused at connect; an unarmed grant ends at maxAgeMs (I1)", async () => {
  const { a, events, rp } = await start({ maxAgeMs: 150 });
  const g = a.grant(jail());
  g.revoke();
  await (await connectRelay(rp.socket, g.token)).closed;
  assert.ok(await until(() => events.filter((e) => e.type === "refused").length === 1));
  const old = a.grant(jail()); // never armed
  await sleep(300);
  await (await connectRelay(rp.socket, old.token)).closed;
  assert.ok(await until(() => events.filter((e) => e.type === "refused").length === 2));
  assert.equal(has(events, "bound"), false);
});

test("live bindings are capped at maxBound (M4)", async () => {
  const { a, events, rp } = await start({ maxBound: 1 });
  const first = await connectRelay(rp.socket, a.grant(jail()).token);
  assert.equal(first.isClosed(), false);
  const second = await connectRelay(rp.socket, a.grant(jail()).token);
  await second.closed;
  assert.ok(await until(() => events.some((e) => e.type === "refused" && e.reason === "too many connections")));
  assert.equal(a.counts.bound, 1);
  first.end();
});

test("the socket is checked at accept: a swap between connect and accept is reported (I-8)", async () => {
  const { a, events, rp } = await start({ inodeCheckMs: 60_000 });
  const s = net.connect(rp.socket);
  s.on("error", () => {});
  // The kernel completes a unix connect synchronously; the acceptor's accept callback runs on a later tick.
  fs.renameSync(rp.socket, `${rp.socket}.moved`);
  assert.ok(await until(() => has(events, "socketReplaced")));
  assert.equal(events.some((e) => e.type === "refused"), false);
  assert.equal(a.healthy(), false);
  s.destroy();
});

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

test("a grant's secret reaches the server on fd 3 only; never in its argv or env (M6)", async () => {
  const { a, rp } = await start();
  const secret = "SYNTHETIC-SECRET-LINE";
  const launch = jail("echo-fd3");
  const g = a.grant(launch, { secret: `${secret}\n` });
  const c = await connectRelay(rp.socket, g.token);
  c.send(INIT);
  assert.ok(await c.reply(1));
  c.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: {} } });
  const r = await c.reply(2);
  assert.equal(r?.result?.content?.[0]?.text, `SYNTHETIC FIXTURE fd3=${secret}`);
  assert.ok(!JSON.stringify(launch).includes(secret));
  c.end();
});

test("a grant's own validator is used: a Jira grant allows only the Jira tools (M6)", async () => {
  const { a, rp, events } = await start();
  const jiraValidator: LaunchSpec = { ...validator(), args: [VALIDATOR, "jira_get_issue,jira_search,jira_get_comments"] };
  const ok = a.grant(jail("tools-jira"), { validator: jiraValidator });
  const c = await connectRelay(rp.socket, ok.token);
  c.send(INIT);
  assert.ok(await c.reply(1));
  c.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jira_search", arguments: {} } });
  assert.equal((await c.reply(2))?.result?.isError, false);
  c.end();
  const bad = a.grant(jail("tools-jira"), { validator: jiraValidator });
  const c2 = await connectRelay(rp.socket, bad.token);
  c2.send(INIT);
  assert.ok(await c2.reply(1));
  c2.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: {} } }); // a companion-readonly tool on the Jira binding
  assert.ok(await until(() => has(events, "closed", "violation")));
});

test("a spawn that throws ends that binding with error, kills the jail and leaves the acceptor working (review 6)", async () => {
  const dir = tempDir("cgc-acc-");
  const pidFile = `${dir}/jail.pid`;
  const sleeper: LaunchSpec = {
    command: process.execPath,
    args: ["-e", 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidFile],
    env: { PATH: "/usr/bin:/bin" }, cwd: "/",
  };
  // A NUL byte in an argument makes child_process.spawn throw synchronously.
  const { a, events, rp } = await start({ validator: { command: process.execPath, args: ["a\0b"], env: { PATH: "/usr/bin:/bin" }, cwd: "/" } });
  await (await connectRelay(rp.socket, a.grant(sleeper).token)).closed;
  assert.ok(await until(() => has(events, "closed", "error")));
  // The jail is killed at once, normally before Node has even started it; one that survived would write its pid.
  await sleep(1000);
  if (fs.existsSync(pidFile)) {
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0), "the jail that did start was killed");
  }
  assert.equal(has(events, "bound"), false);
  assert.equal(a.counts.bound, 0);
  // The jail's own spawn throwing is handled the same way.
  const b = await start();
  await (await connectRelay(b.rp.socket, b.a.grant({ ...jail(), args: ["a\0b"] }).token)).closed;
  assert.ok(await until(() => has(b.events, "closed", "error")));
  const c = await connectRelay(b.rp.socket, b.a.grant(jail()).token);
  c.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(await c.reply(1), "the acceptor still serves");
});
