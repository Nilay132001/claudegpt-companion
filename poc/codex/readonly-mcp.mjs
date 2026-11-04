#!/usr/bin/env node
// PoC (throwaway): minimal read-only MCP server over stdio, jailed to one repo root.
// Tools: list_dir, read_file, search, git_status, git_diff. No writes, no arbitrary shell.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import readline from "node:readline";

const ROOT = fs.realpathSync(process.env.COMPANION_ROOT || process.cwd());
const MAX_BYTES = 200_000;

const DENY_SEGMENTS = new Set([".git", ".ssh", ".aws", ".gnupg", "node_modules", ".venv", "venv", "__pycache__", ".codex", ".claude"]);
const DENY_FILE = [/^\.env(\..*)?$/i, /\.(pem|key|p12|pfx|keystore|jks|crt)$/i, /^id_(rsa|ed25519|ecdsa|dsa)/i, /credentials/i, /secret/i, /\.npmrc$/i, /\.netrc$/i, /\.pgpass$/i];

export function resolveSafe(rel) {
  const abs = path.resolve(ROOT, rel || ".");
  let real;
  try { real = fs.realpathSync(abs); } catch { throw new Error("not found"); }
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new Error("outside repository");
  const parts = path.relative(ROOT, real).split(path.sep).filter(Boolean);
  for (const p of parts) if (DENY_SEGMENTS.has(p)) throw new Error("blocked path");
  const base = parts.at(-1) || "";
  if (DENY_FILE.some((re) => re.test(base))) throw new Error("blocked sensitive file");
  return real;
}

function git(args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 4 * MAX_BYTES }).slice(0, MAX_BYTES);
}

const tools = {
  list_dir: {
    description: "List a directory inside the selected repository (read-only).",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    run: ({ path: p }) => fs.readdirSync(resolveSafe(p), { withFileTypes: true })
      .filter((d) => !DENY_SEGMENTS.has(d.name))
      .map((d) => (d.isDirectory() ? d.name + "/" : d.name)).join("\n"),
  },
  read_file: {
    description: "Read a text file inside the selected repository, with line numbers. Optional 1-based start/end lines.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, start: { type: "number" }, end: { type: "number" } }, required: ["path"] },
    run: ({ path: p, start = 1, end }) => {
      const real = resolveSafe(p);
      const lines = fs.readFileSync(real, "utf8").slice(0, MAX_BYTES).split("\n");
      const s = Math.max(1, start), e = Math.min(lines.length, end || lines.length);
      return lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join("\n");
    },
  },
  search: {
    description: "Search tracked files in the repository for a fixed string (git grep).",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run: ({ query }) => {
      try { return git(["grep", "-n", "-I", "-F", "--", query, ":!*.env*", ":!*.pem", ":!*.key"]); }
      catch { return "(no matches)"; }
    },
  },
  git_status: { description: "Show uncommitted changes summary.", inputSchema: { type: "object", properties: {} }, run: () => git(["status", "--short", "--branch"]) },
  git_diff: { description: "Show uncommitted diff (working tree vs HEAD).", inputSchema: { type: "object", properties: {} }, run: () => git(["diff", "HEAD", "--", ".", ":!*.env*", ":!*.pem", ":!*.key"]) },
};

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function fail(id, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n"); }

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (method === "initialize") return reply(id, { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "companion-readonly", version: "0.0.1" } });
    if (method === "tools/list") return reply(id, { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true } })) });
    if (method === "tools/call") {
      const t = tools[params?.name];
      if (!t) return fail(id, "unknown tool");
      try { return reply(id, { content: [{ type: "text", text: String(t.run(params.arguments || {})) }] }); }
      catch (e) { return reply(id, { content: [{ type: "text", text: "Error: " + e.message }], isError: true }); }
    }
    if (id !== undefined) fail(id, "method not found");
  });
}
