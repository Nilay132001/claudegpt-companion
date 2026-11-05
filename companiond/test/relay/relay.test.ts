// The compiled relay against a fake companiond side that speaks the handshake. macOS only; no Codex, no network.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { helloLine, newNonce, newToken, proof, PROOF_BYTES } from "../../src/relay/handshake.ts";
import { buildRelay } from "../../src/relay/relayBuild.ts";
import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);
const skip = process.platform !== "darwin" ? "macOS only (xcrun clang, CommonCrypto)" : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let sock = "";
let bin = "";
// Whatever a test leaves behind is closed here, so one failing assert cannot keep the file's process alive.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

before(() => {
  if (skip) return;
  const d = tempDir("cgc-rl-");
  sock = path.join(d, "s.sock");
  bin = path.join(d, "relay");
  buildRelay({ socketPath: sock, outFile: bin });
});

interface Peer { connections: number; received: Buffer[]; afterHandshake: Buffer[]; relayProofOk: boolean | null }

/** The companiond side: hello, check the relay's proof, send `readerProof` and `ready`, then echo with a prefix. */
async function fakeAcceptor(token: string, o: { hello?: (nonce: Buffer) => string; readerProof?: (nonce: Buffer, relayProof: string) => string; ready?: string; closeAfterHello?: boolean; silent?: boolean } = {}): Promise<{ peer: Peer; close: () => Promise<void> }> {
  fs.rmSync(sock, { force: true });
  const peer: Peer = { connections: 0, received: [], afterHandshake: [], relayProofOk: null };
  const conns = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (c) => {
    conns.add(c);
    peer.connections++;
    const nonce = newNonce();
    let open = false;
    let buf = Buffer.alloc(0);
    c.on("error", () => {});
    const hello = o.hello ? o.hello(nonce) : helloLine(nonce);
    if (o.closeAfterHello) c.end(hello); // hello, then FIN: the relay's proof can still arrive
    else c.write(hello);
    c.on("end", () => c.end());
    c.on("data", (chunk: Buffer) => {
      peer.received.push(chunk);
      if (o.closeAfterHello) {
        if (Buffer.concat(peer.received).length >= PROOF_BYTES) c.destroy(); // only after the proof is in
        return;
      }
      if (open) {
        peer.afterHandshake.push(chunk);
        c.write(Buffer.concat([Buffer.from("echo:"), chunk]));
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < PROOF_BYTES) return;
      peer.relayProofOk = buf.subarray(0, PROOF_BYTES).toString("latin1") === `${proof(token, nonce, "relay")}\n`;
      const rest = buf.subarray(PROOF_BYTES);
      if (rest.length > 0) peer.afterHandshake.push(rest);
      if (o.silent) return;
      const theirs = buf.subarray(0, PROOF_BYTES - 1).toString("latin1");
      c.write(`${o.readerProof ? o.readerProof(nonce, theirs) : `${proof(token, nonce, "reader")}\n`}${o.ready ?? "OK\n"}`);
      open = true;
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const close = () => new Promise<void>((r) => {
    for (const c of conns) c.destroy();
    server.close(() => r());
  });
  cleanups.push(() => void close());
  return { peer, close };
}

function runRelay(env: Record<string, string>, stdin: "pipe" | "ignore" = "pipe") {
  const p: ChildProcess = spawn(bin, [], { env, stdio: [stdin, "pipe", "ignore"] });
  cleanups.push(() => {
    if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  });
  const out: Buffer[] = [];
  p.stdout?.on("data", (c: Buffer) => out.push(c));
  p.stdin?.on("error", () => {});
  const exit = new Promise<number | null>((r) => p.on("exit", (code) => r(code)));
  return { p, text: () => Buffer.concat(out).toString("utf8"), exit };
}
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => "timeout" as const)]);

test("full handshake, then bytes flow both ways; the token never crosses the socket", { skip }, async () => {
  const token = newToken();
  const a = await fakeAcceptor(token);
  const r = runRelay({ CGC_RELAY_TOKEN: token });
  r.p.stdin?.write("ping\n");
  for (let t = 0; t < 5000 && !r.text().includes("echo:ping\n"); t += 20) await sleep(20);
  assert.equal(r.text(), "echo:ping\n");
  r.p.stdin?.end();
  assert.equal(await within(r.exit, 5000), 0);
  assert.equal(a.peer.relayProofOk, true);
  assert.equal(Buffer.concat(a.peer.received).includes(Buffer.from(token)), false);
  await a.close();
});

test("a wrong reader proof: exit 66 and no stdin byte reaches the socket", { skip }, async () => {
  const token = newToken();
  const a = await fakeAcceptor(token, { readerProof: () => `${"0".repeat(64)}\n` });
  const r = runRelay({ CGC_RELAY_TOKEN: token });
  r.p.stdin?.write("SYNTHETIC FIXTURE must not be forwarded\n");
  assert.equal(await within(r.exit, 8000), 66);
  assert.deepEqual(a.peer.afterHandshake, []);
  await a.close();
});

