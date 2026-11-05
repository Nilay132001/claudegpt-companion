// The relay handshake (spec §7.1.9; review I2). companiond's side lives in acceptor.ts, the relay's in relay/relay.c.
// The token never goes on the wire: each side proves it holds it with HMAC-SHA256(token, nonce || side).
import crypto from "node:crypto";

export const HELLO_PREFIX = "CGC1 ";
export const HELLO_BYTES = 70; // "CGC1 " + 64 hex + "\n"
export const PROOF_BYTES = 65; // 64 hex + "\n"
export const READY_LINE = "OK\n"; // sent by the validator, never by companiond
export const TOKEN_RE = /^[0-9a-f]{64}$/;

export const newToken = (): string => crypto.randomBytes(32).toString("hex");
export const newNonce = (): Buffer => crypto.randomBytes(32);
export const helloLine = (nonce: Buffer): string => `${HELLO_PREFIX}${nonce.toString("hex")}\n`;

export function proof(token: string, nonce: Buffer, side: "relay" | "reader"): string {
  return crypto.createHmac("sha256", Buffer.from(token, "latin1")).update(nonce).update(side, "latin1").digest("hex");
}
