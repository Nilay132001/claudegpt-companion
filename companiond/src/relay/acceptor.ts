// The relay acceptor (spec §7.1.9; review C1, I1, I2, M4, M7). Runs in companiond and parses no JSON: it checks the
// socket and its folder, runs the handshake (fixed-size hex lines), and on success spawns the jail (the grant's M2
// launch) and the sandboxed validator, handing the validator the connection and the jail's pipes as fds 3, 4, 5.
// companiond keeps no copy of either, so it never reads a byte of Codex's MCP traffic. Every refused connection and
// a replaced socket are reported; CodexHost stops everything on them (fail-stop).
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { LaunchSpec } from "../launch/seatbelt.ts";
import { DEFAULT_TOKEN_TTL_MS, GRANT_MAX_AGE_MS, type BindingEnd, type BrokerEvent, type RelayBroker, type RelayGrant } from "./broker.ts";
import { helloLine, newNonce, newToken, proof, PROOF_BYTES } from "./handshake.ts";
import { EXIT } from "./mcpFilter.ts";
import { checkPrivateDir, RelaySetupError } from "./relayPaths.ts";

export interface AcceptorOptions {
  socketPath: string;
  /** The sandboxed validator. It gets the connection on fd 3, the jail's stdin on fd 4 and its stdout on fd 5. */
  validator: LaunchSpec;
  handshakeMs?: number;
  /** Review M4: connections still in the handshake and live bindings are capped separately. */
  maxPending?: number;
  maxBound?: number;
  maxAgeMs?: number;
  inodeCheckMs?: number;
}

interface Grant { id: string; token: string; launch: LaunchSpec; expires: number }
interface Binding { jail: ChildProcess; validator: ChildProcess; revoked: boolean }

const END_BY_EXIT: ReadonlyMap<number, BindingEnd> = new Map([
  [EXIT.normal, "normal"], [EXIT.idle, "idle"], [EXIT.violation, "violation"], [EXIT.limit, "limit"], [EXIT.jail, "jail"], [EXIT.error, "error"],
]);