const flip = (h: string) => `${h.slice(0, -1)}${h.endsWith("0") ? "1" : "0"}`;
const badProofs: Array<[string, (token: string) => (nonce: Buffer, relayProof: string) => string]> = [
  ["the relay's own proof reflected back", () => (_n, rp) => `${rp}\n`],
  ["a proof over a different nonce", (t) => () => `${proof(t, newNonce(), "reader")}\n`],
  ["a proof wrong only in its last byte", (t) => (n) => `${flip(proof(t, n, "reader"))}\n`],
  ["a proof with no trailing newline", (t) => (n) => `${proof(t, n, "reader")}X`],
];
for (const [name, make] of badProofs) {
  test(`handshake refused: ${name} (exit 66, nothing forwarded)`, { skip }, async () => {
    const token = newToken();
    const a = await fakeAcceptor(token, { readerProof: make(token) });
    const r = runRelay({ CGC_RELAY_TOKEN: token });
    r.p.stdin?.write("SYNTHETIC FIXTURE must not be forwarded\n");
    assert.equal(await within(r.exit, 8000), 66);
    await sleep(100);
    assert.equal(Buffer.concat(a.peer.received).length, PROOF_BYTES);
    assert.deepEqual(a.peer.afterHandshake, []);
    await a.close();
  });
}

const badHellos: Array<[string, (nonce: Buffer) => string]> = [
  ["wrong prefix", (n) => `CGC2 ${n.toString("hex")}\n`],
  ["uppercase nonce", (n) => `CGC1 ${n.toString("hex").toUpperCase()}\n`],
  ["non-hex nonce", () => `CGC1 ${"g".repeat(64)}\n`],
  ["no newline", (n) => `CGC1 ${n.toString("hex")}X`],
];
for (const [name, hello] of badHellos) {
  test(`malformed hello (${name}): exit 66, the relay sends nothing`, { skip }, async () => {
    const token = newToken();
    const a = await fakeAcceptor(token, { hello });
    const r = runRelay({ CGC_RELAY_TOKEN: token });
    r.p.stdin?.write("SYNTHETIC FIXTURE must not be forwarded\n");
    assert.equal(await within(r.exit, 8000), 66);
    await sleep(100);
    assert.equal(Buffer.concat(a.peer.received).length, 0);
    await a.close();
  });
}

test("a silent peer: exit 66 within the one handshake deadline", { skip }, async () => {
  const token = newToken();
  const a = await fakeAcceptor(token, { silent: true });
  const t0 = Date.now();
  const r = runRelay({ CGC_RELAY_TOKEN: token });
  assert.equal(await within(r.exit, 8000), 66);
  assert.ok(Date.now() - t0 < 7000);
  assert.equal(Buffer.concat(a.peer.received).length, PROOF_BYTES);
  await a.close();
});

test("a ready line other than OK: exit 66, nothing forwarded", { skip }, async () => {
  const token = newToken();
  const a = await fakeAcceptor(token, { ready: "NO\n" });
  const r = runRelay({ CGC_RELAY_TOKEN: token });
  r.p.stdin?.write("SYNTHETIC FIXTURE must not be forwarded\n");
  assert.equal(await within(r.exit, 8000), 66);
  assert.deepEqual(a.peer.afterHandshake, []);
  await a.close();
});

test("a missing or malformed token: exit 64 before any connection", { skip }, async () => {
  const a = await fakeAcceptor(newToken());
  for (const env of [{}, { CGC_RELAY_TOKEN: "abc" }, { CGC_RELAY_TOKEN: newToken().toUpperCase() }] as Record<string, string>[]) {
    assert.equal(await within(runRelay(env).exit, 5000), 64);
  }
  assert.equal(a.peer.connections, 0);
  await a.close();
});

test("nothing listening: exit 69; closed during the handshake: exit 66", { skip }, async () => {
  fs.rmSync(sock, { force: true });
  assert.equal(await within(runRelay({ CGC_RELAY_TOKEN: newToken() }).exit, 5000), 69);
  const a = await fakeAcceptor(newToken(), { closeAfterHello: true });
  assert.equal(await within(runRelay({ CGC_RELAY_TOKEN: newToken() }).exit, 8000), 66);
  assert.equal(Buffer.concat(a.peer.received).length, PROOF_BYTES);
  await a.close();
});

test("stdin closed by Codex: the relay half-closes, drains and exits 0", { skip }, async () => {
  const token = newToken();
  const a = await fakeAcceptor(token);
  const r = runRelay({ CGC_RELAY_TOKEN: token });
  r.p.stdin?.end();
  assert.equal(await within(r.exit, 5000), 0);
  await a.close();
});

test("a stdin poll() cannot use is fatal at once, not a busy loop (M3)", { skip }, async () => {
  // Measured while writing this plan: macOS poll() reports POLLNVAL for /dev/null (what "ignore" gives fd 0).
  const token = newToken();
  const a = await fakeAcceptor(token);
  const t0 = Date.now();
  const r = runRelay({ CGC_RELAY_TOKEN: token }, "ignore");
  assert.equal(await within(r.exit, 5000), 70);
  assert.ok(Date.now() - t0 < 2000);
  await a.close();
});
