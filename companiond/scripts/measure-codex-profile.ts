// Dev tool (macOS, real Codex 0.166.0, the companion's own CODEX_HOME — sign in first with scripts/codex-login.ts).
// Runs app-server under each profile variant and prints a JSON verdict. Prints no tokens, no message bodies.
// It never refreshes or rotates the Codex token itself: the network check is one short turn.
// Usage: cd companiond && node scripts/measure-codex-profile.ts
//        node scripts/measure-codex-profile.ts --no-login   (fresh, never signed-in CODEX_HOME in a temp dir;
//        keychain and network are skipped, so STOP condition 1 stays unmeasured)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appPaths, ensureAppDirs, type AppPaths } from "../src/app/appPaths.ts";
import { findCodex } from "../src/codex/codexInstall.ts";
import { buildCodexLaunch, DEFAULT_CODEX_PROFILE_OPTIONS, type CodexProfileOptions } from "../src/codex/codexSeatbelt.ts";
import { buildCodexConfigToml, writeCodexConfig } from "../src/codex/config.ts";
import { SANDBOX_EXEC, DEFAULT_PROFILE_OPTIONS, buildReadonlyLaunch, buildReadonlyProfile, profileEnv } from "../src/launch/seatbelt.ts";
import { discoverToolchain } from "../src/launch/toolchain.ts";
import { TOOL_NAMES } from "../src/jail/mcpServer.ts";
import { startAppServer, threadTools, type AppServer } from "../itest/helpers/appServer.ts";
import { makeRepo, removeTempDirs, tempDir } from "../test/helpers/fixtures.ts";

const noLogin = process.argv.includes("--no-login");
const NO_LOGIN = "skipped: not signed in (fresh CODEX_HOME, needs owner login)";
const install = findCodex();
const supportBase: AppPaths = noLogin
  ? (() => {
      const d = path.join(tempDir("cgc-codex-measure-"), "support");
      return { supportDir: d, codexHome: path.join(d, "codex-home"), emptyCwd: path.join(d, "empty-cwd"), dbPath: path.join(d, "companion.db") };
    })()
  : appPaths(os.homedir());
const paths = ensureAppDirs(supportBase);
const tc = discoverToolchain(); // tc.codeDir is the companiond root, so it covers itest/fixtures and src/
const fake = fs.realpathSync.native(fileURLToPath(new URL("../itest/fixtures/fakeMcp.ts", import.meta.url)));
const repoDir = fs.realpathSync.native(makeRepo());

writeCodexConfig(paths.codexHome, buildCodexConfigToml() + [
  "[mcp_servers.fake]", 'command = "/usr/bin/false"', "args = []", 'enabled_tools = ["whereami"]', "",
].join("\n"));

// The jail's own profile (M2), with the fixture repo as root: the same rules the real jail gets.
const innerProfile = buildReadonlyProfile({
  root: repoDir, gitDir: path.join(repoDir, ".git"), commonDir: path.join(repoDir, ".git"), codeDir: tc.codeDir,
  nodePath: tc.nodePath, nodeReadDirs: tc.nodeReadDirs, nodeReadFiles: tc.nodeReadFiles, metadataPaths: tc.metadataPaths,
  gitPath: tc.gitPath, developerDir: tc.developerDir, options: DEFAULT_PROFILE_OPTIONS,
});
// The env buildReadonlyLaunch gives the jail (OPENSSL_CONF=/dev/null): without it Node exits under the jail
// profile on its own, Codex profile or not, and nestedSandbox/rootProbe would measure nothing. Likewise the
// jailed children get cwd = the root (LaunchSpec.cwd): the jail profile cannot read Codex's thread cwd.
const innerEnv = profileEnv(DEFAULT_PROFILE_OPTIONS);