/** A dead socket of ours is removed; a live one (another companiond or itest run) or anything else is refused (M7, M-9). */
async function removeStaleSocket(p: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!st.isSocket() || st.uid !== (process.getuid?.() ?? -1)) {
    throw new RelaySetupError("Something that is not the companion's socket is where its socket goes.");
  }
  const live = await new Promise<boolean>((resolve) => {
    const c = net.connect(p);
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
  if (live) throw new RelaySetupError("Another program is listening on the companion's relay socket.");
  fs.unlinkSync(p);
}

export class RelayAcceptor implements RelayBroker {
  #o: AcceptorOptions;
  #server: net.Server | null = null;
  #ino: { dev: number; ino: number } | null = null;
  #timer: NodeJS.Timeout | null = null;
  #grants = new Map<string, Grant>();
  #bound = new Map<string, Binding>();
  #pending = new Set<net.Socket>();
  #listeners = new Set<(e: BrokerEvent) => void>();
  #seq = 0;

  constructor(o: AcceptorOptions) {
    this.#o = o;
  }

  get counts(): { pending: number; bound: number; grants: number } {
    return { pending: this.#pending.size, bound: this.#bound.size, grants: this.#grants.size };
  }

  on(l: (e: BrokerEvent) => void): () => void {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  }

  healthy(): boolean {
    return this.#server !== null && this.#inodeOk();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async start(): Promise<void> {
    if (this.#server) return;
    checkPrivateDir(path.dirname(this.#o.socketPath));
    await removeStaleSocket(this.#o.socketPath);
    const server = net.createServer({ allowHalfOpen: true }, (s) => this.#onConnection(s));
    const old = process.umask(0o077);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#o.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } finally {
      process.umask(old);
    }
    fs.chmodSync(this.#o.socketPath, 0o600);
    const st = fs.lstatSync(this.#o.socketPath);
    this.#ino = { dev: st.dev, ino: st.ino };
    server.on("error", () => this.#replaced());
    this.#server = server;
    this.#timer = setInterval(() => this.#sweep(), this.#o.inodeCheckMs ?? 2000);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const id of [...this.#grants.keys(), ...this.#bound.keys()]) this.#revoke(id);
    for (const s of this.#pending) s.destroy();
    this.#pending.clear();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (this.#ino) {
      try {
        const st = fs.lstatSync(this.#o.socketPath);
        if (st.dev === this.#ino.dev && st.ino === this.#ino.ino) fs.unlinkSync(this.#o.socketPath);
      } catch {
        // already gone
      }
    }
    this.#ino = null;
  }

  grant(launch: LaunchSpec): RelayGrant {
    const g: Grant = { id: `g${++this.#seq}`, token: newToken(), launch, expires: Date.now() + (this.#o.maxAgeMs ?? GRANT_MAX_AGE_MS) };
    this.#grants.set(g.id, g);
    return {
      id: g.id,
      token: g.token,
      arm: (ttlMs = DEFAULT_TOKEN_TTL_MS) => {
        g.expires = Math.min(g.expires, Date.now() + ttlMs);
      },
      revoke: () => this.#revoke(g.id),
    };
  }

  #emit(e: BrokerEvent): void {
    for (const l of this.#listeners) {
      try {
        l(e);
      } catch {
        // a listener bug must not stop the others
      }
    }
  }

  #onConnection(s: net.Socket): void {
    s.on("error", () => {});
    if (!this.#inodeOk()) {
      // Checked at every accept, not only by the sweep (plan review I-8).
      s.destroy();
      this.#replaced();
      return;
    }
    if (this.#pending.size >= (this.#o.maxPending ?? 4) || this.#bound.size >= (this.#o.maxBound ?? 16)) {
      s.destroy();
      this.#emit({ type: "refused", reason: "too many connections" });
      return;
    }
    this.#pending.add(s);
    const nonce = newNonce();
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (): void => {
      done = true;
      clearTimeout(timer);
      this.#pending.delete(s);
      s.off("data", onData);
      s.off("close", onClose);
    };
    const refuse = (reason: string): void => {
      if (done) return;
      finish();
      s.destroy();
      this.#emit({ type: "refused", reason });
    };
    const timer = setTimeout(() => refuse("no proof in time"), this.#o.handshakeMs ?? 3000);
    const onClose = (): void => refuse("closed during the handshake");
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < PROOF_BYTES) return;
      if (buf.length > PROOF_BYTES) return refuse("data before authentication");
      if (buf[PROOF_BYTES - 1] !== 0x0a) return refuse("bad proof");
      const g = this.#match(buf.subarray(0, PROOF_BYTES - 1), nonce);
      if (!g) return refuse("bad proof");
      finish();
      s.pause();
      this.#grants.delete(g.id); // one use
      s.write(`${proof(g.token, nonce, "reader")}\n`, (err) => {
        // pause() does not stop libuv reads, so a client that sent bytes before the validator's OK would leave them
        // in companiond's buffer. The real relay sends nothing before OK: anything here is a violation (M-8).
        if (err || s.readableLength > 0 || !this.#inodeOk()) {
          s.destroy();
          this.#emit({ type: "closed", grantId: g.id, end: err ? "dropped" : "violation" });
          return;
        }
        this.#bind(s, g);
      });
    };
    s.on("data", onData);
    s.on("close", onClose);
    s.write(helloLine(nonce));
  }

  /** Constant-time over every live grant; an expired grant never matches. */
  #match(got: Buffer, nonce: Buffer): Grant | null {
    const now = Date.now();
    let hit: Grant | null = null;
    for (const g of this.#grants.values()) {
      const want = Buffer.from(proof(g.token, nonce, "relay"), "latin1");
      if (want.length === got.length && crypto.timingSafeEqual(want, got) && g.expires > now) hit = g;
    }
    return hit;
  }

  #bind(s: net.Socket, g: Grant): void {
    const l = g.launch;
    const jail = spawn(l.command, l.args, { env: l.env, cwd: l.cwd, stdio: ["pipe", "pipe", "ignore"] });
    if (!jail.stdin || !jail.stdout) {
      s.destroy();
      jail.kill("SIGKILL");
      this.#emit({ type: "closed", grantId: g.id, end: "error" });
      return;
    }
    const v = this.#o.validator;
    const validator = spawn(v.command, v.args, { env: v.env, cwd: v.cwd, stdio: ["ignore", "ignore", "ignore", s, jail.stdin, jail.stdout] });
    // The children hold their own copies now; companiond closes its own and parses nothing (it has read only the
    // fixed-size handshake lines).
    s.destroy();
    jail.stdin.destroy();
    jail.stdout.destroy();
    const b: Binding = { jail, validator, revoked: false };
    this.#bound.set(g.id, b);
    let killedAfterJail = false;
    let ended = false;
    const end = (e: BindingEnd): void => {
      if (ended) return;
      ended = true;
      this.#bound.delete(g.id);
      this.#emit({ type: "closed", grantId: g.id, end: b.revoked ? "revoked" : e });
    };
    const alive = (p: ChildProcess) => p.exitCode === null && p.signalCode === null;
    jail.on("error", () => {
      if (alive(validator)) validator.kill("SIGKILL");
    });
    jail.on("exit", () => {
      // A jail that exits on a clean EOF is normal: the validator sees its stdout end and exits on its own.
      // Only a validator that is still there after a short grace period is killed.
      setTimeout(() => {
        if (!alive(validator)) return;
        killedAfterJail = true;
        validator.kill("SIGKILL");
      }, 2000).unref();
    });
    validator.on("error", () => {
      if (alive(jail)) jail.kill("SIGKILL");
      end("error");
    });
    validator.on("exit", (code) => {
      if (alive(jail)) jail.kill("SIGKILL");
      // A signal death or an unknown code is how an attack on the parser looks: never a silent rebind (I-2).
      const mapped = code !== null ? END_BY_EXIT.get(code) : undefined;
      end(mapped ?? (killedAfterJail ? "jail" : "violation"));
    });
    this.#emit({ type: "bound", grantId: g.id });
  }

  #revoke(id: string): void {
    this.#grants.delete(id);
    const b = this.#bound.get(id);
    if (!b) return;
    b.revoked = true;
    b.validator.kill("SIGKILL");
    b.jail.kill("SIGKILL");
  }

  #inodeOk(): boolean {
    if (!this.#ino) return false;
    try {
      const st = fs.lstatSync(this.#o.socketPath);
      return st.isSocket() && st.dev === this.#ino.dev && st.ino === this.#ino.ino;
    } catch {
      return false;
    }
  }

  /** Drops expired grants and checks that the socket path is still our socket (review I2). A same-uid swap that is
   * restored between two checks is not detected (spec residual risk). */
  #sweep(): void {
    const now = Date.now();
    for (const [id, g] of this.#grants) if (g.expires <= now) this.#grants.delete(id);
    if (this.#server && !this.#inodeOk()) this.#replaced();
  }

  #replaced(): void {
    if (!this.#server) return;
    for (const id of [...this.#grants.keys(), ...this.#bound.keys()]) this.#revoke(id);
    const server = this.#server;
    this.#server = null;
    this.#ino = null;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    server.close();
    this.#emit({ type: "socketReplaced" });
  }
}
