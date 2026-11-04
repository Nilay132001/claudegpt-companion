// Sign in to the companion's own CODEX_HOME with ChatGPT (spec §5). Opens the browser; prints nothing secret.
// Usage: cd companiond && node scripts/codex-login.ts            (sandboxed when CODEX_SEATBELT_MEASURED is "ok")
//        node scripts/codex-login.ts --unsandboxed              (only to sign in before Task 6 measures)
import { execFileSync } from "node:child_process";
import os from "node:os";
import { appPaths, ensureAppDirs } from "../src/app/appPaths.ts";
import { findCodex } from "../src/codex/codexInstall.ts";
import { buildCodexLaunch, CODEX_SEATBELT_MEASURED } from "../src/codex/codexSeatbelt.ts";
import { buildCodexConfigToml, writeCodexConfig } from "../src/codex/config.ts";
import { startAppServer } from "../itest/helpers/appServer.ts";

const paths = ensureAppDirs(appPaths(os.homedir()));
writeCodexConfig(paths.codexHome, buildCodexConfigToml());
const sandboxed = !process.argv.includes("--unsandboxed") && CODEX_SEATBELT_MEASURED === "ok";
const a = await startAppServer(buildCodexLaunch({ install: findCodex(), paths, sandboxed }));
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
console.log(JSON.stringify({ sandboxed }));
a.kill();
