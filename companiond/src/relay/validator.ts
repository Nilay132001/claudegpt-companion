// The validator (spec §7.1.9; review C1). Runs under its own Seatbelt profile (validatorProfile.ts): no network,
// no exec, no file writes. fd 3 is the authenticated relay connection, fd 4 the jail's stdin, fd 5 the jail's
// stdout. Every line goes through McpFilter; anything unexpected ends the process with an EXIT code, which is all
// the acceptor reads. It prints nothing and keeps no message bodies.
// Usage (from the acceptor only): node validator.ts <comma-separated tool names>
import net from "node:net";
import { LineBuffer } from "../lineBuffer.ts";
import { READY_LINE } from "./handshake.ts";
import { EXIT, IDLE_MS, MAX_LINE_BYTES, McpFilter, sendLine } from "./mcpFilter.ts";

const tools = (process.argv[2] ?? "").split(",").filter((t) => t.length > 0);
// Tests shorten the idle timeout through the env the acceptor sets; it can only be made shorter, never longer.
const idleMs = Math.min(IDLE_MS, Math.max(500, Number(process.env.CGC_VALIDATOR_IDLE_MS) || IDLE_MS));
const codex = new net.Socket({ fd: 3, readable: true, writable: true, allowHalfOpen: true });
const toJail = new net.Socket({ fd: 4, readable: false, writable: true });
const fromJail = new net.Socket({ fd: 5, readable: true, writable: false });
const filter = new McpFilter(tools);
const fromCodex = new LineBuffer({ maxLineBytes: MAX_LINE_BYTES });
const fromServer = new LineBuffer({ maxLineBytes: MAX_LINE_BYTES });
let codexEnded = false;
let finished = false;

function finish(code: number): void {
  if (finished) return;
  finished = true;
  codex.destroy();
  toJail.destroy();
  fromJail.destroy();
  process.exit(code);
}
let idle = setTimeout(() => finish(EXIT.idle), idleMs);
const bump = (): void => {
  clearTimeout(idle);
  idle = setTimeout(() => finish(EXIT.idle), idleMs);
};

for (const s of [codex, toJail, fromJail]) s.on("error", () => finish(EXIT.error));

codex.on("data", (chunk: Buffer) => {
  bump();
  const lines = fromCodex.push(chunk);
  if (fromCodex.oversizedLines > 0 || fromCodex.invalidUtf8Lines > 0) return finish(EXIT.violation);
  for (const line of lines) {
    const v = filter.fromClient(line);
    if (v.kind === "close") return finish(v.code);
    if (v.kind === "local") sendLine(codex, v.line, codex);
    else if (v.kind === "forward") sendLine(toJail, v.line, codex);
  }
});
codex.on("end", () => {
  codexEnded = true;
  toJail.end();
});

fromJail.on("data", (chunk: Buffer) => {
  bump();
  const lines = fromServer.push(chunk);
  if (fromServer.oversizedLines > 0 || fromServer.invalidUtf8Lines > 0) return finish(EXIT.violation);
  for (const line of lines) {
    const v = filter.fromServer(line);
    if (v.kind === "close") return finish(v.code);
    if (v.kind === "forward") sendLine(codex, v.line, fromJail);
  }
});
fromJail.on("end", () => {
  if (!codexEnded) return finish(EXIT.jail); // the jail went away while Codex was still talking to it
  codex.end(() => finish(EXIT.normal));
});

// Tells the relay that the validator now owns the connection (relay/relay.c waits for this line).
codex.write(READY_LINE);
