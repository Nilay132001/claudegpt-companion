import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CODEX = path.join(HERE, "node_modules/.bin/codex");
export const CODEX_HOME = path.join(os.homedir(), "Library/Application Support/ClaudeGPTCompanion/poc-codex-home");
const TMP = path.join(HERE, ".tmp");

export function tmpDir(prefix) {
  fs.mkdirSync(TMP, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(TMP, prefix + "-")));
}

export function writeConfig(toml) {
  fs.mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(CODEX_HOME, "config.toml"), toml, { mode: 0o600 });
}

export const HARDENED_FEATURES = `
cli_auth_credentials_store = "keyring"
web_search = "disabled"

[features]
shell_tool = false
unified_exec = false
apps = false
plugins = false
browser_use = false
computer_use = false
image_generation = false
multi_agent = false
hooks = false
memories = false
view_image = false
`;

export async function connect({ onServerRequest } = {}) {
  const child = spawn(CODEX, ["app-server"], { env: { ...process.env, CODEX_HOME }, stdio: ["pipe", "pipe", "inherit"] });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  const notifications = [];
  const serverRequests = [];
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method) {
      const entry = { method: m.method, params: m.params, reply: null };
      serverRequests.push(entry);
      const r = onServerRequest ? onServerRequest(m.method, m.params) : { error: { code: -32000, message: "not permitted" } };
      entry.reply = r;
      return send({ id: m.id, ...r });
    }
    if (m.id !== undefined) {
      const p = pending.get(m.id); pending.delete(m.id);
      return m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
    notifications.push(m);
    for (const l of listeners) l(m);
  });
  const request = (method, params) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); send({ id, method, params }); });
  const waitFor = (method, pred = () => true) => new Promise((res) => {
    const l = (m) => { if (m.method === method && pred(m.params)) { listeners.delete(l); res(m.params); } };
    listeners.add(l);
  });
  await request("initialize", { clientInfo: { name: "claudegpt_companion_spike", title: "ClaudeGPT Companion spike", version: "0.0.1" }, capabilities: null });
  send({ method: "initialized" });
  return { request, waitFor, notifications, serverRequests, close: () => child.kill() };
}

export async function runTurn(c, threadId, text) {
  let out = "";
  const items = [];
  const before = c.notifications.length;
  const done = c.waitFor("turn/completed", (p) => p.threadId === threadId);
  await c.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
  const r = await done;
  for (const m of c.notifications.slice(before)) {
    if (m.params?.threadId !== threadId) continue;
    if (m.method === "item/agentMessage/delta") out += m.params.delta;
    if (m.method === "item/started") {
      const it = m.params.item;
      items.push(it.type + (it.type === "mcpToolCall" ? `:${it.server}/${it.tool}` : ""));
    }
  }
  return { text: out, items, status: r.turn?.status };
}
