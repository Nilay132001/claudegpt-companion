// Sign in to the companion's own CODEX_HOME with ChatGPT (spec §5). Owner-only tool: no plan step runs it.
// Runs a short-lived Codex under the SIGN-IN profile: the production profile plus the callback port (ruling I-9).
// Codex runs unsandboxed only with an explicit --unsandboxed. Opens the browser; prints nothing secret.
// Usage: cd companiond && node scripts/codex-login.ts [--unsandboxed]
import { execFileSync } from "node:child_process";
import os from "node:os";
import { appPaths, ensureAppDirs } from "../src/app/appPaths.ts";
import { findCodex } from "../src/codex/codexInstall.ts";
import { buildCodexLaunch } from "../src/codex/codexSeatbelt.ts";
import { buildCodexConfigToml, writeCodexConfig } from "../src/codex/config.ts";
import { ensureRelayDirs, relayPaths } from "../src/relay/relayPaths.ts";
import { startAppServer } from "../itest/helpers/appServer.ts";

const unsandboxed = process.argv.includes("--unsandboxed");
const paths = ensureAppDirs(appPaths(os.homedir()));
const install = findCodex();
const rp = ensureRelayDirs(relayPaths(paths.supportDir));
writeCodexConfig(paths.codexHome, buildCodexConfigToml()); // companiond rewrites it (code mode) at its next start
const a = await startAppServer(buildCodexLaunch({ install, paths, sandboxed: !unsandboxed, login: true, relay: { binary: rp.binary, socket: rp.socket } }));
const acct: any = await a.rpc.request("account/read", { refreshToken: false });
if (acct?.account?.type === "chatgpt") {
  console.log("Already signed in.");
} else {
  const done = new Promise<any>((res) => a.rpc.onNotification((m, p) => { if (m === "account/login/completed") res(p); }));
  const r: any = await a.rpc.request("account/login/start", { type: "chatgpt" });
  if (typeof r?.authUrl !== "string" || !r.authUrl.startsWith("https://")) throw new Error("no https sign-in link");
  execFileSync("/usr/bin/open", [r.authUrl]);
  const c = await done;
  console.log(c?.success ? "Signed in." : "Sign-in failed.");
}
console.log(JSON.stringify({ sandboxed: !unsandboxed }));
a.kill();
