// The compiled relay → acceptor → sandboxed validator → the real M2 jail on a fixture repo. No Codex, no network.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { TOOL_NAMES } from "../../src/jail/mcpServer.ts";
import { buildReadonlyLaunch } from "../../src/launch/seatbelt.ts";
import { discoverToolchain } from "../../src/launch/toolchain.ts";
import { RelayAcceptor } from "../../src/relay/acceptor.ts";
import type { BrokerEvent } from "../../src/relay/broker.ts";
import { buildRelay } from "../../src/relay/relayBuild.ts";
import { ensureRelayDirs, relayPaths } from "../../src/relay/relayPaths.ts";
import { buildValidatorLaunch } from "../../src/relay/validatorProfile.ts";
import { makeRepo, removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);
const skip = process.platform !== "darwin" ? "macOS only (Seatbelt, clang)" : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("relay → acceptor → sandboxed validator → jail lists the fixture repo", { skip }, async () => {
  const tc = discoverToolchain();
  const rp = ensureRelayDirs(relayPaths(tempDir("cgc-e2e-")));
  buildRelay({ socketPath: rp.socket, outFile: rp.binary });
  const acceptor = new RelayAcceptor({ socketPath: rp.socket, validator: buildValidatorLaunch(tc, TOOL_NAMES) });
  const events: BrokerEvent[] = [];
  acceptor.on((e) => events.push(e));
  await acceptor.start();
  try {
    const repo = makeRepo({ "pelican-ledger.txt": "ledger\n" });
    const g = acceptor.grant(await buildReadonlyLaunch({ root: repo, toolchain: tc }));
    const p = spawn(rp.binary, [], { env: { CGC_RELAY_TOKEN: g.token }, stdio: ["pipe", "pipe", "ignore"] });
    const got = new Map<number, any>();
    let text = "";
    p.stdout.on("data", (c: Buffer) => {
      text += c.toString("utf8");
      for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n")) {
        const m = JSON.parse(text.slice(0, nl));
        text = text.slice(nl + 1);
        if (typeof m.id === "number") got.set(m.id, m);
      }
    });
    const exit = new Promise<number | null>((r) => p.on("exit", (code) => r(code)));
    const ask = async (m: Record<string, unknown>) => {
      p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
      for (let t = 0; t < 20_000 && !got.has(m.id as number); t += 20) await sleep(20);
      return got.get(m.id as number);
    };
    assert.ok((await ask({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }))?.result);
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    assert.deepEqual(((await ask({ id: 2, method: "tools/list" }))?.result?.tools ?? []).map((t: any) => t.name).sort(), [...TOOL_NAMES].sort());
    assert.match((await ask({ id: 3, method: "tools/call", params: { name: "list_dir", arguments: {} } }))?.result?.content?.[0]?.text ?? "", /pelican-ledger\.txt/);
    assert.equal((await ask({ id: 4, method: "resources/read", params: { uri: "file:///etc/hosts" } }))?.error?.code, -32002);
    p.stdin.end();
    assert.equal(await Promise.race([exit, sleep(10_000).then(() => "timeout")]), 0);
    for (let t = 0; t < 5000 && !events.some((e) => e.type === "closed"); t += 20) await sleep(20);
    assert.deepEqual(events.map((e) => (e.type === "closed" ? `closed:${e.end}` : e.type)), ["bound", "closed:normal"]);
  } finally {
    await acceptor.stop();
  }
});
