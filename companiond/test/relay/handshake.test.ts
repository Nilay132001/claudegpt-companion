import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { HELLO_BYTES, helloLine, newNonce, newToken, proof, PROOF_BYTES, TOKEN_RE } from "../../src/relay/handshake.ts";

test("tokens are 64 lowercase hex characters and never repeat", () => {
  const a = newToken();
  assert.match(a, TOKEN_RE);
  assert.notEqual(a, newToken());
});

test("the hello line is CGC1, a 64-hex nonce and a newline", () => {
  const n = newNonce();
  assert.equal(n.length, 32);
  const h = helloLine(n);
  assert.equal(Buffer.byteLength(h), HELLO_BYTES);
  assert.equal(h, `CGC1 ${n.toString("hex")}\n`);
});

test("proofs are HMAC-SHA256 per side and differ by side, token and nonce", () => {
  const t = newToken();
  const n = newNonce();
  const r = proof(t, n, "relay");
  assert.match(r, /^[0-9a-f]{64}$/);
  assert.equal(r.length + 1, PROOF_BYTES);
  assert.equal(r, crypto.createHmac("sha256", Buffer.from(t, "latin1")).update(Buffer.concat([n, Buffer.from("relay")])).digest("hex"));
  assert.notEqual(r, proof(t, n, "reader"));
  assert.notEqual(r, proof(newToken(), n, "relay"));
  assert.notEqual(r, proof(t, newNonce(), "relay"));
});
