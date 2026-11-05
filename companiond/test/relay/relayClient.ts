// Test helper: the relay's side of the handshake in TypeScript (relay/relay.c is the real one), then JSON lines.
import net from "node:net";
import { HELLO_BYTES, proof, PROOF_BYTES } from "../../src/relay/handshake.ts";

export interface RelayClient {
  send(m: unknown): void;
  sendRaw(s: string): void;
  reply(id: number | string, ms?: number): Promise<any>;
  lines: any[];
  closed: Promise<void>;
  isClosed(): boolean;
  end(): void;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves once the handshake finished (OK received) or the connection closed. */
export function connectRelay(sockPath: string, token: string, o: { tamper?: "badProof" | "extraBytes" | "silent" } = {}): Promise<RelayClient> {
  return new Promise((resolve) => {
    const s = net.connect(sockPath);
    const lines: any[] = [];
    let closed = false;
    let stage: "hello" | "proof" | "ready" | "open" = "hello";
    let buf = Buffer.alloc(0);
    let text = "";
    let nonce = Buffer.alloc(0);
    const client: RelayClient = {
      send: (m) => s.write(`${JSON.stringify(m)}\n`),
      sendRaw: (x) => s.write(x),
      reply: async (id, ms = 5000) => {
        for (let t = 0; t < ms; t += 20) {
          const hit = lines.find((l) => l?.id === id);
          if (hit) return hit;
          if (closed) return null;
          await sleep(20);
        }
        return null;
      },
      lines,
      closed: new Promise<void>((r) => s.on("close", () => {
        closed = true;
        r();
      })),
      isClosed: () => closed,
      end: () => s.end(),
    };
    s.on("error", () => {});
    s.on("close", () => resolve(client));
    const onData = (c: Buffer): void => {
      if (stage === "open") {
        text += c.toString("utf8");
        for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n")) {
          const l = text.slice(0, nl);
          text = text.slice(nl + 1);
          try {
            lines.push(JSON.parse(l));
          } catch {
            lines.push(l);
          }
        }
        return;
      }
      buf = Buffer.concat([buf, c]);
      if (stage === "hello" && buf.length >= HELLO_BYTES) {
        nonce = Buffer.from(buf.subarray(5, HELLO_BYTES - 1).toString("latin1"), "hex");
        buf = buf.subarray(HELLO_BYTES);
        stage = "proof";
        if (o.tamper === "silent") return;
        const p = o.tamper === "badProof" ? "0".repeat(64) : proof(token, nonce, "relay");
        s.write(`${p}\n${o.tamper === "extraBytes" ? "junk\n" : ""}`);
      }
      if (stage === "proof" && buf.length >= PROOF_BYTES) {
        if (buf.subarray(0, PROOF_BYTES - 1).toString("latin1") !== proof(token, nonce, "reader")) {
          s.destroy();
          return;
        }
        buf = buf.subarray(PROOF_BYTES);
        stage = "ready";
      }
      if (stage === "ready" && buf.length >= 3) {
        if (buf.subarray(0, 3).toString("latin1") !== "OK\n") {
          s.destroy();
          return;
        }
        const rest = buf.subarray(3);
        stage = "open";
        resolve(client);
        if (rest.length > 0) onData(rest);
      }
    };
    s.on("data", onData);
  });
}