const ok = (b: boolean, why: string) => (b ? "ok" : `blocked: ${why}`);
const errText = (e: unknown) => (typeof e === "string" ? e : JSON.stringify(e)).replaceAll(os.homedir(), "~").slice(0, 300);
async function step(f: () => Promise<string>): Promise<string> {
  try {
    return await f();
  } catch (e) {
    return `blocked: ${(e as Error).name}`;
  }
}
async function startThread(a: AppServer, config?: Record<string, unknown>): Promise<string> {
  const t: any = await a.rpc.request("thread/start", { cwd: paths.emptyCwd, sandbox: "read-only", approvalPolicy: "untrusted", ephemeral: true, ...(config ? { config } : {}) });
  return t.thread.id as string;
}
async function bound(a: AppServer, config: Record<string, unknown>, server: string, want: string[]): Promise<string> {
  const s = await threadTools(a, await startThread(a, config), server);
  if (s.error) return `blocked: toolsError: ${errText(s.error)}`;
  return ok(want.every((w) => s.tools.includes(w)), `tools=${s.tools.length}`);
}
// Proves the nested child can read the root and run git (tools/list alone proves neither).
async function rootProbe(a: AppServer): Promise<string> {
  const config = {
    "mcp_servers.fake.command": SANDBOX_EXEC,
    "mcp_servers.fake.args": ["-p", innerProfile, tc.nodePath, fake, repoDir],
    "mcp_servers.fake.env": { FAKE_ROOT: repoDir, FAKE_GIT: tc.gitPath, FAKE_PROBE: "1", PATH: "/usr/bin:/bin", ...innerEnv },
    "mcp_servers.fake.cwd": repoDir,
  };
  const s = await threadTools(a, await startThread(a, config), "fake");
  if (s.error) return `blocked: toolsError: ${errText(s.error)}`;
  const p = (JSON.parse(String(s.serverInfo?.version ?? "{}")) as { probe?: { readRoot: boolean; git: boolean } | null }).probe;
  return ok(p?.readRoot === true && p?.git === true, `probe=${JSON.stringify(p ?? null)}`);
}
// Network + auth without touching the token: one short turn. Only the status is kept, never the reply.
async function oneTurn(a: AppServer): Promise<string> {
  const threadId = await startThread(a);
  const n0 = a.notifications.length;
  await a.rpc.request("turn/start", { threadId, input: [{ type: "text", text: "Reply with the single word OK.", text_elements: [] }] });
  for (let i = 0; i < 240; i++) {
    const done = a.notifications.slice(n0).find((n) => n.method === "turn/completed" && n.params?.threadId === threadId);
    if (done) return ok(done.params?.turn?.status === "completed", `turn ${String(done.params?.turn?.status)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return "blocked: no turn/completed in 120 s";
}

async function measure(options: CodexProfileOptions): Promise<Record<string, string>> {
  const r: Record<string, string> = {};
  let a: AppServer | null = null;
  r.initialize = await step(async () => {
    a = await startAppServer(buildCodexLaunch({ install, paths, sandboxed: true, options }));
    return "ok";
  });
  const s = a as AppServer | null;
  if (!s) return r;
  r.configRead = await step(async () => ok(!!(await s.rpc.request<any>("config/read", { includeLayers: true, cwd: paths.emptyCwd }))?.config, "no config"));
  if (noLogin) {
    // Never signed in: do not ask Codex for the account, so nothing looks up a Keychain item.
    r.keychain = NO_LOGIN;
    r.network = NO_LOGIN;
  } else {
    r.keychain = await step(async () => ok((await s.rpc.request<any>("account/read", { refreshToken: false }))?.account?.type === "chatgpt", "not signed in or no Keychain access"));
    r.network = r.keychain === "ok" ? await step(() => oneTurn(s)) : "skipped: keychain blocked";
  }
  r.mcpChild = await step(() => bound(s, { "mcp_servers.fake.command": tc.nodePath, "mcp_servers.fake.args": [fake, "A"], "mcp_servers.fake.env": { FAKE_ROOT: "A" } }, "fake", ["whereami"]));
  r.nestedSandbox = await step(() => bound(s, { "mcp_servers.fake.command": SANDBOX_EXEC, "mcp_servers.fake.args": ["-p", innerProfile, tc.nodePath, fake, "A"], "mcp_servers.fake.env": { FAKE_ROOT: "A", ...innerEnv }, "mcp_servers.fake.cwd": repoDir }, "fake", ["whereami"]));
  r.rootProbe = await step(() => rootProbe(s));
  // Proves only that the jail starts: it answers tools/list with all five tools even when it refused the root.
  r.jailChild = await step(async () => {
    const l = await buildReadonlyLaunch({ root: repoDir });
    return bound(s, { "mcp_servers.companion-readonly.command": l.command, "mcp_servers.companion-readonly.args": l.args, "mcp_servers.companion-readonly.env": l.env, "mcp_servers.companion-readonly.cwd": l.cwd }, "companion-readonly", [...TOOL_NAMES]);
  });
  s.kill();
  return r;
}

const variants: Record<string, CodexProfileOptions> = {
  strict: DEFAULT_CODEX_PROFILE_OPTIONS,
  keychainReads: { ...DEFAULT_CODEX_PROFILE_OPTIONS, keychainFileReads: true },
  metadata: { ...DEFAULT_CODEX_PROFILE_OPTIONS, metadataEverywhere: true },
  both: { ...DEFAULT_CODEX_PROFILE_OPTIONS, keychainFileReads: true, metadataEverywhere: true },
  // MEASUREMENT ONLY — never a default. Gives the children what they need, so nestedSandbox here
  // shows whether macOS refuses a nested sandbox-exec, not whether a read was missing.
  childReads: {
    ...DEFAULT_CODEX_PROFILE_OPTIONS,
    metadataEverywhere: true,
    extraExec: [tc.nodePath, tc.gitPath],
    extraReads: [...tc.nodeReadDirs, ...tc.nodeReadFiles, ...(tc.developerDir ? [tc.developerDir] : []), tc.codeDir, repoDir, path.dirname(fake)],
  },
};
const out: Record<string, Record<string, string>> = {};
for (const [name, o] of Object.entries(variants)) out[name] = await measure(o);
const PASS_KEYS = ["initialize", "configRead", "keychain", "network", "mcpChild", "nestedSandbox", "rootProbe", "jailChild"];
const passing = ["strict", "keychainReads"].find((v) => PASS_KEYS.every((k) => out[v]?.[k] === "ok")) ?? null;
console.log(JSON.stringify({
  codex: install.version,
  signedIn: noLogin ? false : "as found",
  results: out,
  nestingUnderChildReads: { mcpChild: out.childReads?.mcpChild ?? "not run", nestedSandbox: out.childReads?.nestedSandbox ?? "not run", rootProbe: out.childReads?.rootProbe ?? "not run" },
  verdict: passing ? `pass: ${passing}` : "STOP: report to the owner",
}, null, 2));
removeTempDirs();
