// SYNTHETIC FIXTURE — fake MCP stdio server for binding and Seatbelt measurements.
// It reports how it was launched (argv[2], env FAKE_ROOT, cwd) in serverInfo.version and in its one tool.
// It reads no files, except with FAKE_PROBE=1: then it lists FAKE_ROOT and runs FAKE_GIT once, and reports
// only whether each worked ({readRoot, git}), never what it saw.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { SAFE_GIT_ENV, SAFE_GIT_FLAGS } from "../../src/git/safeGit.ts";
import { LineBuffer } from "../../src/lineBuffer.ts";

function probe(): { readRoot: boolean; git: boolean } | null {
  if (process.env.FAKE_PROBE !== "1") return null;
  const root = process.env.FAKE_ROOT ?? "";
  let readRoot = false;
  let git = false;
  try {
    fs.readdirSync(root);
    readRoot = true;
  } catch {
    readRoot = false;
  }
  try {
    // Same env and flags as the jail's SafeGit (no ~/.gitconfig, no hooks), so a blocked global config is not a false STOP.
    execFileSync(process.env.FAKE_GIT ?? "/usr/bin/false", ["-C", root, ...SAFE_GIT_FLAGS, "rev-parse", "--is-inside-work-tree"], { env: { ...SAFE_GIT_ENV }, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    git = true;
  } catch {
    git = false;
  }
  return { readRoot, git };
}

const tag = JSON.stringify({ arg: process.argv[2] ?? null, env: process.env.FAKE_ROOT ?? null, cwd: process.cwd(), probe: probe() });
const tools = (process.env.FAKE_TOOLS ?? "whereami").split(",");
const lb = new LineBuffer();
const reply = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

process.stdin.on("data", (c: Buffer) => {
  for (const line of lb.push(c)) {
    const m = JSON.parse(line) as { id?: number | string; method?: string; params?: { protocolVersion?: string } };
    if (m.id === undefined) continue;
    if (m.method === "initialize") {
      reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: tag } } });
    } else if (m.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: m.id, result: { tools: tools.map((name) => ({ name, description: "SYNTHETIC FIXTURE tool", inputSchema: { type: "object", properties: {} } })) } });
    } else if (m.method === "tools/call") {
      reply({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: tag }], isError: false } });
    } else {
      reply({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } });
    }
  }
});
