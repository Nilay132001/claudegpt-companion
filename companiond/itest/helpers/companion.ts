// Shared setup for the real-Codex itests. Never imported by src/ or test/.
import os from "node:os";
import path from "node:path";
import { appPaths, ensureAppDirs, type AppPaths } from "../../src/app/appPaths.ts";
import type { AppServer } from "./appServer.ts";
import { tempDir } from "../../test/helpers/fixtures.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function skipUnless(o: { live: boolean }): string | false {
  if (process.platform !== "darwin") return "macOS only";
  if (process.env.COMPANION_ITEST !== "1") return "set COMPANION_ITEST=1";
  if (o.live && process.env.COMPANION_ITEST_LIVE !== "1") return "set COMPANION_ITEST_LIVE=1 (uses the companion's signed-in CODEX_HOME)";
  return false;
}

/** A fresh, never signed-in App Support layout with a short path (the relay socket path must stay under 104 bytes). */
export function freshPaths(): AppPaths {
  const s = path.join(tempDir("cgc-"), "s");
  return ensureAppDirs({ supportDir: s, codexHome: path.join(s, "codex-home"), emptyCwd: path.join(s, "empty-cwd"), dbPath: path.join(s, "companion.db") });
}

/** The companion's own App Support, signed in by the owner. Tests never read its credentials. */
export const ownPaths = (): AppPaths => ensureAppDirs(appPaths(os.homedir()));

/** account/read without a refresh; only the account type is kept. */
export async function isSignedIn(a: AppServer): Promise<boolean> {
  const r: any = await a.rpc.request("account/read", { refreshToken: false });
  return r?.account?.type === "chatgpt";
}
